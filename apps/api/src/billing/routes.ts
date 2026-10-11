/** Customer-facing billing routes: plans, entitlements, companies, users and the usage counters. */
import { AuditRunInput, CompanyInput, ImportInput, InviteUserInput } from "@platform/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import type { BillingService } from "./service.js";

export interface RouteDeps {
  db: Db;
  billing: BillingService;
  auth: (req: FastifyRequest) => Promise<{ userId: string; accountId: string }>;
}

/** The signed-in user must be the account's owner. */
export async function ownerAuth(deps: RouteDeps, req: FastifyRequest) {
  const who = await deps.auth(req);
  const user = await deps.db.query.users.findFirst({ where: eq(users.id, who.userId) });
  if (user?.role !== "owner") throw new HttpError(403, "FORBIDDEN", "Only the account owner can do this");
  return who;
}

export function registerBillingRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { billing, auth } = deps;
  const parse = <T extends z.ZodType>(schema: T, value: unknown): z.infer<T> => schema.parse(value);

  app.get("/v1/plans", async () => billing.catalog());
  app.get("/v1/billing/entitlements", async (req) => billing.entitlements((await auth(req)).accountId));

  app.get("/v1/companies", async (req) => billing.listCompanies((await auth(req)).accountId));
  app.post("/v1/companies", async (req) =>
    billing.registerCompany((await auth(req)).accountId, parse(CompanyInput, req.body)),
  );
  app.post("/v1/companies/active", async (req) => {
    const { accountId } = await ownerAuth(deps, req);
    const { inns } = parse(z.object({ inns: z.array(z.string().min(1).max(20)).max(200) }), req.body);
    return billing.chooseActive(accountId, inns);
  });

  app.post("/v1/users", async (req) => {
    const { accountId } = await ownerAuth(deps, req);
    return billing.inviteUser(accountId, parse(InviteUserInput, req.body));
  });
  app.delete("/v1/users/:id", async (req, reply) => {
    const who = await ownerAuth(deps, req);
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    await billing.removeUser(who.accountId, id, who.userId);
    return reply.status(204).send();
  });

  // The desktop reports what it did, so the plan's monthly limits can hold on the server.
  app.post("/v1/usage/import", async (req) => {
    const { accountId } = await auth(req);
    const { count, inn } = parse(ImportInput, req.body ?? {});
    return billing.countImport(accountId, count, inn);
  });
  app.post("/v1/audits/runs", async (req) => {
    const { accountId } = await auth(req);
    return billing.countAudit(accountId, parse(AuditRunInput, req.body ?? {}).inn);
  });
}
