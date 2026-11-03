/**
 * The CRM's HTTP API (/v1/crm). Two ways in, both with `Authorization: Bearer`: the admin dashboard's token, and a CRM session
 * token, which the Mini App gets by signing in with the person's own email and password (`POST /v1/crm/login`). The CRM token
 * opens /v1/crm only.
 */
import {
  AdminLoginInput,
  ChangePasswordInput,
  CrmCallInput,
  CrmCardFieldInput,
  CrmCardFieldUpdate,
  CrmCardOrderInput,
  CrmCardSectionInput,
  CrmCardValuesInput,
  CrmImportFileInput,
  CrmImportSheetInput,
  CrmLeadInput,
  CrmAssignInput,
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
import { type Lang, langOf, leadsWorkbook, reportWorkbook } from "./export.js";
import { readGoogleSheet } from "./google-sheets.js";
import type { CrmImport } from "./import.js";
import type { CrmCard } from "./card.js";
import type { CrmReports } from "./reports.js";
import { type Crm, type CrmActor, seesAll } from "./service.js";
import { XLSX_TYPE, readSheetFile } from "./xlsx.js";
import { eq } from "drizzle-orm";

export interface CrmRouteDeps {
  db: Db;
  config: Config;
  admin: AdminService;
  crm: Crm;
  imports: CrmImport;
  reports: CrmReports;
  card: CrmCard;
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
  const { db, config, admin, crm, imports, reports, card } = deps;

  const actorOf = (who: AdminIdentity): CrmActor => {
    if (who.mustChangePassword)
      throw new HttpError(403, "PASSWORD_CHANGE_REQUIRED", "Change your one-time password first");
    return { id: who.id, role: who.role };
  };

  /** Who is calling: an admin's token or a CRM session token. */
  async function identify(req: FastifyRequest): Promise<AdminIdentity> {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const who = token ? ((await admin.identify(token)) ?? (await admin.identifyCrm(token))) : null;
    if (!who) throw new HttpError(401, "UNAUTHORIZED", "Sign in again");
    return who;
  }
  const auth = async (req: FastifyRequest) => actorOf(await identify(req));

  const strict = { config: { rateLimit: { max: config.AUTH_RATE_PER_MINUTE, timeWindow: "1 minute" } } };

  // The Mini App's sign-in and the change of a one-time password (the only call that works until it is changed).
  app.post("/v1/crm/login", strict, async (req) => {
    const { email, password } = AdminLoginInput.parse(req.body);
    return admin.loginCrm(email, password);
  });
  app.post("/v1/crm/password", strict, async (req) =>
    admin.changePassword((await identify(req)).id, ChangePasswordInput.parse(req.body)),
  );

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
  app.post("/v1/crm/leads/assign", async (req) =>
    crm.assignLeads(await auth(req), CrmAssignInput.parse(req.body)),
  );
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

  // The client card: the layout (sections and fields) is shaped by owner and support, the values are filled in per lead.
  app.get("/v1/crm/card", async (req) => {
    await auth(req);
    return card.layout();
  });
  app.post("/v1/crm/card/sections", async (req) =>
    card.addSection(await auth(req), CrmCardSectionInput.parse(req.body).name),
  );
  app.put("/v1/crm/card/sections/order", async (req) =>
    card.reorderSections(await auth(req), CrmCardOrderInput.parse(req.body).ids),
  );
  app.patch("/v1/crm/card/sections/:id", async (req) =>
    card.renameSection(
      await auth(req),
      idParam.parse(req.params).id,
      CrmCardSectionInput.parse(req.body).name,
    ),
  );
  app.delete("/v1/crm/card/sections/:id", async (req) =>
    card.deleteSection(await auth(req), idParam.parse(req.params).id),
  );
  app.post("/v1/crm/card/fields", async (req) =>
    card.addField(await auth(req), CrmCardFieldInput.parse(req.body)),
  );
  app.put("/v1/crm/card/sections/:id/fields/order", async (req) =>
    card.reorderFields(await auth(req), idParam.parse(req.params).id, CrmCardOrderInput.parse(req.body).ids),
  );
  app.patch("/v1/crm/card/fields/:id", async (req) =>
    card.updateField(await auth(req), idParam.parse(req.params).id, CrmCardFieldUpdate.parse(req.body)),
  );
  app.delete("/v1/crm/card/fields/:id", async (req) =>
    card.deleteField(await auth(req), idParam.parse(req.params).id),
  );
  app.put("/v1/crm/leads/:id/values", async (req) =>
    card.saveValues(await auth(req), idParam.parse(req.params).id, CrmCardValuesInput.parse(req.body).values),
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
