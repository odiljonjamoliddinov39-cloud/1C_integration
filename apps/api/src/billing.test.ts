import { generateKeyPairSync } from "node:crypto";

import Anthropic from "@anthropic-ai/sdk";

import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, runMigrations } from "./db/client.js";
import { Billing } from "./billing/entitlements.js";
import { Invoicing } from "./billing/invoicing.js";
import { Lifecycle } from "./billing/lifecycle.js";
import {
  aiUsage,
  billingEvents,
  companies,
  invoices,
  payments,
  plans,
  promoCodes,
  subscriptionAddons,
  subscriptions,
} from "./db/schema.js";

// Needs PostgreSQL (CI starts one). Each run gets a fresh database.
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const TEST_DB = "platform_billing_test";
const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
const available = await admin`select 1`.then(() => true).catch(() => false);

const { privateKey } = generateKeyPairSync("ed25519");
const account = {
  email: "owner@example.com",
  password: "correct-horse-battery",
  name: "Owner",
  accountName: "Buxgalter MChJ",
};

const fakeModel = {
  async turn(
    _params: BetaMessageStreamParams,
    { onText }: { onText: (text: string) => void; onProgress?: (text: string) => void },
  ) {
    onText("ok");
    return {
      model: "claude-sonnet-5-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    } as unknown as BetaMessage;
  },
};

describe.skipIf(!available)("tariffs", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: ReturnType<typeof createDb>;
  let lifecycle: Lifecycle;
  let config: ReturnType<typeof loadConfig>;

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    const url = ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`);
    db = createDb(url);
    await runMigrations(db.db);
    config = loadConfig({
      // These tests cover the older question quota and dollar budget; the credit balance has its own (credits.test.ts).
      AI_CREDITS: "off",
      DATABASE_URL: url,
      JWT_SECRET: "test-secret-that-is-long-enough-1234567890",
      LICENSE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      LOG_LEVEL: process.env.TEST_LOG ?? "silent",
      AUTH_RATE_PER_MINUTE: "1000",
      ENTITLEMENTS_CACHE_SECONDS: "0",
      VAT_PERCENT: "12", // the VAT logic stays configurable; the product default is 0
      BILLING_JOBS: "off",
      OFFER_REQUIRED: "off", // the offer gate has its own tests (offer.test.ts)
      PAYME_MERCHANT_ID: "merchant-1",
      PAYME_KEY: "payme-secret-key",
      PAYME_TEST: "true",
      CLICK_SERVICE_ID: "31",
      CLICK_MERCHANT_ID: "46",
      CLICK_MERCHANT_USER_ID: "4",
      CLICK_SECRET_KEY: "click-secret",
      SITE_URL: "https://site.example",
      ADMIN_EMAIL: "boss@platform.uz",
      ADMIN_PASSWORD: "admin-password-123",
    });
    app = await buildApp(db.db, config, { aiModel: fakeModel });
    const billing = new Billing(db.db, 0);
    lifecycle = new Lifecycle(db.db, config, billing, new Invoicing(db.db, config, billing));
  });

  beforeEach(async () => {
    await db.sql`TRUNCATE accounts, refresh_tokens CASCADE`;
    await db.sql`TRUNCATE promo_codes`;
  });

  afterAll(async () => {
    await app?.close();
    await db?.sql.end();
    await admin.end();
  });

  const call = (method: "GET" | "POST" | "DELETE", url: string, token?: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as object }),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  const register = async (email = account.email) => {
    const reg = (await call("POST", "/v1/auth/register", undefined, { ...account, email })).json();
    return { token: reg.accessToken as string, accountId: reg.me.account.id as string };
  };
  /** Puts the account on a plan (paid for a month from now), as a payment would. */
  const setPlan = async (accountId: string, code: string, status = "active") => {
    const plan = await db.db.query.plans.findFirst({ where: eq(plans.code, code) });
    await db.db
      .update(subscriptions)
      .set({ planId: plan!.id, status: status as "active", endsAt: new Date(Date.now() + 20 * 86_400_000) })
      .where(eq(subscriptions.accountId, accountId));
  };

  it("seeds the four plans and the add-ons, and shows them without signing in", async () => {
    const res = await call("GET", "/v1/plans");
    expect(res.statusCode).toBe(200);
    const catalog = res.json();
    expect(catalog.plans.map((p: { code: string }) => p.code)).toEqual(["free", "start", "business", "firm"]);
    expect(catalog.plans[1]).toMatchObject({
      priceMonthSum: 590_000,
      priceYearSum: 5_900_000,
      companies: 1,
      users: 1,
      aiQuestionsPerMonth: 80,
      importsPerMonth: null,
    });
    expect(catalog.plans[0]).toMatchObject({ priceMonthSum: 0, importsPerMonth: 30, auditsPerMonth: 1 });
    expect(catalog.addons.map((a: { code: string }) => a.code).sort()).toEqual([
      "addon_ai_100",
      "addon_company",
      "addon_user",
    ]);
    expect(catalog.vatPercent).toBe(12);
  });

  it("gives every new account Free and reports its limits and use", async () => {
    const { token } = await register();
    const res = (await call("GET", "/v1/billing/entitlements", token)).json();
    expect(res.entitlements).toEqual({
      plan: "free",
      status: "free",
      periodEnd: null,
      companies: 1,
      users: 1,
      importsPerMonth: 30,
      auditsPerMonth: 1,
      aiQuestionsPerMonth: 10,
      features: { excelExport: false, prioritySupport: false },
    });
    expect(res.usage).toMatchObject({ companies: 0, users: 1, imports: 0, audits: 0, aiQuestions: 0 });
    expect(res.canStartTrial).toBe(true);
    expect((await call("GET", "/v1/billing/entitlements")).statusCode).toBe(401);
  });

  it("merges the plan with active add-ons and ignores expired ones", async () => {
    const { token, accountId } = await register();
    await setPlan(accountId, "business");
    const sub = await db.db.query.subscriptions.findFirst({ where: eq(subscriptions.accountId, accountId) });
    const now = Date.now();
    const at = (days: number) => new Date(now + days * 86_400_000);
    await db.db.insert(subscriptionAddons).values([
      { subscriptionId: sub!.id, addonCode: "addon_company", quantity: 2, validFrom: at(-1), validTo: at(1) },
      { subscriptionId: sub!.id, addonCode: "addon_user", quantity: 1, validFrom: at(-1), validTo: at(1) },
      { subscriptionId: sub!.id, addonCode: "addon_ai_100", quantity: 1, validFrom: at(-1), validTo: at(1) },
      {
        subscriptionId: sub!.id,
        addonCode: "addon_company",
        quantity: 5,
        validFrom: at(-9),
        validTo: at(-1),
      },
    ]);
    const res = (await call("GET", "/v1/billing/entitlements", token)).json();
    expect(res.entitlements).toMatchObject({
      plan: "business",
      status: "active",
      companies: 3 + 2,
      users: 2 + 1,
      aiQuestionsPerMonth: 250 + 100,
      features: { excelExport: true, prioritySupport: true },
    });
    expect(res.canStartTrial).toBe(false);
  });

  it("refuses a second company on Free, and a connected base can be renamed", async () => {
    const { token } = await register();
    const first = await call("POST", "/v1/companies", token, { inn: "300000001", name: "Alfa" });
    expect(first.statusCode).toBe(200);
    expect(
      (await call("POST", "/v1/companies", token, { inn: "300000001", name: "Alfa MChJ" })).json().name,
    ).toBe("Alfa MChJ");
    const refused = await call("POST", "/v1/companies", token, { inn: "300000002", name: "Beta" });
    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toMatchObject({ code: "COMPANY_LIMIT" });
    expect(refused.json().message).toContain("Plan allows 1 company");
  });

  it("leaves extra companies read-only after a downgrade: the newest stay active, or the owner's pick", async () => {
    const { token, accountId } = await register();
    await setPlan(accountId, "business");
    for (const [n, inn] of ["1", "2", "3"].entries()) {
      await call("POST", "/v1/companies", token, { inn: `30000000${inn}`, name: `Co ${inn}` });
      await db.db
        .update(companies)
        .set({ connectedAt: new Date(Date.now() - (3 - n) * 86_400_000) })
        .where(eq(companies.inn, `30000000${inn}`));
    }
    await setPlan(accountId, "free");
    const view = (await call("GET", "/v1/billing/entitlements", token)).json();
    expect(view.readOnlyCompanies.sort()).toEqual(["300000001", "300000002"]);

    const choice = await call("POST", "/v1/companies/active", token, { inns: ["300000001"] });
    expect(choice.statusCode).toBe(200);
    expect((await call("GET", "/v1/billing/entitlements", token)).json().readOnlyCompanies.sort()).toEqual([
      "300000002",
      "300000003",
    ]);
    expect(
      (await call("POST", "/v1/companies/active", token, { inns: ["300000001", "300000002"] })).json().code,
    ).toBe("COMPANY_LIMIT");
    // Imports into a read-only company are refused.
    const refused = await call("POST", "/v1/usage/import", token, { count: 1, inn: "300000002" });
    expect(refused.json().code).toBe("COMPANY_READ_ONLY");
  });

  it("stops Free imports at 30 a month and lets paid plans through", async () => {
    const { token, accountId } = await register();
    expect((await call("POST", "/v1/usage/import", token, { count: 29 })).json().usage.imports).toBe(29);
    expect((await call("POST", "/v1/usage/import", token, { count: 1 })).json().usage.imports).toBe(30);
    const refused = await call("POST", "/v1/usage/import", token, { count: 1 });
    expect(refused.statusCode).toBe(402);
    expect(refused.json().code).toBe("IMPORT_LIMIT");
    expect((await call("GET", "/v1/billing/entitlements", token)).json().usage.imports).toBe(30);
    await setPlan(accountId, "start");
    expect((await call("POST", "/v1/usage/import", token, { count: 100 })).statusCode).toBe(200);
  });

  it("counts audits: one a month on Free", async () => {
    const { token, accountId } = await register();
    expect((await call("POST", "/v1/audits/runs", token, {})).statusCode).toBe(200);
    const refused = await call("POST", "/v1/audits/runs", token, {});
    expect(refused.json().code).toBe("AUDIT_LIMIT");
    await setPlan(accountId, "business");
    expect((await call("POST", "/v1/audits/runs", token, {})).statusCode).toBe(200);
  });

  it("refuses a user the plan has no seat for, and frees the seat when one is removed", async () => {
    const { token, accountId } = await register();
    const colleague = { email: "second@example.com", name: "Second", password: "another-long-password" };
    const refused = await call("POST", "/v1/users", token, colleague);
    expect(refused.statusCode).toBe(402);
    expect(refused.json().code).toBe("USER_LIMIT");
    await setPlan(accountId, "business");
    const added = await call("POST", "/v1/users", token, colleague);
    expect(added.statusCode).toBe(200);
    expect(
      (await call("POST", "/v1/users", token, { ...colleague, email: "third@example.com" })).json().code,
    ).toBe("USER_LIMIT");
    expect((await call("DELETE", `/v1/users/${added.json().id}`, token)).statusCode).toBe(204);
    expect(
      (await call("POST", "/v1/users", token, { ...colleague, email: "third@example.com" })).statusCode,
    ).toBe(200);
    // Only the owner invites.
    const member = (
      await call("POST", "/v1/auth/login", undefined, {
        email: "third@example.com",
        password: colleague.password,
      })
    ).json();
    expect(
      (await call("POST", "/v1/users", member.accessToken, { ...colleague, email: "x@example.com" }))
        .statusCode,
    ).toBe(403);
  });

  it("counts AI questions: warns at 80%, blocks at 100%, and never cuts an answer in progress", async () => {
    const { token } = await register();
    const ask = async (messages: unknown[]) => {
      const res = await call("POST", "/v1/ai/chat", token, { company: "X", messages });
      if (res.statusCode !== 200)
        return { status: res.statusCode, code: res.json().code as string, events: [] };
      const events = res.body
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { type: string; code?: string });
      return { status: 200, code: "", events };
    };
    const question = (n: number) => [{ role: "user", content: `question ${n}` }];
    const warnings: string[] = [];
    for (let n = 1; n <= 10; n++) {
      const res = await ask(question(n));
      expect(res.status).toBe(200);
      for (const e of res.events) if (e.type === "warning" && e.code) warnings.push(e.code);
    }
    expect(warnings).toEqual(["AI_QUESTIONS_WARNING"]);

    // A later step of the same answer (tool results) still goes through at 100%.
    const step = [
      { role: "user", content: "question 10" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "rows" }] },
    ];
    expect((await ask(step)).status).toBe(200);

    const blocked = await ask(question(11));
    expect(blocked).toMatchObject({ status: 402, code: "AI_QUESTIONS_LIMIT" });
    expect((await call("GET", "/v1/billing/entitlements", token)).json().usage.aiQuestions).toBe(10);
  });

  // --- trial, invoices, Payme, plan changes and the lifecycle ----------------------------------------

  const DAY = 86_400_000;
  const entitlements = async (token: string) => (await call("GET", "/v1/billing/entitlements", token)).json();
  const subscription = async (accountId: string) =>
    (await db.db.query.subscriptions.findFirst({ where: eq(subscriptions.accountId, accountId) }))!;
  const events = async (accountId: string) =>
    (await db.db.select().from(billingEvents).where(eq(billingEvents.accountId, accountId))).map(
      (e) => e.type,
    );
  /** Payme's sandbox calls, with the merchant key. */
  const rpc = (method: string, params: Record<string, unknown>, key = "payme-secret-key") =>
    app
      .inject({
        method: "POST",
        url: "/v1/billing/payme",
        payload: { id: 1, method, params },
        headers: { authorization: `Basic ${Buffer.from(`Paycom:${key}`).toString("base64")}` },
      })
      .then((res) => res.json());
  /** The customer pays an invoice through Payme: create and perform a transaction. */
  const pay = async (invoice: { number: string; totalSum: number }, txn = `txn-${Math.random()}`) => {
    const account = { invoice_id: Number(invoice.number.slice(4)) };
    const amount = invoice.totalSum * 100;
    const created = await rpc("CreateTransaction", { id: txn, time: Date.now(), amount, account });
    expect(created.result?.state).toBe(1);
    const done = await rpc("PerformTransaction", { id: txn });
    expect(done.result?.state).toBe(2);
    return txn;
  };
  const checkout = async (token: string, body: Record<string, unknown>) => {
    const res = await call("POST", "/v1/billing/checkout", token, body);
    expect(res.statusCode).toBe(200);
    return res.json() as {
      invoice: { id: string; number: string; totalSum: number; vatSum: number; discountSum: number };
      checkoutUrl: string | null;
    };
  };

  it("starts the 14-day Business trial once, caps its AI questions at 30, and lands on Free when it ends", async () => {
    const { token, accountId } = await register();
    const started = await call("POST", "/v1/billing/trial", token);
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ plan: "business", status: "trial", trialUsed: true });
    const view = await entitlements(token);
    expect(view.entitlements).toMatchObject({
      plan: "business",
      status: "trial",
      companies: 3,
      users: 2,
      aiQuestionsPerMonth: 30,
    });
    expect(view.canStartTrial).toBe(false);
    expect((await call("POST", "/v1/billing/trial", token)).json().code).toBe("TRIAL_USED");

    await db.db
      .update(subscriptions)
      .set({ endsAt: new Date(Date.now() - 60_000) })
      .where(eq(subscriptions.accountId, accountId));
    // Before the job runs the account already counts as Free (read against the clock).
    expect((await entitlements(token)).entitlements).toMatchObject({ plan: "free", status: "free" });
    expect(await lifecycle.hourly()).toMatchObject({ movedToFree: 1 });
    expect((await subscription(accountId)).status).toBe("free");
    expect(await events(accountId)).toEqual(expect.arrayContaining(["trial_started", "moved_to_free"]));
    expect((await call("POST", "/v1/billing/trial", token)).json().code).toBe("TRIAL_USED");
  });

  it("refuses a second trial for the same company INN on another account", async () => {
    const first = await register("first@example.com");
    await call("POST", "/v1/companies", first.token, { inn: "300111222", name: "Alfa" });
    expect((await call("POST", "/v1/billing/trial", first.token)).statusCode).toBe(200);
    const second = await register("second@example.com");
    await call("POST", "/v1/companies", second.token, { inn: "300111222", name: "Alfa again" });
    const refused = await call("POST", "/v1/billing/trial", second.token);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("TRIAL_USED");
  });

  it("makes an invoice with VAT, and a Payme checkout link in tiyin; a bank transfer has no link", async () => {
    const { token } = await register();
    const card = await checkout(token, { plan: "start", cycle: "month", provider: "payme" });
    // 590 000 + 12% VAT = 660 800 sum = 66 080 000 tiyin.
    expect(card.invoice).toMatchObject({ totalSum: 660_800, vatSum: 70_800, discountSum: 0 });
    const link = new URL(card.checkoutUrl!);
    expect(link.host).toBe("checkout.test.paycom.uz");
    const params = Buffer.from(link.pathname.slice(1), "base64").toString();
    expect(params).toContain("m=merchant-1");
    expect(params).toContain(`ac.invoice_id=${Number(card.invoice.number.slice(4))}`);
    expect(params).toContain("a=66080000");
    const bank = await checkout(token, { plan: "business", cycle: "year", provider: "bank" });
    expect(bank.checkoutUrl).toBeNull();
    // 16 900 000 + VAT.
    expect(bank.invoice.totalSum).toBe(16_900_000 + 2_028_000);
    expect((await call("GET", "/v1/billing/invoices", token)).json()).toHaveLength(2);
    const page = await call("GET", `/v1/billing/invoices/${bank.invoice.id}/print`, token);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("INV-");
  });

  it("passes Payme's cases: privileges, wrong amount, unknown invoice, idempotent create and perform, no cancel after perform", async () => {
    const { token, accountId } = await register();
    const { invoice } = await checkout(token, { plan: "start", cycle: "month", provider: "payme" });
    const account = { invoice_id: Number(invoice.number.slice(4)) };
    const amount = invoice.totalSum * 100;

    expect((await rpc("CheckPerformTransaction", { amount, account }, "wrong-key")).error.code).toBe(-32504);
    expect((await rpc("Nope", {})).error.code).toBe(-32601);
    expect((await rpc("CheckPerformTransaction", { amount: amount + 100, account })).error.code).toBe(-31001);
    expect(
      (await rpc("CheckPerformTransaction", { amount, account: { invoice_id: 999_999 } })).error.code,
    ).toBe(-31050);
    expect((await rpc("CheckPerformTransaction", { amount, account })).result).toEqual({ allow: true });

    const created = await rpc("CreateTransaction", { id: "p1", time: Date.now(), amount, account });
    expect(created.result).toMatchObject({ state: 1 });
    // The same transaction again returns what was stored; another transaction for the invoice is refused.
    expect((await rpc("CreateTransaction", { id: "p1", time: Date.now(), amount, account })).result).toEqual(
      created.result,
    );
    expect((await rpc("CreateTransaction", { id: "p2", time: Date.now(), amount, account })).error.code).toBe(
      -31099,
    );
    expect((await rpc("CheckTransaction", { id: "p1" })).result).toMatchObject({ state: 1, perform_time: 0 });
    expect((await rpc("CheckTransaction", { id: "nope" })).error.code).toBe(-31003);

    const done = await rpc("PerformTransaction", { id: "p1" });
    expect(done.result).toMatchObject({ state: 2 });
    const before = await subscription(accountId);
    expect(before).toMatchObject({ status: "active" });
    // Performing again changes nothing: the stored result comes back and the period is not extended twice.
    expect((await rpc("PerformTransaction", { id: "p1" })).result).toEqual(done.result);
    expect((await subscription(accountId)).endsAt).toEqual(before.endsAt);
    expect((await rpc("CancelTransaction", { id: "p1", reason: 5 })).error.code).toBe(-31007);
    expect((await rpc("CheckPerformTransaction", { amount, account })).error.code).toBe(-31051);

    const statement = await rpc("GetStatement", { from: Date.now() - DAY, to: Date.now() + DAY });
    expect(statement.result.transactions).toHaveLength(1);
    expect(await db.db.select().from(payments)).toHaveLength(1);
    expect((await entitlements(token)).entitlements).toMatchObject({
      plan: "start",
      status: "active",
      aiQuestionsPerMonth: 80,
    });
  });

  it("answers the general errors of Payme's table on a 200: not JSON, not POST, an unknown method named in data", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/payme",
      payload: "{not json",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from("Paycom:payme-secret-key").toString("base64")}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: null, error: { code: -32700 } });
    const get = await app.inject({ method: "GET", url: "/v1/billing/payme" });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ error: { code: -32300 } });
    const unknown = await rpc("Nope", {});
    expect(unknown.error).toMatchObject({ code: -32601, data: "Nope" });
  });

  it("adds the fiscal receipt line only when the merchant has fiscalization set up", async () => {
    const { token } = await register();
    const { invoice } = await checkout(token, { plan: "start", cycle: "month", provider: "payme" });
    const account = { invoice_id: Number(invoice.number.slice(4)) };
    const amount = invoice.totalSum * 100;
    expect((await rpc("CheckPerformTransaction", { amount, account })).result).toEqual({ allow: true });

    const fiscal = await buildApp(
      db.db,
      {
        ...config,
        PAYME_FISCAL_CODE: "10305011001000000",
        PAYME_FISCAL_PACKAGE: "123456",
        PAYME_FISCAL_UNITS: 796,
      },
      { aiModel: fakeModel },
    );
    const res = await fiscal.inject({
      method: "POST",
      url: "/v1/billing/payme",
      payload: { id: 1, method: "CheckPerformTransaction", params: { amount, account } },
      headers: { authorization: `Basic ${Buffer.from("Paycom:payme-secret-key").toString("base64")}` },
    });
    expect(res.json().result).toMatchObject({
      allow: true,
      detail: {
        receipt_type: 0,
        items: [
          {
            price: amount,
            count: 1,
            code: "10305011001000000",
            package_code: "123456",
            vat_percent: 12,
            units: 796,
          },
        ],
      },
    });
    await fiscal.close();
  });

  it("lists the statement oldest first, inclusive of both ends, and keeps the fiscal data of a paid and of a cancelled receipt apart", async () => {
    const { token } = await register();
    const first = await checkout(token, { plan: "start", cycle: "month", provider: "payme" });
    const second = await checkout(token, { plan: "business", cycle: "month", provider: "payme" });
    const make = (invoice: { number: string; totalSum: number }) => ({
      account: { invoice_id: Number(invoice.number.slice(4)) },
      amount: invoice.totalSum * 100,
    });
    // Payme's own times, the newer one created first: the list must still come back by time.
    await rpc("CreateTransaction", { id: "later", time: 2_000, ...make(second.invoice) });
    await rpc("CreateTransaction", { id: "earlier", time: 1_000, ...make(first.invoice) });
    const listed = await rpc("GetStatement", { from: 1_000, to: 2_000 });
    expect(listed.result.transactions.map((t: { id: string }) => t.id)).toEqual(["earlier", "later"]);
    expect((await rpc("GetStatement", { from: 1_001, to: 1_999 })).result).toEqual({ transactions: [] });

    const performed = { receipt_id: 121, status_code: 0, message: "accepted", fiscal_sign: "800031554082" };
    expect(
      (await rpc("SetFiscalData", { id: "earlier", type: "PERFORM", fiscal_data: performed })).result,
    ).toEqual({ success: true });
    expect(
      (
        await rpc("SetFiscalData", {
          id: "earlier",
          type: "CANCEL",
          fiscal_data: { ...performed, receipt_id: 123 },
        })
      ).result,
    ).toEqual({ success: true });
    const [row] = (await db.db.select().from(payments)).filter((p) => p.providerTxnId === "earlier");
    expect((row?.raw as { fiscal?: Record<string, { receipt_id: number }> }).fiscal).toMatchObject({
      perform_data: { receipt_id: 121 },
      cancel_data: { receipt_id: 123 },
    });
    expect(
      (await rpc("SetFiscalData", { id: "nobody", type: "PERFORM", fiscal_data: performed })).error.code,
    ).toBe(-32001);
    expect(
      (await rpc("SetFiscalData", { id: "earlier", type: "REFUND", fiscal_data: performed })).error,
    ).toMatchObject({
      code: -32602,
      data: "type",
    });
  });

  describe("Click", () => {
    const md5 = (s: string) => createHash("md5").update(s).digest("hex");
    /** A request from Click, signed as its SHOP API says, and sent form-urlencoded. */
    const click = async (
      action: "prepare" | "complete",
      fields: Record<string, string | number>,
      key = "click-secret",
    ) => {
      const f: Record<string, string | number> = {
        click_trans_id: 7001,
        service_id: 31,
        click_paydoc_id: 9001,
        action: action === "prepare" ? 0 : 1,
        error: 0,
        error_note: "Success",
        sign_time: "2026-10-24 12:00:00",
        ...fields,
      };
      const sign = md5(
        `${f.click_trans_id}${f.service_id}${key}${f.merchant_trans_id}${action === "complete" ? (f.merchant_prepare_id ?? "") : ""}${f.amount}${f.action}${f.sign_time}`,
      );
      const res = await app.inject({
        method: "POST",
        url: `/v1/billing/click/${action}`,
        payload: new URLSearchParams(
          Object.entries({ sign_string: sign, ...f }).map(([k2, v]): [string, string] => [k2, String(v)]),
        ).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      expect(res.statusCode).toBe(200);
      return res.json() as Record<string, unknown>;
    };
    const order = async () => {
      const { token, accountId } = await register();
      const made = await checkout(token, { plan: "start", cycle: "month", provider: "click" });
      return {
        token,
        accountId,
        made,
        merchant_trans_id: String(Number(made.invoice.number.slice(4))),
        amount: made.invoice.totalSum,
      };
    };

    it("gives the link and the values of Click's window over the page, with the amount as N.NN", async () => {
      const { made, merchant_trans_id } = await order();
      const link = new URL(made.checkoutUrl!);
      expect(link.host).toBe("my.click.uz");
      expect(Object.fromEntries(link.searchParams)).toMatchObject({
        service_id: "31",
        merchant_id: "46",
        merchant_user_id: "4",
        amount: "660800.00",
        transaction_param: merchant_trans_id,
        return_url: "https://site.example/cabinet",
      });
      expect((made as unknown as { click: unknown }).click).toEqual({
        serviceId: "31",
        merchantId: "46",
        merchantUserId: "4",
        amount: "660800.00",
        transactionParam: merchant_trans_id,
      });
    });

    it("prepares, completes once, and is idempotent: the plan is applied once and a repeat is «already paid»", async () => {
      const { accountId, merchant_trans_id, amount } = await order();
      const prepared = await click("prepare", { merchant_trans_id, amount });
      expect(prepared).toMatchObject({ error: 0, click_trans_id: 7001, merchant_trans_id });
      const prepareId = prepared.merchant_prepare_id as number;
      expect(prepareId).toBe(Number(merchant_trans_id) * 1000 + 1);
      // The same Prepare again returns the same payment.
      expect(await click("prepare", { merchant_trans_id, amount })).toMatchObject({
        error: 0,
        merchant_prepare_id: prepareId,
      });
      expect(await db.db.select().from(payments)).toHaveLength(1);

      // Complete with another prepare id is «transaction does not exist».
      expect(
        await click("complete", { merchant_trans_id, merchant_prepare_id: prepareId + 5, amount }),
      ).toMatchObject({ error: -6 });
      const done = await click("complete", { merchant_trans_id, merchant_prepare_id: prepareId, amount });
      expect(done).toMatchObject({ error: 0, merchant_confirm_id: prepareId });
      const before = await subscription(accountId);
      expect(before).toMatchObject({ status: "active" });
      expect(
        await click("complete", { merchant_trans_id, merchant_prepare_id: prepareId, amount }),
      ).toMatchObject({
        error: -4,
      });
      expect((await subscription(accountId)).endsAt).toEqual(before.endsAt);
      // A new Prepare for the paid invoice is refused too.
      expect(await click("prepare", { click_trans_id: 7002, merchant_trans_id, amount })).toMatchObject({
        error: -4,
      });
    });

    it("answers Click's error table: signature, amount, action, order, service, a negative status", async () => {
      const { merchant_trans_id, amount } = await order();
      expect(await click("prepare", { merchant_trans_id, amount }, "wrong-key")).toMatchObject({ error: -1 });
      expect(await click("prepare", { merchant_trans_id, amount: amount + 1 })).toMatchObject({ error: -2 });
      // action 1 sent to Prepare (signed as Prepare): «action not found»
      expect(await click("prepare", { merchant_trans_id, amount, action: 1 })).toMatchObject({ error: -3 });
      expect(await click("prepare", { merchant_trans_id: "999999", amount })).toMatchObject({ error: -5 });
      expect(await click("prepare", { merchant_trans_id: "abc", amount })).toMatchObject({ error: -5 });
      expect(await click("prepare", { merchant_trans_id, amount, service_id: 32 })).toMatchObject({
        error: -8,
      });
      expect(await click("prepare", { merchant_trans_id, amount, error: -5 })).toMatchObject({ error: -9 });
      expect(await db.db.select().from(payments)).toHaveLength(0);
    });

    it("cancels a prepared payment when Click reports its own error, and then refuses to complete it", async () => {
      const { merchant_trans_id, amount, accountId } = await order();
      const prepared = await click("prepare", { merchant_trans_id, amount });
      const prepareId = prepared.merchant_prepare_id as number;
      expect(
        await click("complete", { merchant_trans_id, merchant_prepare_id: prepareId, amount, error: -5017 }),
      ).toMatchObject({ error: -9 });
      expect(
        await click("complete", { merchant_trans_id, merchant_prepare_id: prepareId, amount }),
      ).toMatchObject({
        error: -9,
      });
      expect(await subscription(accountId)).not.toMatchObject({ status: "active" });
      // A new attempt (another Click transaction) is a new payment, numbered next, and can be paid.
      const again = await click("prepare", { click_trans_id: 7003, merchant_trans_id, amount });
      expect(again.merchant_prepare_id).toBe(prepareId + 1);
      expect(
        await click("complete", {
          click_trans_id: 7003,
          merchant_trans_id,
          merchant_prepare_id: prepareId + 1,
          amount,
        }),
      ).toMatchObject({ error: 0 });
    });

    it("an invoice paid another way meanwhile is «already paid» for Click, and the twice-paid is logged for a refund", async () => {
      const { merchant_trans_id, amount, accountId, made } = await order();
      const prepared = await click("prepare", { merchant_trans_id, amount });
      // The customer pays the same invoice through Payme before Click completes.
      await pay(made.invoice);
      expect(
        await click("complete", {
          merchant_trans_id,
          merchant_prepare_id: prepared.merchant_prepare_id as number,
          amount,
        }),
      ).toMatchObject({ error: -4 });
      const events = await db.sql`SELECT type FROM billing_events WHERE account_id = ${accountId}`;
      expect(events.map((e) => e.type)).toContain("duplicate_payment");
    });
  });

  it("cancels an unpaid Payme transaction, and cancels one nobody finished after 12 hours", async () => {
    const { token } = await register();
    const { invoice } = await checkout(token, { plan: "start", provider: "payme" });
    const account = { invoice_id: Number(invoice.number.slice(4)) };
    const amount = invoice.totalSum * 100;
    await rpc("CreateTransaction", { id: "c1", time: Date.now(), amount, account });
    expect((await rpc("CancelTransaction", { id: "c1", reason: 3 })).result).toMatchObject({ state: -1 });
    expect((await rpc("PerformTransaction", { id: "c1" })).error.code).toBe(-31008);
    // The invoice can be paid with a new transaction.
    await rpc("CreateTransaction", { id: "c2", time: Date.now(), amount, account });
    await db.db
      .update(payments)
      .set({ raw: sql`jsonb_set(raw, '{create_time}', to_jsonb(${Date.now() - 13 * 3_600_000}::bigint))` })
      .where(eq(payments.providerTxnId, "c2"));
    expect((await rpc("PerformTransaction", { id: "c2" })).error.code).toBe(-31008);
    expect((await rpc("CheckTransaction", { id: "c2" })).result).toMatchObject({ state: -1, reason: 4 });
  });

  it("accepts a payment that arrives after the invoice expired, from the payment date, and logs it for review", async () => {
    const { token, accountId } = await register();
    const { invoice } = await checkout(token, { plan: "start" });
    await db.db.update(invoices).set({ dueAt: new Date(Date.now() - DAY) });
    expect((await lifecycle.hourly()).invoicesExpired).toBe(1);
    await pay(invoice);
    const sub = await subscription(accountId);
    expect(sub.status).toBe("active");
    expect(sub.startsAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await events(accountId)).toContain("late_payment");
  });

  it("prorates an upgrade over the days left, rounded up to 1 000 sum, and keeps the period", async () => {
    const { token, accountId } = await register();
    await pay((await checkout(token, { plan: "start" })).invoice);
    // 10 days used, 20 left of 30.
    await db.db
      .update(subscriptions)
      .set({ startsAt: new Date(Date.now() - 10 * DAY), endsAt: new Date(Date.now() + 20 * DAY) })
      .where(eq(subscriptions.accountId, accountId));
    const before = await subscription(accountId);
    const res = await call("POST", "/v1/billing/change-plan", token, { plan: "business" });
    expect(res.json()).toMatchObject({ effect: "invoice" });
    const { invoice } = res.json().checkout;
    // (1 690 000 - 590 000) * 20 / 30 = 733 333.3 -> 734 000, VAT 88 080.
    expect(invoice).toMatchObject({ totalSum: 734_000 + 88_080, vatSum: 88_080 });
    expect(invoice.items[0].amountSum).toBe(734_000);
    // Not yet: the plan changes when the invoice is paid.
    expect((await entitlements(token)).entitlements.plan).toBe("start");
    await pay(invoice);
    const after = await subscription(accountId);
    expect((await entitlements(token)).entitlements).toMatchObject({ plan: "business", companies: 3 });
    expect(after.endsAt).toEqual(before.endsAt);
    expect(await events(accountId)).toContain("upgraded");
  });

  it("schedules a downgrade for the end of the period; the renewal invoice uses the new price", async () => {
    const { token, accountId } = await register();
    await pay((await checkout(token, { plan: "business" })).invoice);
    const sub = await subscription(accountId);
    const res = await call("POST", "/v1/billing/change-plan", token, { plan: "start" });
    expect(res.json()).toMatchObject({ effect: "scheduled", effectiveAt: sub.endsAt.toISOString() });
    // Still Business until the period ends.
    expect(await entitlements(token)).toMatchObject({
      entitlements: { plan: "business" },
      pendingPlan: "start",
    });

    // The renewal 7 days before the end is made at the new price.
    await db.db
      .update(subscriptions)
      .set({ endsAt: new Date(Date.now() + 6 * DAY) })
      .where(eq(subscriptions.accountId, accountId));
    expect(await lifecycle.daily()).toMatchObject({ renewalInvoices: 1 });
    const list = (await call("GET", "/v1/billing/invoices", token)).json();
    const renewal = list.find((i: { status: string }) => i.status === "pending");
    expect(renewal.items[0]).toMatchObject({ code: "start", amountSum: 590_000 });
    const oldEnd = (await subscription(accountId)).endsAt;
    await pay(renewal);
    const renewed = await subscription(accountId);
    expect((await entitlements(token)).entitlements.plan).toBe("start");
    // The next period starts where the last ended.
    expect(renewed.startsAt).toEqual(oldEnd);
    expect(renewed.pendingPlanId).toBeNull();
    // A second run the same day makes no second renewal invoice for the period.
    expect((await lifecycle.daily()).renewalInvoices).toBe(0);
  });

  it("goes through grace to Free: full access for 3 days, paying restores the original dates", async () => {
    const { token, accountId } = await register();
    await pay((await checkout(token, { plan: "business" })).invoice);
    const original = await subscription(accountId);
    await db.db
      .update(subscriptions)
      .set({ endsAt: new Date(Date.now() - DAY) })
      .where(eq(subscriptions.accountId, accountId));
    expect(await lifecycle.hourly()).toMatchObject({ graceStarted: 1 });
    expect((await subscription(accountId)).status).toBe("grace");
    expect((await entitlements(token)).entitlements).toMatchObject({
      plan: "business",
      status: "grace",
      companies: 3,
    });

    // Paying in grace: the period goes on from the old end date.
    const graceEnd = (await subscription(accountId)).endsAt;
    const quote = await checkout(token, { plan: "business" });
    expect(quote.invoice.totalSum).toBe(1_690_000 + 202_800);
    await pay(quote.invoice);
    const restored = await subscription(accountId);
    expect(restored.status).toBe("active");
    expect(restored.startsAt).toEqual(graceEnd);
    expect(await events(accountId)).toEqual(expect.arrayContaining(["grace_started", "renewed_in_grace"]));
    expect(original.status).toBe("active");

    // Not paid for more than 3 days: Free, nothing deleted.
    await db.db
      .update(subscriptions)
      .set({ status: "grace", endsAt: new Date(Date.now() - 4 * DAY) })
      .where(eq(subscriptions.accountId, accountId));
    expect(await lifecycle.hourly()).toMatchObject({ movedToFree: 1 });
    expect((await entitlements(token)).entitlements).toMatchObject({
      plan: "free",
      status: "free",
      companies: 1,
    });
  });

  it("keeps the plan until the period ends after a cancel, then Free without grace", async () => {
    const { token, accountId } = await register();
    await pay((await checkout(token, { plan: "start" })).invoice);
    const res = await call("POST", "/v1/billing/cancel", token);
    expect(res.json()).toMatchObject({ plan: "start", cancelAtPeriodEnd: true, autoRenew: false });
    // No renewal invoice is made for a cancelled plan.
    await db.db
      .update(subscriptions)
      .set({ endsAt: new Date(Date.now() + 2 * DAY) })
      .where(eq(subscriptions.accountId, accountId));
    expect((await lifecycle.daily()).renewalInvoices).toBe(0);
    expect((await entitlements(token)).entitlements.plan).toBe("start");
    await db.db
      .update(subscriptions)
      .set({ endsAt: new Date(Date.now() - 1000) })
      .where(eq(subscriptions.accountId, accountId));
    expect(await lifecycle.hourly()).toMatchObject({ movedToFree: 1, graceStarted: 0 });
    expect((await entitlements(token)).entitlements.plan).toBe("free");
  });

  it("sells add-ons only on a paid plan: extra AI questions this period, an extra company", async () => {
    const { token, accountId } = await register();
    expect((await call("POST", "/v1/billing/checkout", token, { addon: "addon_ai_100" })).json().code).toBe(
      "ADDON_NOT_AVAILABLE",
    );
    await pay((await checkout(token, { plan: "start" })).invoice);
    const ai = await checkout(token, { addon: "addon_ai_100", promoCode: "ANY" });
    // 390 000 + 12% VAT; a promo never applies to add-ons.
    expect(ai.invoice).toMatchObject({ totalSum: 436_800, discountSum: 0 });
    await pay(ai.invoice);
    expect((await entitlements(token)).entitlements.aiQuestionsPerMonth).toBe(180);
    // Not for a plan it is not sold on: users are Business and Firm only.
    expect((await call("POST", "/v1/billing/checkout", token, { addon: "addon_user" })).json().code).toBe(
      "ADDON_NOT_AVAILABLE",
    );
    const company = await checkout(token, { addon: "addon_company" });
    // Charged for the days left of the month.
    expect(company.invoice.totalSum).toBeLessThanOrEqual(436_800);
    await pay(company.invoice);
    expect((await entitlements(token)).entitlements.companies).toBe(2);
    expect((await subscription(accountId)).status).toBe("active");
  });

  it("applies a promo code: 30% off for 12 months, counted once, and the discount goes on at renewal", async () => {
    const { token, accountId } = await register();
    await db.db
      .insert(promoCodes)
      .values({ code: "LAUNCH30", kind: "percent", value: 30, months: 12, maxUses: 10 });
    expect(
      (await call("POST", "/v1/billing/checkout", token, { plan: "start", promoCode: "nope" })).json().code,
    ).toBe("INVALID_PROMO");
    const quote = (
      await call("POST", "/v1/billing/quote", token, { plan: "start", promoCode: "launch30" })
    ).json();
    // 590 000 - 30% = 413 000, VAT 49 560.
    expect(quote).toMatchObject({
      subtotalSum: 590_000,
      discountSum: 177_000,
      vatSum: 49_560,
      totalSum: 462_560,
    });
    const first = await checkout(token, { plan: "start", promoCode: "LAUNCH30" });
    await pay(first.invoice);
    const [promo] = await db.db.select().from(promoCodes);
    expect(promo?.usedCount).toBe(1);
    const sub = await subscription(accountId);
    expect(sub).toMatchObject({ promoCode: "LAUNCH30", promoMonthsLeft: 11 });

    await db.db
      .update(subscriptions)
      .set({ endsAt: new Date(Date.now() + 5 * DAY) })
      .where(eq(subscriptions.accountId, accountId));
    await lifecycle.daily();
    const renewal = (await call("GET", "/v1/billing/invoices", token))
      .json()
      .find((i: { status: string }) => i.status === "pending");
    expect(renewal.discountSum).toBe(177_000);
    await pay(renewal);
    expect(await subscription(accountId)).toMatchObject({ promoMonthsLeft: 10 });
    expect((await db.db.select().from(promoCodes))[0]?.usedCount).toBe(1);
  });

  it("sends reminders 7 and 1 days before the end, once each", async () => {
    const { token, accountId } = await register();
    await pay((await checkout(token, { plan: "start" })).invoice);
    await db.db
      .update(subscriptions)
      .set({ endsAt: new Date(Date.now() + 6.5 * DAY) })
      .where(eq(subscriptions.accountId, accountId));
    await lifecycle.daily();
    await lifecycle.daily();
    expect((await events(accountId)).filter((e) => e === "reminder_renewal")).toHaveLength(1);
    await db.db
      .update(subscriptions)
      .set({ endsAt: new Date(Date.now() + 0.5 * DAY) })
      .where(eq(subscriptions.accountId, accountId));
    await lifecycle.daily();
    expect((await events(accountId)).filter((e) => e === "reminder_renewal")).toHaveLength(2);
  });

  it("owner-only billing routes refuse a member", async () => {
    const { token } = await register();
    await call("POST", "/v1/billing/trial", token); // Business trial: room for a second user
    await call("POST", "/v1/users", token, {
      email: "m@example.com",
      name: "Member",
      password: "member-password-1",
    });
    const member = (
      await call("POST", "/v1/auth/login", undefined, {
        email: "m@example.com",
        password: "member-password-1",
      })
    ).json();
    expect(
      (await call("POST", "/v1/billing/checkout", member.accessToken, { plan: "start" })).statusCode,
    ).toBe(403);
    expect((await call("GET", "/v1/billing/entitlements", member.accessToken)).statusCode).toBe(200);
  });

  // --- the admin dashboard's billing ------------------------------------------------------------

  const adminToken = async () =>
    (
      await call("POST", "/v1/admin/login", undefined, {
        email: "boss@platform.uz",
        password: "admin-password-123",
      })
    ).json().accessToken as string;
  const adminCall = (method: "GET" | "POST" | "PUT", url: string, token: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as object }),
      headers: { authorization: `Bearer ${token}` },
    });

  it("lets an owner edit a plan's price and limits, which the public catalog shows at once", async () => {
    const admin = await adminToken();
    const view = (await adminCall("GET", "/v1/admin/billing/plans", admin)).json();
    expect(view.plans.map((p: { code: string }) => p.code)).toContain("trial");
    const start = view.plans.find((p: { code: string }) => p.code === "start");
    const saved = await adminCall("PUT", "/v1/admin/plans/start", admin, {
      ...start,
      priceMonthSum: 650_000,
      companies: 2,
      isPublic: true,
    });
    expect(saved.statusCode).toBe(200);
    const catalog = (await call("GET", "/v1/plans")).json();
    expect(catalog.plans.find((p: { code: string }) => p.code === "start")).toMatchObject({
      priceMonthSum: 650_000,
      companies: 2,
    });
    // A hand-made plan stays out of the public list.
    await adminCall("PUT", "/v1/admin/plans/custom", admin, {
      ...start,
      name: "Custom",
      companies: 25,
      isPublic: false,
    });
    expect((await call("GET", "/v1/plans")).json().plans.map((p: { code: string }) => p.code)).not.toContain(
      "custom",
    );
    // Put it back for the other tests.
    await adminCall("PUT", "/v1/admin/plans/start", admin, {
      ...start,
      priceMonthSum: 590_000,
      companies: 1,
    });
  });

  it("always works the yearly price out of the monthly one (12 for 10), whatever the form sends for it", async () => {
    const admin = await adminToken();
    const start = (await adminCall("GET", "/v1/admin/billing/plans", admin))
      .json()
      .plans.find((p: { code: string }) => p.code === "start");
    const yearOf = async () =>
      (await call("GET", "/v1/plans")).json().plans.find((p: { code: string }) => p.code === "start")
        .priceYearSum;
    await adminCall("PUT", "/v1/admin/plans/start", admin, {
      ...start,
      priceMonthSum: 899_000,
      priceYearSum: 899_000,
      isPublic: true,
    });
    expect(await yearOf()).toBe(8_990_000);
    await adminCall("PUT", "/v1/admin/plans/start", admin, {
      ...start,
      priceMonthSum: 700_000,
      priceYearSum: 0,
      isPublic: true,
    });
    expect(await yearOf()).toBe(7_000_000);
    await adminCall("PUT", "/v1/admin/plans/start", admin, { ...start, isPublic: true });
  });

  it("changes a plan, extends it, grants an add-on and marks a bank transfer paid from the admin, with a reason in the audit log", async () => {
    const admin = await adminToken();
    const { token, accountId } = await register();
    const sub = await subscription(accountId);
    expect(
      (await adminCall("POST", `/v1/admin/subscriptions/${sub.id}/extend`, admin, { days: 10 })).json().code,
    ).toBe("FREE_HAS_NO_PERIOD");

    const bank = await checkout(token, { plan: "business", cycle: "month", provider: "bank" });
    const paid = await adminCall("POST", `/v1/admin/subscriptions/${sub.id}/extend`, admin, {
      markPaidInvoiceId: bank.invoice.id,
      reason: "bank transfer 12 Oct",
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().subscription).toMatchObject({ plan: "business", status: "active" });
    expect(paid.json().invoices[0]).toMatchObject({ status: "paid" });
    // Marking it again changes nothing.
    const endBefore = (await subscription(accountId)).endsAt;
    await adminCall("POST", `/v1/admin/subscriptions/${sub.id}/extend`, admin, {
      markPaidInvoiceId: bank.invoice.id,
    });
    expect((await subscription(accountId)).endsAt).toEqual(endBefore);

    await adminCall("POST", `/v1/admin/subscriptions/${sub.id}/extend`, admin, {
      days: 15,
      reason: "goodwill",
    });
    expect((await subscription(accountId)).endsAt.getTime()).toBe(endBefore.getTime() + 15 * DAY);
    const granted = await adminCall("POST", `/v1/admin/subscriptions/${sub.id}/extend`, admin, {
      addon: "addon_ai_100",
      reason: "support",
    });
    expect(granted.json().addons).toHaveLength(1);
    expect((await entitlements(token)).entitlements.aiQuestionsPerMonth).toBe(350);

    const comped = await adminCall("POST", `/v1/admin/subscriptions/${sub.id}/extend`, admin, {
      plan: "firm",
      reason: "partner",
    });
    expect(comped.json().subscription.plan).toBe("firm");
    expect((await entitlements(token)).entitlements).toMatchObject({ plan: "firm", companies: 10 });
    expect((await adminCall("POST", `/v1/admin/subscriptions/${sub.id}/extend`, admin, {})).statusCode).toBe(
      400,
    );

    const list = (await adminCall("GET", "/v1/admin/subscriptions?plan=firm", admin)).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ accountId, plan: "firm", paidInvoices: 1 });
    const detail = (await adminCall("GET", `/v1/admin/subscriptions/by-account/${accountId}`, admin)).json();
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining([
        "invoice_paid",
        "extended_by_admin",
        "plan_set_by_admin",
        "addon_granted_by_admin",
      ]),
    );
    const audit = (await adminCall("GET", `/v1/admin/accounts/${accountId}`, admin)).json().audit;
    expect(audit.map((a: { action: string }) => a.action)).toContain("subscription.plan");
  });

  it("reports revenue: MRR by plan, conversion, collected money and overdue invoices", async () => {
    const admin = await adminToken();
    const a = await register("a@example.com");
    const b = await register("b@example.com");
    await register("c@example.com"); // stays Free
    await pay((await checkout(a.token, { plan: "business" })).invoice);
    await pay((await checkout(b.token, { plan: "start", cycle: "year" })).invoice);
    // An unpaid invoice past its due date.
    const open = await checkout(b.token, { addon: "addon_ai_100" });
    await db.db
      .update(invoices)
      .set({ dueAt: new Date(Date.now() - DAY) })
      .where(eq(invoices.id, open.invoice.id));

    const report = (await adminCall("GET", "/v1/admin/revenue", admin)).json();
    // Business 1 690 000 + Start yearly 5 900 000 / 12.
    expect(report.mrrSum).toBe(1_690_000 + Math.round(5_900_000 / 12));
    expect(report).toMatchObject({
      accounts: 3,
      paidAccounts: 2,
      freeAccounts: 1,
      trialAccounts: 0,
      conversionPercent: 66.7,
    });
    expect(report.byPlan.find((p: { plan: string }) => p.plan === "business")).toMatchObject({
      accounts: 1,
      mrrSum: 1_690_000,
    });
    expect(report.collected30dSum).toBeGreaterThan(1_690_000);
    expect(report.overdue).toMatchObject({ count: 1 });
    expect(report.overdue.items[0].accountName).toBe("Buxgalter MChJ");
  });

  it("manages promo codes: an owner creates and disables them, and a disabled code stops working", async () => {
    const admin = await adminToken();
    const { token } = await register();
    const made = await adminCall("POST", "/v1/admin/promo-codes", admin, {
      code: "launch30",
      kind: "percent",
      value: 30,
      months: 12,
      maxUses: 10,
    });
    expect(made.statusCode).toBe(200);
    expect(made.json()[0]).toMatchObject({ code: "LAUNCH30", months: 12, usedCount: 0, disabled: false });
    expect(
      (
        await adminCall("POST", "/v1/admin/promo-codes", admin, {
          code: "LAUNCH30",
          kind: "percent",
          value: 5,
        })
      ).json().code,
    ).toBe("PROMO_EXISTS");
    expect(
      (await adminCall("POST", "/v1/admin/promo-codes", admin, { code: "BIG", kind: "percent", value: 150 }))
        .statusCode,
    ).toBe(400);
    expect(
      (await call("POST", "/v1/billing/quote", token, { plan: "start", promoCode: "LAUNCH30" })).json()
        .discountSum,
    ).toBe(177_000);
    await adminCall("POST", "/v1/admin/promo-codes/LAUNCH30/disable", admin);
    expect(
      (await call("POST", "/v1/billing/quote", token, { plan: "start", promoCode: "LAUNCH30" })).json().code,
    ).toBe("INVALID_PROMO");
    await adminCall("POST", "/v1/admin/promo-codes/LAUNCH30/enable", admin);
    expect((await adminCall("GET", "/v1/admin/promo-codes", admin)).json()[0].disabled).toBe(false);
  });

  it("keeps support staff out of plan, promo and add-on editing", async () => {
    const boss = await adminToken();
    await adminCall("POST", "/v1/admin/admins", boss, {
      email: "support@platform.uz",
      name: "Support",
      password: "support-password-1",
      role: "support",
    });
    const support = (
      await call("POST", "/v1/admin/login", undefined, {
        email: "support@platform.uz",
        password: "support-password-1",
      })
    ).json().accessToken as string;
    expect((await adminCall("GET", "/v1/admin/billing/plans", support)).statusCode).toBe(200);
    expect((await adminCall("PUT", "/v1/admin/plans/start", support, {})).statusCode).toBe(403);
    expect(
      (await adminCall("POST", "/v1/admin/promo-codes", support, { code: "NOPE", kind: "percent", value: 5 }))
        .statusCode,
    ).toBe(403);
    await db.sql`DELETE FROM admins WHERE email = 'support@platform.uz'`;
  });

  it("counts a heavy job as several AI questions, one more for each further 0.50 USD it costs", async () => {
    // Each model step of this one costs about $0.40 (200 000 input tokens at $2 per million).
    const heavyModel = {
      async turn(_p: BetaMessageStreamParams, { onText }: { onText: (text: string) => void }) {
        onText("ok");
        return {
          model: "claude-sonnet-5-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "ok" }],
          usage: {
            input_tokens: 200_000,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        } as unknown as BetaMessage;
      },
    };
    const heavy = await buildApp(db.db, config, { aiModel: heavyModel });
    try {
      const { token } = await register();
      const step = (messages: unknown[]) =>
        heavy.inject({
          method: "POST",
          url: "/v1/ai/chat",
          payload: { company: "X", messages } as object,
          headers: { authorization: `Bearer ${token}` },
        });
      const used = async () => (await entitlements(token)).usage.aiQuestions as number;
      const asked = [{ role: "user", content: "import the Didox contracts" }];
      const reading = (n: number) => [
        { role: "assistant", content: [{ type: "tool_use", id: `t${n}`, name: "x", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: "rows" }] },
      ];
      expect((await step(asked)).statusCode).toBe(200);
      expect(await used()).toBe(1); // $0.40: still one question
      expect((await step([...asked, ...reading(1)])).statusCode).toBe(200);
      expect(await used()).toBe(2); // $0.80
      expect((await step([...asked, ...reading(1), ...reading(2)])).statusCode).toBe(200);
      expect(await used()).toBe(3); // $1.20
      // A different question starts again at one.
      expect((await step([{ role: "user", content: "another question" }])).statusCode).toBe(200);
      expect(await used()).toBe(4);
    } finally {
      await heavy.close();
    }
  });

  it("tells customers the AI is unavailable (not the provider's billing text), and alerts the admin until it works again", async () => {
    const broken = {
      async turn() {
        throw new Anthropic.BadRequestError(
          400,
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "Your credit balance is too low to access the Anthropic API.",
            },
          },
          "400 Your credit balance is too low to access the Anthropic API.",
          new Headers(),
        );
      },
    };
    const down = await buildApp(db.db, config, { aiModel: broken });
    try {
      const { token } = await register();
      const res = await down.inject({
        method: "POST",
        url: "/v1/ai/chat",
        payload: { company: "X", messages: [{ role: "user", content: "?" }] },
        headers: { authorization: `Bearer ${token}` },
      });
      const events = res.body
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { type: string; code?: string; message?: string });
      const error = events.find((e) => e.type === "error");
      expect(error?.code).toBe("AI_OUT_OF_SERVICE");
      expect(error?.message).not.toMatch(/credit|anthropic/i);
      // The question never got an answer: it is not charged.
      expect((await entitlements(token)).usage.aiQuestions).toBe(0);
      const adminToken_ = (
        await call("POST", "/v1/admin/login", undefined, {
          email: "boss@platform.uz",
          password: "admin-password-123",
        })
      ).json().accessToken as string;
      const overview = (await call("GET", "/v1/admin/overview", adminToken_)).json();
      expect(overview.aiAlert).toMatchObject({ code: "AI_PROVIDER_BILLING" });
      expect(overview.aiAlert.message).toContain("credit balance");

      // The same server, once the provider answers again, clears the alert.
      const ok = await buildApp(db.db, config, { aiModel: fakeModel });
      try {
        const res2 = await ok.inject({
          method: "POST",
          url: "/v1/ai/chat",
          payload: { company: "X", messages: [{ role: "user", content: "?" }] },
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res2.statusCode).toBe(200);
        expect((await call("GET", "/v1/admin/overview", adminToken_)).json().aiAlert).toBeNull();
      } finally {
        await ok.close();
      }
    } finally {
      await down.close();
    }
  });

  it("records how long each model step took, and the calls and 429s behind it", async () => {
    const timed = {
      async turn(
        _p: BetaMessageStreamParams,
        { onText, onTiming }: { onText: (text: string) => void; onTiming?: (t: object) => void },
      ) {
        onText("ok");
        onTiming?.({ durationMs: 1234, firstTokenMs: 321, attempts: 3, rateLimited: 2 });
        return {
          model: "claude-sonnet-5-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "ok" }],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        } as unknown as BetaMessage;
      },
    };
    const timedApp = await buildApp(db.db, config, { aiModel: timed });
    try {
      const { token } = await register();
      await timedApp.inject({
        method: "POST",
        url: "/v1/ai/chat",
        payload: { company: "X", messages: [{ role: "user", content: "?" }] },
        headers: { authorization: `Bearer ${token}` },
      });
      const [row] = await db.db.select().from(aiUsage);
      expect(row).toMatchObject({ durationMs: 1234, firstTokenMs: 321, attempts: 3, rateLimited: 2 });
      const adminToken_ = (
        await call("POST", "/v1/admin/login", undefined, {
          email: "boss@platform.uz",
          password: "admin-password-123",
        })
      ).json().accessToken as string;
      const cost = (await call("GET", "/v1/admin/ai-cost?days=7", adminToken_)).json();
      expect(cost.topQuestions[0]).toMatchObject({ seconds: 1, rateLimited: 2 });
    } finally {
      await timedApp.close();
    }
  });
});
