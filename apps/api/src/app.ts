import { existsSync } from "node:fs";

import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import {
  AccountsQuery,
  ActivateDeviceInput,
  AdminLoginInput,
  CreateAdminInput,
  ExtendInput,
  AiChatInput,
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
import { AiProxy, assertInlineFiles } from "./ai/proxy.js";
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
  /** The built admin dashboard (apps/admin/dist), served at /admin/ when present. */
  adminUiDir?: string;
}

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
    { bodyLimit: 30 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const who = await auth(req);
      const input = parse(AiChatInput, req.body);
      assertInlineFiles(input);
      await ai.ensureAllowed(who.accountId);

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
      await ai.turn(who, input, send, aborted.signal);
      reply.raw.end();
    },
  );

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
