import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import {
  ActivateDeviceInput,
  LicenseCheckInput,
  LoginInput,
  RefreshInput,
  RegisterInput,
} from "@platform/shared";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError, type z } from "zod";

import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { HttpError } from "./lib/errors.js";
import { Tokens } from "./lib/tokens.js";
import { Service } from "./service.js";

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value);
}

export async function buildApp(db: Db, config: Config) {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ["req.headers.authorization"] },
    trustProxy: true, // behind Caddy
    bodyLimit: 64 * 1024,
  });
  const tokens = new Tokens(config);
  const service = new Service(db, tokens, config);

  // The desktop app calls from its main process; browsers (website, admin) come later.
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

  const strict = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

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
  app.post("/v1/license/check", async (req) => {
    const { userId } = await auth(req);
    return service.checkLicense(userId, parse(LicenseCheckInput, req.body).machineId);
  });
  app.get("/v1/license/public-key", async () => ({ publicKey: await tokens.publicKey() }));

  return app;
}
