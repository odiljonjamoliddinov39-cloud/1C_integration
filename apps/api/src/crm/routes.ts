/**
 * The CRM's HTTP API (/v1/crm). Two ways in: the admin dashboard's token (`Bearer`) and the Mini App, which proves who it is with
 * Telegram's signed initData (`Authorization: tma <initData>`, checked with the CRM bot's token) and trades it for a session
 * token of its own. A person must have been linked to their Telegram account by an owner first.
 */
import {
  CrmCallInput,
  CrmImportFileInput,
  CrmImportSheetInput,
  CrmLeadInput,
  CrmLeadUpdate,
  CrmLeadsQuery,
  CrmNoteInput,
  CrmReportQuery,
  CrmStageInput,
  CrmStageMoveInput,
  CrmStageOrderInput,
  CrmStageUpdate,
  type CrmMe,
} from "@platform/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AdminIdentity, AdminService } from "../admin/service.js";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { admins } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import type { Tokens } from "../lib/tokens.js";
import { verifyInitData } from "../remote/telegram.js";
import { type Lang, langOf, leadsWorkbook, reportWorkbook } from "./export.js";
import { readGoogleSheet } from "./google-sheets.js";
import type { CrmImport } from "./import.js";
import type { CrmReports } from "./reports.js";
import { type Crm, type CrmActor, seesAll } from "./service.js";
import { XLSX_TYPE, readSheetFile } from "./xlsx.js";
import { eq } from "drizzle-orm";

export interface CrmRouteDeps {
  db: Db;
  config: Config;
  tokens: Tokens;
  admin: AdminService;
  crm: Crm;
  imports: CrmImport;
  reports: CrmReports;
  fetch?: typeof fetch;
}

/** The service account's e-mail, which customers share their sheets with; null when Google is not set up. */
function serviceEmailOf(json: string | undefined): string | null {
  try {
    return (JSON.parse(json ?? "null") as { client_email?: string } | null)?.client_email ?? null;
  } catch {
    return null;
  }
}

const idParam = z.object({ id: z.uuid() });
/** An .xlsx a person can upload: about 5 MB as a file, 7 MB as base64 in JSON. */
const IMPORT_BODY_LIMIT = 8 * 1024 * 1024;

export function registerCrmRoutes(app: FastifyInstance, deps: CrmRouteDeps): void {
  const { db, config, tokens, admin, crm, imports, reports } = deps;

  const actorOf = (who: AdminIdentity): CrmActor => {
    if (who.mustChangePassword)
      throw new HttpError(403, "PASSWORD_CHANGE_REQUIRED", "Change your one-time password first");
    return { id: who.id, role: who.role };
  };

  /** Who is calling: an admin token, a Mini App session, or Telegram's initData itself. */
  async function identify(req: FastifyRequest): Promise<AdminIdentity> {
    const header = req.headers.authorization ?? "";
    let who: AdminIdentity | null = null;
    if (header.startsWith("Bearer ")) {
      const token = header.slice(7);
      who = (await admin.identify(token)) ?? (await admin.identifyCrm(token));
    } else if (header.startsWith("tma ")) {
      if (!config.CRM_BOT_TOKEN)
        throw new HttpError(503, "TELEGRAM_OFF", "The CRM bot is not set up on this server");
      const caller = verifyInitData(header.slice(4), config.CRM_BOT_TOKEN);
      who = await admin.identifyTelegram(caller.id);
      if (!who)
        throw new HttpError(
          403,
          "NOT_LINKED",
          "This Telegram account is not linked to anyone: ask the owner to add your Telegram ID",
        );
    }
    if (!who) throw new HttpError(401, "UNAUTHORIZED", "Sign in again");
    return who;
  }
  const auth = async (req: FastifyRequest) => actorOf(await identify(req));

  const strict = { config: { rateLimit: { max: config.AUTH_RATE_PER_MINUTE, timeWindow: "1 minute" } } };

  // The Mini App's sign-in: Telegram's initData in, a session token out.
  app.post("/v1/crm/session", strict, async (req) => {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("tma ")) throw new HttpError(401, "UNAUTHORIZED", "Open the app from Telegram");
    const who = await identify(req);
    const actor = actorOf(who);
    const { token, expiresIn } = await tokens.crmToken(actor.id);
    return { accessToken: token, expiresIn, me: await meOf(actor) };
  });

  async function meOf(actor: CrmActor): Promise<CrmMe> {
    const row = await db.query.admins.findFirst({ where: eq(admins.id, actor.id) });
    return { id: actor.id, name: row?.name ?? "", role: actor.role, seesAll: seesAll(actor) };
  }
  app.get("/v1/crm/me", async (req) => meOf(await auth(req)));

  // The funnel and its stages (owner and support shape them).
  app.get("/v1/crm/funnel", async (req) => crm.funnel(await auth(req)));
  app.post("/v1/crm/stages", async (req) => crm.addStage(await auth(req), CrmStageInput.parse(req.body)));
  app.put("/v1/crm/stages/order", async (req) =>
    crm.reorderStages(await auth(req), CrmStageOrderInput.parse(req.body).ids),
  );
  app.patch("/v1/crm/stages/:id", async (req) =>
    crm.updateStage(await auth(req), idParam.parse(req.params).id, CrmStageUpdate.parse(req.body)),
  );
  app.delete("/v1/crm/stages/:id", async (req) =>
    crm.deleteStage(
      await auth(req),
      idParam.parse(req.params).id,
      z.object({ moveTo: z.uuid().optional() }).parse(req.query).moveTo,
    ),
  );

  // Leads.
  app.get("/v1/crm/leads", async (req) => crm.listLeads(await auth(req), CrmLeadsQuery.parse(req.query)));
  app.get("/v1/crm/leads/export.xlsx", async (req, reply) => {
    const actor = await auth(req);
    const query = CrmLeadsQuery.parse(req.query);
    const lang: Lang = langOf((req.query as { lang?: string }).lang);
    const leads = await crm.exportLeads(actor, query);
    return reply
      .header("content-type", XLSX_TYPE)
      .header("content-disposition", 'attachment; filename="leads.xlsx"')
      .header("cache-control", "no-store")
      .send(Buffer.from(leadsWorkbook(lang, leads)));
  });
  app.post("/v1/crm/leads", async (req, reply) => {
    const saved = await crm.createLead(await auth(req), CrmLeadInput.parse(req.body));
    return reply.status(saved.created ? 201 : 200).send(saved);
  });
  app.get("/v1/crm/leads/:id", async (req) => crm.lead(await auth(req), idParam.parse(req.params).id));
  app.patch("/v1/crm/leads/:id", async (req) =>
    crm.updateLead(await auth(req), idParam.parse(req.params).id, CrmLeadUpdate.parse(req.body)),
  );
  app.post("/v1/crm/leads/:id/stage", async (req) =>
    crm.moveLead(await auth(req), idParam.parse(req.params).id, CrmStageMoveInput.parse(req.body).stageId),
  );
  app.post("/v1/crm/leads/:id/notes", async (req, reply) =>
    reply
      .status(201)
      .send(
        await crm.addNote(await auth(req), idParam.parse(req.params).id, CrmNoteInput.parse(req.body).text),
      ),
  );
  app.post("/v1/crm/leads/:id/calls", async (req, reply) =>
    reply
      .status(201)
      .send(await crm.addCall(await auth(req), idParam.parse(req.params).id, CrmCallInput.parse(req.body))),
  );

  app.get("/v1/crm/team", async (req) => crm.team(await auth(req)));
  app.get("/v1/crm/sources", async (req) => crm.sources(await auth(req)));

  // Import: an .xlsx (base64 in JSON) or a Google Sheet's link.
  app.get("/v1/crm/import/jobs", async (req) => imports.jobs(await auth(req)));
  app.post("/v1/crm/import/file", { bodyLimit: IMPORT_BODY_LIMIT }, async (req) => {
    const actor = await auth(req);
    const input = CrmImportFileInput.parse(req.body);
    const rows = readSheetFile(Buffer.from(input.dataBase64, "base64"));
    const job = await imports.run(actor, "excel", input.fileName, rows);
    await crm.audit(actor, "crm.import", `crm-import:${job.id}`, { source: "excel", rows: job.rowsTotal });
    return job;
  });
  app.post("/v1/crm/import/sheet", async (req) => {
    const actor = await auth(req);
    const input = CrmImportSheetInput.parse(req.body);
    const sheet = await readGoogleSheet(input.url, config.GOOGLE_SERVICE_ACCOUNT_JSON, deps.fetch);
    const job = await imports.run(actor, "google_sheet", sheet.title, sheet.rows);
    await crm.audit(actor, "crm.import", `crm-import:${job.id}`, {
      source: "google_sheet",
      rows: job.rowsTotal,
    });
    return job;
  });
  /** The address a customer shares their sheet with. */
  app.get("/v1/crm/import/google", async (req) => {
    await auth(req);
    const email = serviceEmailOf(config.GOOGLE_SERVICE_ACCOUNT_JSON);
    return { enabled: email !== null, serviceEmail: email };
  });

  // Reports.
  app.get("/v1/crm/reports", async (req) => reports.report(await auth(req), CrmReportQuery.parse(req.query)));
  app.get("/v1/crm/reports/export.xlsx", async (req, reply) => {
    const actor = await auth(req);
    const lang = langOf((req.query as { lang?: string }).lang);
    const data = await reports.report(actor, CrmReportQuery.parse(req.query));
    return reply
      .header("content-type", XLSX_TYPE)
      .header("content-disposition", 'attachment; filename="crm-report.xlsx"')
      .header("cache-control", "no-store")
      .send(Buffer.from(reportWorkbook(lang, data)));
  });
}
