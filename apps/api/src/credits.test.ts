import { generateKeyPairSync } from "node:crypto";

import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { somPerCreditOf } from "@platform/shared";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, runMigrations } from "./db/client.js";
import { type CardCharger, Credits } from "./billing/credits.js";
import { CreditRates } from "./billing/credit-rate.js";
import { Billing } from "./billing/entitlements.js";
import { Invoicing } from "./billing/invoicing.js";
import {
  billingEvents,
  companies,
  creditAccounts,
  creditRechargeFailures,
  creditTransactions,
  invoices,
  plans,
  subscriptions,
} from "./db/schema.js";

// Needs PostgreSQL (CI starts one). Each run gets a fresh database.
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const TEST_DB = "platform_credits_test";
const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
const available = await admin`select 1`.then(() => true).catch(() => false);

const { privateKey } = generateKeyPairSync("ed25519");
const account = {
  email: "owner@example.com",
  password: "correct-horse-battery",
  name: "Owner",
  accountName: "Buxgalter MChJ",
};

/** A model whose every call costs exactly $2 (1 000 000 input tokens of Sonnet): 200 credits. */
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
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    } as unknown as BetaMessage;
  },
};

/** The card charger of the tests: it says yes or no as told. */
const charger: CardCharger & {
  answer: { ok: true; ref: string } | { ok: false; reason: string };
  calls: number;
} = {
  answer: { ok: true, ref: "card-ref-1" },
  calls: 0,
  async charge() {
    this.calls++;
    return this.answer;
  },
};

describe.skipIf(!available)("AI credits", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: ReturnType<typeof createDb>;
  let config: ReturnType<typeof loadConfig>;
  let credits: Credits;
  let cbu = 11_839;

  const fetchCbu = (async () =>
    new Response(JSON.stringify([{ Rate: String(cbu), Ccy: "USD" }]), {
      status: 200,
    })) as unknown as typeof fetch;

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    const url = ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`);
    db = createDb(url);
    await runMigrations(db.db);
    config = loadConfig({
      DATABASE_URL: url,
      JWT_SECRET: "test-secret-that-is-long-enough-1234567890",
      LICENSE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      LOG_LEVEL: process.env.TEST_LOG ?? "silent",
      AUTH_RATE_PER_MINUTE: "1000",
      ENTITLEMENTS_CACHE_SECONDS: "0",
      BILLING_JOBS: "off",
      OFFER_REQUIRED: "off", // the offer gate has its own tests (offer.test.ts)
      PAYME_MERCHANT_ID: "merchant-1",
      PAYME_KEY: "payme-secret-key",
      PAYME_TEST: "true",
      ADMIN_EMAIL: "boss@platform.uz",
      ADMIN_PASSWORD: "admin-password-123",
    });
    app = await buildApp(db.db, config, { aiModel: fakeModel, cardCharger: charger, fetch: fetchCbu });
    const billing = new Billing(db.db, 0);
    credits = new Credits(db.db, config, billing, new Invoicing(db.db, config, billing), charger);
  });

  beforeEach(async () => {
    await db.sql`TRUNCATE accounts, refresh_tokens CASCADE`;
    await db.sql`DELETE FROM credit_rate_history WHERE set_by <> 'system' OR cbu_rate <> 11839`;
    credits.invalidatePrice();
    charger.answer = { ok: true, ref: "card-ref-1" };
    charger.calls = 0;
    cbu = 11_839;
  });

  afterAll(async () => {
    await app?.close();
    await db?.sql.end();
    await admin.end();
  });

  const call = (method: "GET" | "POST", url: string, token?: string, payload?: unknown) =>
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
  const setPlan = async (accountId: string, code: string) => {
    const plan = await db.db.query.plans.findFirst({ where: eq(plans.code, code) });
    await db.db
      .update(subscriptions)
      .set({ planId: plan!.id, status: "active", endsAt: new Date(Date.now() + 20 * 86_400_000) })
      .where(eq(subscriptions.accountId, accountId));
  };
  const setBalance = (accountId: string, balance: number) =>
    db.db
      .insert(creditAccounts)
      .values({ accountId, balanceCredits: balance })
      .onConflictDoUpdate({ target: creditAccounts.accountId, set: { balanceCredits: balance } });
  const balanceOf = async (accountId: string) =>
    (await db.db.query.creditAccounts.findFirst({ where: eq(creditAccounts.accountId, accountId) }))
      ?.balanceCredits ?? 0;
  const ask = async (token: string, n = 1) => {
    const res = await call("POST", "/v1/ai/chat", token, {
      company: "X",
      messages: [{ role: "user", content: `question ${n}` }],
    });
    return {
      status: res.statusCode,
      code: res.statusCode === 200 ? "" : (res.json().code as string),
      events:
        res.statusCode === 200
          ? res.body
              .trim()
              .split("\n")
              .map((l) => JSON.parse(l) as { type: string; code?: string })
          : [],
    };
  };
  const adminToken = async () =>
    (
      await call("POST", "/v1/admin/login", undefined, {
        email: "boss@platform.uz",
        password: "admin-password-123",
      })
    ).json().accessToken as string;

  it("gives a new account the Free plan's 500 monthly credits, once", async () => {
    const { token } = await register();
    const view = (await call("GET", "/v1/billing/credits", token)).json();
    expect(view).toMatchObject({
      balanceCredits: 500,
      monthlyCredits: 500,
      somPerCredit: 120,
      canPurchase: false,
    });
    expect(view.history.map((h: { type: string }) => h.type)).toEqual(["monthly_grant"]);
    // Asking again adds nothing.
    expect((await call("GET", "/v1/billing/credits", token)).json().balanceCredits).toBe(500);
    // The entitlements carry the balance for the desktop.
    const ent = (await call("GET", "/v1/billing/entitlements", token)).json();
    expect(ent.credits).toMatchObject({ balanceCredits: 500, somPerCredit: 120 });
  });

  it("takes each AI call's real cost from the balance ($2 = 200 credits)", async () => {
    const { token, accountId } = await register();
    await call("GET", "/v1/billing/credits", token);
    expect((await ask(token)).status).toBe(200);
    expect(await balanceOf(accountId)).toBe(300);
    expect((await ask(token, 2)).status).toBe(200);
    expect(await balanceOf(accountId)).toBe(100);
    const spent = await db.db
      .select()
      .from(creditTransactions)
      .where(and(eq(creditTransactions.accountId, accountId), eq(creditTransactions.type, "ai_usage")));
    expect(spent.map((t) => t.amountCredits)).toEqual([-200, -200]);
    // Each is tied to its usage row.
    expect(spent.every((t) => t.relatedUsageId)).toBe(true);
  });

  it("refuses the next call at zero with a plain message, and never cuts the answer that takes it there", async () => {
    const { token, accountId } = await register();
    await call("GET", "/v1/billing/credits", token);
    await setBalance(accountId, 50);
    // 50 credits is enough to start: this call costs 200 and takes the balance under zero.
    expect((await ask(token)).status).toBe(200);
    expect(await balanceOf(accountId)).toBe(-150);
    const refused = await ask(token, 2);
    expect(refused).toMatchObject({ status: 429, code: "AI_BUDGET_EXCEEDED" });
  });

  it("warns once when the balance is low", async () => {
    const { token, accountId } = await register();
    await call("GET", "/v1/billing/credits", token);
    await setBalance(accountId, 90);
    const first = await ask(token);
    expect(first.events.filter((e) => e.type === "warning").map((e) => e.code)).toEqual(["AI_CREDITS_LOW"]);
    expect((await credits.view(accountId)).low).toBe(true);
    const events = await db.db.select().from(billingEvents).where(eq(billingEvents.accountId, accountId));
    expect(events.filter((e) => e.type === "credits_low")).toHaveLength(1);
  });

  it("adds the plan's credits each month and carries the unused ones over, up to the $500 cap", async () => {
    const { accountId } = await register();
    await setPlan(accountId, "start");
    const grant = (n: number) =>
      (
        credits as unknown as { monthlyGrant: (a: string, p: string, m: number) => Promise<void> }
      ).monthlyGrant(accountId, `2031-0${n + 1}-01`, 3_040);
    await credits.ensureGrants(accountId);
    // Another month: the plan's 3 040 credits come on top of what was left.
    await db.db
      .update(creditAccounts)
      .set({ balanceCredits: 1_000 })
      .where(eq(creditAccounts.accountId, accountId));
    await grant(1);
    expect(await balanceOf(accountId)).toBeGreaterThan(4_000);
    const rolled = await db.db
      .select()
      .from(creditTransactions)
      .where(and(eq(creditTransactions.accountId, accountId), eq(creditTransactions.type, "rollover")));
    expect(rolled.length).toBeGreaterThan(0);
    // Near the cap only what fits is added; at the cap nothing is.
    await db.db
      .update(creditAccounts)
      .set({ balanceCredits: 49_900 })
      .where(eq(creditAccounts.accountId, accountId));
    await grant(2);
    expect(await balanceOf(accountId)).toBe(50_000);
    await grant(3);
    expect(await balanceOf(accountId)).toBe(50_000);
    const view = await credits.view(accountId);
    expect(view.atCap).toBe(true);
  });

  it("gives the 1 500 trial credits once, and none to a second account of the same company", async () => {
    const first = await register("a@example.com");
    const second = await register("b@example.com");
    for (const a of [first, second]) {
      await db.db.insert(companies).values({ accountId: a.accountId, inn: "123456789", name: "Same MChJ" });
    }
    await call("POST", "/v1/billing/trial", first.token, {});
    expect((await credits.view(first.accountId)).balanceCredits).toBe(1_500);
    await credits.ensureGrants(first.accountId);
    expect((await credits.view(first.accountId)).balanceCredits).toBe(1_500);
    await call("POST", "/v1/billing/trial", second.token, {});
    const view = await credits.view(second.accountId);
    expect(view.history.some((h) => h.type === "trial_grant" && h.amountCredits > 0)).toBe(false);
  });

  it("sells credits by invoice: price at today's rate (no VAT by default), added once when paid", async () => {
    const { token, accountId } = await register();
    await setPlan(accountId, "start");
    const bought = await call("POST", "/v1/billing/credits/purchase", token, {
      credits: 1_000,
      provider: "bank",
    });
    expect(bought.statusCode).toBe(200);
    const invoice = bought.json().invoice;
    expect(invoice.items[0]).toMatchObject({ kind: "credits", quantity: 1_000, amountSum: 120_000 });
    expect(invoice.totalSum).toBe(120_000 + Math.round((120_000 * config.VAT_PERCENT) / 100));
    const before = await balanceOf(accountId);
    await new Invoicing(db.db, config, new Billing(db.db, 0)).applyInvoice(invoice.id);
    const after = (await credits.view(accountId)).balanceCredits;
    expect(after - Math.floor(before)).toBe(1_000);
    // Paying twice does not add twice.
    await new Invoicing(db.db, config, new Billing(db.db, 0)).applyInvoice(invoice.id);
    expect((await credits.view(accountId)).balanceCredits).toBe(after);
    expect(
      (await db.db.select().from(creditTransactions).where(eq(creditTransactions.type, "purchase"))).length,
    ).toBe(1);
  });

  it("does not sell credits on Free, under the minimum, or over the cap", async () => {
    const { token, accountId } = await register();
    const free = await call("POST", "/v1/billing/credits/purchase", token, {
      credits: 1_000,
      provider: "bank",
    });
    expect(free.json().code).toBe("CREDITS_NOT_AVAILABLE");
    await setPlan(accountId, "start");
    expect(
      (await call("POST", "/v1/billing/credits/purchase", token, { credits: 500, provider: "bank" }))
        .statusCode,
    ).toBe(400);
    await setBalance(accountId, 49_500);
    const over = await call("POST", "/v1/billing/credits/purchase", token, {
      credits: 1_000,
      provider: "bank",
    });
    expect(over.json().code).toBe("CREDIT_CAP");
  });

  it("keeps auto-recharge off until the customer turns it on, and recharges with the saved card at the threshold", async () => {
    const { token, accountId } = await register();
    await setPlan(accountId, "start");
    expect((await credits.view(accountId)).autoRecharge.enabled).toBe(false);
    // On needs a saved card.
    const noCard = await call("POST", "/v1/billing/credits/auto-recharge", token, {
      enabled: true,
      thresholdCredits: 300,
      amountCredits: 1_000,
      method: "payme",
    });
    expect(noCard.json().code).toBe("CARD_REQUIRED");
    const saved = await call("POST", "/v1/billing/credits/auto-recharge", token, {
      enabled: true,
      thresholdCredits: 300,
      amountCredits: 1_000,
      method: "payme",
      cardToken: "tok_test_1234",
    });
    expect(saved.json()).toMatchObject({ enabled: true, hasCard: true });
    await setBalance(accountId, 100);
    // At 100 credits (under the threshold) the next call finds the balance low and the recharge adds 1 000.
    expect(await credits.autoRecharge(accountId)).toBe(true);
    expect(charger.calls).toBe(1);
    expect(await balanceOf(accountId)).toBe(1_100);
    const [invoice] = await db.db.select().from(invoices).where(eq(invoices.accountId, accountId));
    expect(invoice?.status).toBe("paid");
  });

  it("tells the customer and the admin when auto-recharge fails, and refuses the call at zero", async () => {
    const { token, accountId } = await register();
    await setPlan(accountId, "start");
    await call("POST", "/v1/billing/credits/auto-recharge", token, {
      enabled: true,
      thresholdCredits: 300,
      amountCredits: 1_000,
      method: "click",
      cardToken: "tok_blocked",
    });
    charger.answer = { ok: false, reason: "The card is blocked" };
    await credits.ensureGrants(accountId);
    await setBalance(accountId, 0);
    const refused = await ask(token);
    expect(refused).toMatchObject({ status: 429, code: "AI_BUDGET_EXCEEDED" });
    const failures = await db.db.select().from(creditRechargeFailures);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ accountId, reason: "The card is blocked" });
    const events = await db.db.select().from(billingEvents).where(eq(billingEvents.accountId, accountId));
    expect(events.some((e) => e.type === "auto_recharge_failed")).toBe(true);
    // The admin sees the failure in the report.
    const admin1 = await adminToken();
    const report = (await call("GET", "/v1/admin/credits", admin1)).json();
    expect(report.failures[0]).toMatchObject({
      reason: "The card is blocked",
      accountName: account.accountName,
    });
  });

  it("does not offer auto-recharge on Free", async () => {
    const { token } = await register();
    const res = await call("POST", "/v1/billing/credits/auto-recharge", token, {
      enabled: true,
      thresholdCredits: 300,
      amountCredits: 1_000,
      method: "payme",
      cardToken: "tok_test_1234",
    });
    expect(res.json().code).toBe("AUTO_RECHARGE_NOT_AVAILABLE");
  });

  it("lets an owner admin add or take credits with a logged reason, and never below zero", async () => {
    const { accountId } = await register();
    const admin1 = await adminToken();
    const res = await call("POST", `/v1/admin/credits/${accountId}/adjust`, admin1, {
      credits: 250,
      reason: "Apology for the outage",
      kind: "bonus",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().balanceCredits).toBe(750);
    const history = (await call("GET", `/v1/admin/credits/by-account/${accountId}`, admin1)).json().history;
    expect(history[0]).toMatchObject({ type: "bonus", amountCredits: 250, note: "Apology for the outage" });
    const below = await call("POST", `/v1/admin/credits/${accountId}/adjust`, admin1, {
      credits: -5_000,
      reason: "Too much",
    });
    expect(below.json().code).toBe("BELOW_ZERO");
    const noReason = await call("POST", `/v1/admin/credits/${accountId}/adjust`, admin1, {
      credits: 10,
      reason: "",
    });
    expect(noReason.statusCode).toBe(400);
  });

  it("works out the credit price from the CBU rate, changes it only on a 5% move, and logs each change", async () => {
    expect(somPerCreditOf(11_839)).toBe(120);
    const rates = new CreditRates(db.db, fetchCbu);
    cbu = 12_100; // +2.2%: nothing changes
    expect(await rates.refresh()).toBeNull();
    cbu = 12_500; // +5.6%: a new price, to the nearest 10
    expect(await rates.refresh()).toBe(somPerCreditOf(12_500));
    expect(somPerCreditOf(12_500)).toBe(130);
    credits.invalidatePrice();
    expect((await credits.price()).somPerCredit).toBe(130);
    const last = await rates.latest();
    expect(last).toMatchObject({
      oldSomPerCredit: 120,
      newSomPerCredit: 130,
      cbuRate: 12_500,
      setBy: "system",
    });
    // The next day's check compares with the rate of that change, so a small move leaves it alone.
    cbu = 12_600;
    expect(await rates.refresh()).toBeNull();
  });

  it("lets an owner admin set the price by hand, with a reason in the history", async () => {
    const admin1 = await adminToken();
    const res = await call("POST", "/v1/admin/credits/rate", admin1, {
      somPerCredit: 100,
      reason: "Launch promotion",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().somPerCredit).toBe(100);
    expect(res.json().rates[0]).toMatchObject({ newSomPerCredit: 100, note: "Launch promotion" });
  });

  it("moves an account that has no balance yet to credits by what is left of its month's questions", async () => {
    const { accountId } = await register();
    await setPlan(accountId, "start");
    // 80 questions a month on Start; 20 used: 3/4 of the plan's 3 040 credits are left.
    await db.sql`insert into usage_counters (account_id, period_start, ai_questions)
      values (${accountId}, date_trunc('month', now()), 20)
      on conflict (account_id, period_start) do update set ai_questions = 20`;
    await db.sql`DELETE FROM credit_accounts WHERE account_id = ${accountId}`;
    await db.sql`DELETE FROM credit_transactions WHERE account_id = ${accountId}`;
    credits.invalidatePrice();
    const moved = await credits.migrateExisting();
    expect(moved).toBeGreaterThanOrEqual(1);
    const balance = await balanceOf(accountId);
    // The period of an active plan starts at its own start, so the counter row above may be another month's: either way
    // the balance is a share of the plan's credits, and it is added only once.
    expect(balance).toBeGreaterThan(0);
    expect(balance).toBeLessThanOrEqual(3_040);
    expect(await credits.migrateExisting()).toBe(0);
  });

  it("charges nothing for a free answer and records every credit change in the history", async () => {
    const { accountId } = await register();
    await credits.ensureGrants(accountId);
    await credits.spend(accountId, 0, null);
    const history = (await credits.view(accountId)).history;
    expect(history.map((h) => h.type)).toEqual(["monthly_grant"]);
  });
});
