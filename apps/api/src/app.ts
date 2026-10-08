import { existsSync } from "node:fs";
import { createGunzip } from "node:zlib";

import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import {
  AccountsQuery,
  ActivateDeviceInput,
  AdminLoginInput,
  CreateAdminInput,
  ExtendInput,
  RechargeInput,
  AccountAiInput,
  AccountBudgetInput,
  AiPolicySaveInput,
  AiSettingsInput,
  AiChatInput,
  AnswerKey,
  AnswerStoreInput,
  DigestInput,
  DigestKey,
  FreeAnswerInput,
  QueryTemplateInput,
  TemplateRejectInput,
  TraceInput,
  type AiEvent,
  LicenseCheckInput,
  LoginInput,
  RefreshInput,
  RegisterInput,
} from "@platform/shared";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError, z } from "zod";

import { type AiModel, claudeModel } from "./ai/model.js";
import { type AdminIdentity, AdminService } from "./admin/service.js";
import { lookupAnswer, storeAnswer } from "./ai/cache.js";
import { findDigest, saveDigest } from "./ai/digest.js";
import { policyFor } from "./ai/policy.js";
import { AiProxy, assertInlineFiles } from "./ai/proxy.js";
import { Reasoner } from "./ai/reasoner.js";
import { rejectLearned, templatesForAccount } from "./ai/templates.js";
import { storeTrace } from "./ai/traces.js";
import { logFreeAnswer } from "./ai/usage.js";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { HttpError } from "./lib/errors.js";
import { Tokens } from "./lib/tokens.js";
import { Service } from "./service.js";

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value);
}

export interface AppDeps {
  /** Replaces the Claude API in tests. */
  aiModel?: AiModel;
  /** How soon after a question the engine reasons about it (tests make it short). */
  reasonDelayMs?: number;
  /** The built admin dashboard (apps/admin/dist), served at /admin/ when present. */
  adminUiDir?: string;
}

/** How often a running assistant step tells the app it is alive. */
const PING_MS = 15_000;

export async function buildApp(db: Db, config: Config, deps: AppDeps = {}) {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ["req.headers.authorization"] },
    trustProxy: true, // behind Caddy
    bodyLimit: 64 * 1024,
  });
  const tokens = new Tokens(config);
  const service = new Service(db, tokens, config);
  const aiModel = deps.aiModel ?? (config.ANTHROPIC_API_KEY ? claudeModel(config.ANTHROPIC_API_KEY) : null);
  const ai = new AiProxy(db, service, config, aiModel, app.log);
  const reasoner = new Reasoner(db, aiModel, app.log, deps.reasonDelayMs);
  const admin = new AdminService(db, tokens, config);
  await admin.bootstrap(app.log);

  // The desktop calls from its main process; the website (via Vercel) and the admin dashboard
  // (served below) reach the API from their own origin, so no cross-origin requests are allowed.
  await app.register(cors, { origin: false });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof HttpError)
      return reply.status(error.status).send({ code: error.code, message: error.message });
    if (error instanceof ZodError) {
      return reply.status(400).send({
        code: "VALIDATION",
        message: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status === 429)
      return reply.status(429).send({ code: "RATE_LIMITED", message: "Too many requests, try again later" });
    if (status < 500)
      return reply.status(status).send({ code: "BAD_REQUEST", message: (error as Error).message });
    app.log.error(error);
    return reply.status(500).send({ code: "INTERNAL", message: "Unexpected server error" });
  });

  async function auth(req: FastifyRequest): Promise<{ userId: string; accountId: string }> {
    const header = req.headers.authorization ?? "";
    const identity = header.startsWith("Bearer ") ? await tokens.verifyAccess(header.slice(7)) : null;
    if (!identity) throw new HttpError(401, "UNAUTHORIZED", "Sign in again");
    return identity;
  }

  async function adminAuth(req: FastifyRequest): Promise<AdminIdentity> {
    const header = req.headers.authorization ?? "";
    const identity = header.startsWith("Bearer ") ? await admin.identify(header.slice(7)) : null;
    if (!identity) throw new HttpError(401, "UNAUTHORIZED", "Sign in again");
    return identity;
  }

  const strict = { config: { rateLimit: { max: config.AUTH_RATE_PER_MINUTE, timeWindow: "1 minute" } } };

  app.get("/health", async (_req, reply: FastifyReply) => {
    await db.execute(sql`select 1`);
    return reply.send({ ok: true });
  });

  app.post("/v1/auth/register", strict, async (req) => service.register(parse(RegisterInput, req.body)));
  app.post("/v1/auth/login", strict, async (req) => {
    const { email, password } = parse(LoginInput, req.body);
    return service.login(email, password);
  });
  app.post("/v1/auth/refresh", strict, async (req) =>
    service.refresh(parse(RefreshInput, req.body).refreshToken),
  );
  app.post("/v1/auth/logout", async (req, reply) => {
    await service.logout(parse(RefreshInput, req.body).refreshToken);
    return reply.status(204).send();
  });

  app.get("/v1/me", async (req) => service.me((await auth(req)).userId));

  app.post("/v1/devices/activate", async (req) => {
    const { userId } = await auth(req);
    const { machineId, name } = parse(ActivateDeviceInput, req.body);
    return service.activateDevice(userId, machineId, name);
  });
  app.get("/v1/devices", async (req) => service.listDevices((await auth(req)).userId));
  app.post("/v1/devices/:id/revoke", async (req, reply) => {
    const { userId } = await auth(req);
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    await service.revokeDevice(userId, id);
    return reply.status(204).send();
  });
  app.post("/v1/license/check", async (req) => {
    const { userId } = await auth(req);
    return service.checkLicense(userId, parse(LicenseCheckInput, req.body).machineId);
  });
  app.get("/v1/license/public-key", async () => ({ publicKey: await tokens.publicKey() }));

  // One model turn of the assistant. The answer streams as newline-delimited JSON (AiEvent).
  app.post(
    "/v1/ai/chat",
    // The whole chat comes every turn, with the files attached to it (the app keeps it under 24 MB;
    // the AI service takes at most 32 MB).
    // One question can take many quick steps, and an office's PCs share one address: 120 a minute
    // under the plans' limits; without them, only a ceiling against runaway clients.
    {
      bodyLimit: 30 * 1024 * 1024,
      config: { rateLimit: { max: config.PLAN_LIMITS === "on" ? 120 : 1000, timeWindow: "1 minute" } },
      // The app gzips the chat (1C rows and text shrink several times): less to upload every step.
      preParsing: async (req, _reply, payload) => {
        if (req.headers["content-encoding"] !== "gzip") return payload;
        const gunzip = createGunzip() as ReturnType<typeof createGunzip> & { receivedEncodedLength: number };
        gunzip.receivedEncodedLength = 0;
        payload.on("data", (chunk: Buffer) => (gunzip.receivedEncodedLength += chunk.length));
        return payload.pipe(gunzip);
      },
    },
    async (req, reply) => {
      const who = await auth(req);
      const input = parse(AiChatInput, req.body);
      assertInlineFiles(input);
      const admission = await ai.ensureAllowed(who.accountId, who.userId);

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      });
      const aborted = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableEnded) aborted.abort();
      });
      const send = (event: AiEvent) => {
        if (!reply.raw.writableEnded) reply.raw.write(`${JSON.stringify(event)}\n`);
      };
      // A long step (a card for a whole statement) can stream nothing for minutes; a ping keeps
      // proxies and the app from taking the quiet connection for a dead one.
      const heartbeat = setInterval(() => send({ type: "ping" }), PING_MS);
      try {
        await ai.turn(who, input, send, aborted.signal, admission);
      } finally {
        clearInterval(heartbeat);
        reply.raw.end();
      }
    },
  );

  // The cost engine's helpers for the app: the limits it runs under, the answers it can give
  // without the model (templates, cache), the company's structure, and the count of free answers.
  const policyOf = async (accountId: string) =>
    policyFor(db, (await service.currentSubscription(accountId)).plan.id);
  app.get("/v1/ai/policy", async (req) => policyOf((await auth(req)).accountId));
  app.get("/v1/ai/templates", async (req) => {
    const { accountId } = await auth(req);
    const policy = await policyOf(accountId);
    return policy.templates ? templatesForAccount(db, accountId) : [];
  });
  // What was done for a finished question (steps, no data): the engine learns from it.
  app.post("/v1/ai/traces", async (req, reply) => {
    const who = await auth(req);
    const policy = await policyOf(who.accountId);
    if (policy.learnTemplates) {
      const stored = await storeTrace(db, who, parse(TraceInput, req.body));
      if (stored.learnable) reasoner.schedule(who.accountId, () => policyOf(who.accountId));
    }
    return reply.status(204).send();
  });
  app.post("/v1/ai/templates/reject", async (req, reply) => {
    const { accountId } = await auth(req);
    await rejectLearned(db, accountId, parse(TemplateRejectInput, req.body).code);
    return reply.status(204).send();
  });
  app.post("/v1/ai/answers/lookup", async (req) => {
    const { accountId } = await auth(req);
    return lookupAnswer(db, await policyOf(accountId), accountId, parse(AnswerKey, req.body));
  });
  app.post("/v1/ai/answers", async (req, reply) => {
    const { accountId } = await auth(req);
    await storeAnswer(db, await policyOf(accountId), accountId, parse(AnswerStoreInput, req.body));
    return reply.status(204).send();
  });
  app.post("/v1/ai/free", async (req, reply) => {
    const who = await auth(req);
    await logFreeAnswer(db, who, parse(FreeAnswerInput, req.body));
    return reply.status(204).send();
  });
  app.get("/v1/ai/digest", async (req) => {
    const { accountId } = await auth(req);
    const row = await findDigest(db, accountId, parse(DigestKey, req.query));
    return { found: row !== null, tokenCount: row?.tokenCount ?? 0 };
  });
  app.put("/v1/ai/digest", { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const { accountId } = await auth(req);
    await saveDigest(db, accountId, parse(DigestInput, req.body));
    return reply.status(204).send();
  });

  // --- admin dashboard (TD §8) ---------------------------------------------------------------
  const idParam = z.object({ id: z.uuid() });

  app.post("/v1/admin/login", strict, async (req) => {
    const { email, password } = parse(AdminLoginInput, req.body);
    return admin.login(email, password);
  });
  app.get("/v1/admin/me", async (req) => admin.me((await adminAuth(req)).id));
  app.get("/v1/admin/overview", async (req) => {
    await adminAuth(req);
    return admin.overview();
  });
  app.get("/v1/admin/accounts", async (req) => {
    await adminAuth(req);
    return admin.listAccounts(parse(AccountsQuery, req.query));
  });
  app.get("/v1/admin/accounts/:id", async (req) => {
    await adminAuth(req);
    return admin.account(parse(idParam, req.params).id);
  });
  app.post("/v1/admin/accounts/:id/extend", async (req) =>
    admin.extend(await adminAuth(req), parse(idParam, req.params).id, parse(ExtendInput, req.body)),
  );
  app.post("/v1/admin/accounts/:id/recharge", async (req) =>
    admin.recharge(await adminAuth(req), parse(idParam, req.params).id, parse(RechargeInput, req.body)),
  );
  app.post("/v1/admin/accounts/:id/ai", async (req) =>
    admin.setAccountAi(await adminAuth(req), parse(idParam, req.params).id, parse(AccountAiInput, req.body)),
  );
  app.get("/v1/admin/ai-settings", async (req) => {
    await adminAuth(req);
    return admin.aiSettings();
  });
  app.post("/v1/admin/ai-settings", async (req) =>
    admin.setAiSettings(await adminAuth(req), parse(AiSettingsInput, req.body)),
  );
  app.post("/v1/admin/accounts/:id/ai-budget", async (req) =>
    admin.setAccountBudget(
      await adminAuth(req),
      parse(idParam, req.params).id,
      parse(AccountBudgetInput, req.body),
    ),
  );
  app.get("/v1/admin/ai-policies", async (req) => {
    await adminAuth(req);
    return admin.aiPolicies();
  });
  app.put("/v1/admin/ai-policies", async (req) =>
    admin.saveAiPolicy(await adminAuth(req), parse(AiPolicySaveInput, req.body)),
  );
  app.get("/v1/admin/ai-cost", async (req) => {
    await adminAuth(req);
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }), req.query);
    return admin.costReport(days);
  });
  app.get("/v1/admin/query-templates", async (req) => {
    await adminAuth(req);
    return admin.queryTemplates();
  });
  app.get("/v1/admin/template-groups", async (req) => {
    await adminAuth(req);
    return admin.templateGroups();
  });
  // Runs the engine's reasoning now for every account (it also runs by itself after questions).
  app.post("/v1/admin/engine/run", async (req) => {
    const who = await adminAuth(req);
    if (who.role !== "owner") throw new HttpError(403, "FORBIDDEN", "Only an owner can do this");
    const ids = await db.execute<{ account_id: string }>(sql`select distinct account_id from ai_traces`);
    let decided = 0;
    let made = 0;
    for (const { account_id: accountId } of ids) {
      const result = await reasoner.run(accountId, await policyOf(accountId));
      decided += result.decided;
      made += result.made;
    }
    return { decided, made };
  });
  app.put("/v1/admin/query-templates", async (req) =>
    admin.saveQueryTemplate(await adminAuth(req), parse(QueryTemplateInput, req.body)),
  );
  app.delete("/v1/admin/query-templates/:id", async (req, reply) => {
    await admin.deleteQueryTemplate(await adminAuth(req), parse(idParam, req.params).id);
    return reply.status(204).send();
  });
  app.post("/v1/admin/accounts/:id/block", async (req) =>
    admin.setBlocked(await adminAuth(req), parse(idParam, req.params).id, true),
  );
  app.post("/v1/admin/accounts/:id/unblock", async (req) =>
    admin.setBlocked(await adminAuth(req), parse(idParam, req.params).id, false),
  );
  app.post("/v1/admin/devices/:id/revoke", async (req) =>
    admin.setDeviceRevoked(await adminAuth(req), parse(idParam, req.params).id, true),
  );
  app.post("/v1/admin/devices/:id/restore", async (req) =>
    admin.setDeviceRevoked(await adminAuth(req), parse(idParam, req.params).id, false),
  );
  app.get("/v1/admin/usage", async (req) => {
    await adminAuth(req);
    const { days } = parse(
      z.object({ days: z.coerce.number().int().min(1).max(366).default(30) }),
      req.query,
    );
    return admin.usage(days);
  });
  app.get("/v1/admin/audit", async (req) => {
    await adminAuth(req);
    return admin.auditEntries();
  });
  app.get("/v1/admin/admins", async (req) => admin.listAdmins(await adminAuth(req)));
  app.post("/v1/admin/admins", async (req) =>
    admin.createAdmin(await adminAuth(req), parse(CreateAdminInput, req.body)),
  );
  app.post("/v1/admin/admins/:id/disable", async (req) =>
    admin.setAdminDisabled(await adminAuth(req), parse(idParam, req.params).id, true),
  );
  app.post("/v1/admin/admins/:id/enable", async (req) =>
    admin.setAdminDisabled(await adminAuth(req), parse(idParam, req.params).id, false),
  );

  // The dashboard itself: static files, routed by the URL hash, so /admin/ is the only page.
  if (deps.adminUiDir && existsSync(deps.adminUiDir)) {
    await app.register(fastifyStatic, { root: deps.adminUiDir, prefix: "/admin/", maxAge: "1h" });
    app.get("/admin", (_req, reply) => reply.redirect("/admin/"));
  }

  return app;
}
