/** Customer-facing billing routes: plans, entitlements, companies, users and the usage counters. */
import {
  AuditRunInput,
  AutoRechargeInput,
  ChangePlanInput,
  CheckoutInput,
  CompanyInput,
  ImportInput,
  InviteUserInput,
  PaymentProvider,
  PurchaseCreditsInput,
} from "@platform/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import type { ClickMerchant } from "./click.js";
import type { Credits } from "./credits.js";
import type { Invoicing } from "./invoicing.js";
import { PAYME_NOT_POST, PAYME_PARSE_ERROR, PAYME_SYSTEM_ERROR, type PaymeMerchant } from "./payme.js";
import type { BillingService } from "./service.js";

export interface RouteDeps {
  db: Db;
  credits: Credits;
  billing: BillingService;
  invoicing: Invoicing;
  payme: PaymeMerchant;
  click: ClickMerchant;
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

/** Customer billing: the subscription, trial, checkout, plan changes and invoices (owner only). */
export function registerSubscriptionRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { invoicing, payme, click, db } = deps;
  const parse = <T extends z.ZodType>(schema: T, value: unknown): z.infer<T> => schema.parse(value);
  const owner = (req: FastifyRequest) => ownerAuth(deps, req);

  app.get("/v1/billing/subscription", async (req) =>
    invoicing.subscriptionView((await owner(req)).accountId),
  );
  app.post("/v1/billing/trial", async (req) => invoicing.startTrial((await owner(req)).accountId));
  // What a checkout would cost (discount, VAT, total), without creating an invoice.
  app.post("/v1/billing/quote", async (req) => {
    const { accountId } = await owner(req);
    const q = await invoicing.quote(accountId, parse(CheckoutInput, req.body));
    return {
      items: q.items,
      subtotalSum: q.subtotalSum,
      discountSum: q.discountSum,
      vatSum: q.vatSum,
      totalSum: q.totalSum,
    };
  });
  app.post("/v1/billing/checkout", async (req) =>
    invoicing.checkout((await owner(req)).accountId, parse(CheckoutInput, req.body)),
  );
  app.post("/v1/billing/change-plan", async (req) =>
    invoicing.changePlan((await owner(req)).accountId, parse(ChangePlanInput, req.body)),
  );
  app.post("/v1/billing/cancel", async (req) => invoicing.cancel((await owner(req)).accountId));
  app.post("/v1/billing/resume", async (req) => invoicing.resume((await owner(req)).accountId));
  app.get("/v1/billing/invoices", async (req) => invoicing.listInvoices((await owner(req)).accountId));

  // AI credits: the balance with its history, buying more, and auto-recharge (owner only for changes).
  app.get("/v1/billing/credits", async (req) => deps.credits.view((await deps.auth(req)).accountId));
  app.post("/v1/billing/credits/purchase", async (req) => {
    const input = parse(PurchaseCreditsInput, req.body);
    return deps.credits.purchase((await owner(req)).accountId, input.credits, input.provider);
  });
  app.post("/v1/billing/credits/auto-recharge", async (req) =>
    deps.credits.saveAutoRecharge((await owner(req)).accountId, parse(AutoRechargeInput, req.body)),
  );

  // Pays an invoice that already exists (a renewal, or one made earlier): picks the provider.
  app.post("/v1/billing/invoices/:id/checkout", async (req) => {
    const { accountId } = await owner(req);
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const { provider } = parse(z.object({ provider: PaymentProvider.default("payme") }), req.body ?? {});
    const row = await invoicing.invoice(accountId, id);
    if (row.status === "paid" || row.status === "cancelled") {
      throw new HttpError(409, "INVOICE_NOT_PAYABLE", "This invoice cannot be paid");
    }
    if (provider !== "bank" && !invoicing.providers().includes(provider)) {
      throw new HttpError(
        409,
        "PROVIDER_UNAVAILABLE",
        "Card payment is not available yet: pay by bank transfer",
      );
    }
    return {
      ...invoicing.checkoutOf(row, provider),
      invoice: (await invoicing.listInvoices(accountId)).find((i) => i.id === id),
    };
  });
  // The invoice as a printable page (the browser saves it as PDF): requisites for a bank transfer.
  app.get("/v1/billing/invoices/:id/print", async (req, reply) => {
    const { accountId } = await owner(req);
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const row = await invoicing.invoice(accountId, id);
    const account = await db.query.accounts.findFirst({ where: (a, { eq: same }) => same(a.id, accountId) });
    return reply.type("text/html; charset=utf-8").send(invoicing.invoiceHtml(row, account?.name ?? ""));
  });

  // Payme calls this (JSON-RPC, Basic auth with the merchant key).
  // Payme's general errors, always on a 200: a body that is not JSON is -32700, a fault of ours (the database, the file system)
  // is -32400 and is logged, and a request that is not a POST is -32300.
  app.route({
    method: ["GET", "PUT", "PATCH", "DELETE"],
    url: "/v1/billing/payme",
    handler: async () => ({ id: null, error: PAYME_NOT_POST }),
  });
  app.post(
    "/v1/billing/payme",
    {
      errorHandler(error, req, reply) {
        const code = (error as { code?: string }).code ?? "";
        if (code.startsWith("FST_ERR_CTP"))
          return reply.code(200).send({ id: null, error: PAYME_PARSE_ERROR });
        req.log.error({ err: error }, "payme: internal error");
        return reply.code(200).send({ id: null, error: PAYME_SYSTEM_ERROR });
      },
    },
    async (req) => {
      const body = (req.body ?? {}) as { method?: unknown; id?: unknown };
      const answer = await payme.handle(req.headers.authorization, req.body);
      // One line per call, for the sandbox runs and for the first real payments: no keys, no card data (Payme sends none).
      const error = (answer as { error?: { code?: number } }).error;
      req.log.info(
        { payme: { method: String(body.method), id: body.id ?? null, error: error?.code ?? null } },
        "payme call",
      );
      return answer;
    },
  );

  // Click calls these two (SHOP API: form-urlencoded in, JSON out, always 200 with error / error_note). They live in their own
  // scope so that the form parser is only theirs.
  app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
    );
    const answer = (action: "prepare" | "complete") => async (req: FastifyRequest) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = action === "prepare" ? await click.prepare(body) : await click.complete(body);
      // One line per call, for the test runs and the first real payments: no secret, no card data (Click sends none).
      req.log.info(
        { click: { action, transaction: body.click_trans_id ?? null, error: result.error ?? null } },
        "click call",
      );
      return result;
    };
    const errors = {
      errorHandler(
        error: unknown,
        req: FastifyRequest,
        reply: { code(n: number): { send(b: unknown): unknown } },
      ) {
        req.log.error({ err: error }, "click: internal error");
        return reply.code(200).send({ error: -8, error_note: "Error in request from click" });
      },
    };
    scope.post("/v1/billing/click/prepare", errors, answer("prepare"));
    scope.post("/v1/billing/click/complete", errors, answer("complete"));
  });
}
