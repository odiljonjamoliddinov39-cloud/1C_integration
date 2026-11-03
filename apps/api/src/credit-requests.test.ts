import { generateKeyPairSync } from "node:crypto";

import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, runMigrations } from "./db/client.js";
import { creditAccounts, creditRequests, invoices, plans, subscriptions } from "./db/schema.js";

// Needs PostgreSQL (CI starts one). Each run gets a fresh database.
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const TEST_DB = "platform_credit_requests_test";
const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
const available = await admin`select 1`.then(() => true).catch(() => false);

const { privateKey } = generateKeyPairSync("ed25519");
const account = {
  email: "owner@example.com",
  password: "correct-horse-battery",
  name: "Owner",
  accountName: "Buxgalter MChJ",
};

describe.skipIf(!available)("credit purchase requests and Restart payments", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    const url = ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`);
    db = createDb(url);
    await runMigrations(db.db);
    const config = loadConfig({
      DATABASE_URL: url,
      JWT_SECRET: "test-secret-that-is-long-enough-1234567890",
      LICENSE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      LOG_LEVEL: process.env.TEST_LOG ?? "silent",
      AUTH_RATE_PER_MINUTE: "1000",
      ENTITLEMENTS_CACHE_SECONDS: "0",
      BILLING_JOBS: "off",
      OFFER_REQUIRED: "off",
      ADMIN_EMAIL: "boss@platform.uz",
      ADMIN_PASSWORD: "admin-password-123",
    });
    const fetchCbu = (async () =>
      new Response(JSON.stringify([{ Rate: "11839", Ccy: "USD" }]), {
        status: 200,
      })) as unknown as typeof fetch;
    app = await buildApp(db.db, config, { fetch: fetchCbu });
  });

  beforeEach(async () => {
    await db.sql`TRUNCATE accounts, refresh_tokens CASCADE`;
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
  /** Bought credits are the extra balance. */
  const setBalance = (accountId: string, extra: number) =>
    db.db
      .insert(creditAccounts)
      .values({ accountId, extraCredits: extra })
      .onConflictDoUpdate({ target: creditAccounts.accountId, set: { extraCredits: extra } });
  const balanceOf = async (accountId: string) =>
    (await db.db.query.creditAccounts.findFirst({ where: eq(creditAccounts.accountId, accountId) }))
      ?.extraCredits ?? 0;
  const adminToken = async () =>
    (
      await call("POST", "/v1/admin/login", undefined, {
        email: "boss@platform.uz",
        password: "admin-password-123",
      })
    ).json().accessToken as string;
  /** A paying customer with a known balance. */
  const payingCustomer = async (balance = 1_000, email = account.email) => {
    const reg = await register(email);
    await setPlan(reg.accountId, "start");
    await call("GET", "/v1/billing/credits", reg.token);
    await setBalance(reg.accountId, balance);
    return reg;
  };

  it("does not sell credits online when approval is on: the customer sends a request instead", async () => {
    const { token } = await payingCustomer();
    const view = (await call("GET", "/v1/billing/credits", token)).json();
    expect(view.approvalRequired).toBe(true);
    const bought = await call("POST", "/v1/billing/credits/purchase", token, {
      sum: 100_000,
      provider: "bank",
    });
    expect(bought.statusCode).toBe(409);
    expect(bought.json().code).toBe("APPROVAL_REQUIRED");
  });

  it("a request waits for the admin; approving adds the credits through a paid invoice, once", async () => {
    const { token, accountId } = await payingCustomer(1_000);
    const sent = await call("POST", "/v1/billing/credits/request", token, { sum: 300_000 });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({
      credits: 1_750,
      status: "pending",
      somPerCredit: 120,
      totalSom: 300_000,
    });
    // Nothing is added yet, and the customer sees the request.
    expect(await balanceOf(accountId)).toBe(1_000);
    const mine = (await call("GET", "/v1/billing/credits", token)).json();
    expect(mine.requests).toHaveLength(1);
    expect(mine.requests[0].status).toBe("pending");

    const a = await adminToken();
    const waiting = (await call("GET", "/v1/admin/credits/requests", a)).json();
    expect(waiting.pendingCount).toBe(1);
    expect(waiting.requests[0]).toMatchObject({
      accountId,
      accountName: "Buxgalter MChJ",
      userEmail: "owner@example.com",
      credits: 1_750,
      balanceCredits: 1_000,
    });
    expect((await call("GET", "/v1/admin/credits", a)).json().pendingRequests).toBe(1);

    const id = waiting.requests[0].id as string;
    const approved = await call("POST", `/v1/admin/credits/requests/${id}/approve`, a, {
      note: "paid by transfer",
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().pendingCount).toBe(0);
    expect(await balanceOf(accountId)).toBe(2_750);
    // Credits the customer asked for are used when the plan's run out, with no step in the cabinet in between.
    const after = (await call("GET", "/v1/billing/credits", token)).json();
    expect(after).toMatchObject({ extraCredits: 2_750, extraEnabled: true, low: false });
    const row = await db.db.query.creditRequests.findFirst({ where: eq(creditRequests.id, id) });
    expect(row).toMatchObject({ status: "approved", note: "paid by transfer" });
    expect(row?.invoiceId).toBeTruthy();
    const invoice = await db.db.query.invoices.findFirst({ where: eq(invoices.id, row!.invoiceId!) });
    expect(invoice).toMatchObject({ status: "paid", provider: "bank", totalSum: 300_000 });

    // The second approval changes nothing.
    const again = await call("POST", `/v1/admin/credits/requests/${id}/approve`, a, {});
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("NOT_PENDING");
    expect(await balanceOf(accountId)).toBe(2_750);
    expect((await call("GET", "/v1/billing/credits", token)).json().requests[0].status).toBe("approved");
  });

  it("a rejected request adds nothing and keeps the admin's note", async () => {
    const { token, accountId } = await payingCustomer(1_000);
    const sent = (await call("POST", "/v1/billing/credits/request", token, { sum: 100_000 })).json();
    const a = await adminToken();
    const rejected = await call("POST", `/v1/admin/credits/requests/${sent.id}/reject`, a, {
      note: "no payment seen",
    });
    expect(rejected.statusCode).toBe(200);
    expect(await balanceOf(accountId)).toBe(1_000);
    const mine = (await call("GET", "/v1/billing/credits", token)).json();
    expect(mine.requests[0]).toMatchObject({ status: "rejected", note: "no payment seen" });
  });

  it("refuses a request on Free, over the cap, below the minimum, and a fourth waiting one", async () => {
    const free = await register("free@example.com");
    const onFree = await call("POST", "/v1/billing/credits/request", free.token, { sum: 100_000 });
    expect(onFree.json().code).toBe("CREDITS_NOT_AVAILABLE");

    const { token } = await payingCustomer(49_500);
    const over = await call("POST", "/v1/billing/credits/request", token, { sum: 100_000 });
    expect(over.json().code).toBe("CREDIT_CAP");
    expect((await call("POST", "/v1/billing/credits/request", token, { sum: 100 })).statusCode).toBe(400);

    await db.db.update(creditAccounts).set({ extraCredits: 0 });
    for (let i = 0; i < 3; i++) {
      expect((await call("POST", "/v1/billing/credits/request", token, { sum: 100_000 })).statusCode).toBe(
        200,
      );
    }
    const fourth = await call("POST", "/v1/billing/credits/request", token, { sum: 100_000 });
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().code).toBe("TOO_MANY_REQUESTS");
  });

  it("the customer can take back a waiting request", async () => {
    const { token } = await payingCustomer();
    const sent = (await call("POST", "/v1/billing/credits/request", token, { sum: 100_000 })).json();
    const cancelled = await call("POST", `/v1/billing/credits/requests/${sent.id}/cancel`, token);
    expect(cancelled.json().status).toBe("cancelled");
    expect((await call("POST", `/v1/billing/credits/requests/${sent.id}/cancel`, token)).json().code).toBe(
      "NOT_PENDING",
    );
  });

  it("an approval that cannot be applied leaves the request waiting", async () => {
    const { token, accountId } = await payingCustomer(1_000);
    const sent = (await call("POST", "/v1/billing/credits/request", token, { sum: 100_000 })).json();
    await setPlan(accountId, "free"); // the customer dropped to Free meanwhile
    const a = await adminToken();
    const approved = await call("POST", `/v1/admin/credits/requests/${sent.id}/approve`, a, {});
    expect(approved.statusCode).toBe(409);
    expect(approved.json().code).toBe("CREDITS_NOT_AVAILABLE");
    expect(await balanceOf(accountId)).toBe(1_000);
    const row = await db.db.query.creditRequests.findFirst({ where: eq(creditRequests.id, sent.id) });
    expect(row?.status).toBe("pending");
    expect(await db.db.select().from(invoices).where(eq(invoices.accountId, accountId))).toHaveLength(0);
  });

  it("Restart payments cancels unpaid invoices and waiting requests, and keeps what was paid", async () => {
    const { token, accountId } = await payingCustomer(1_000);
    await call("POST", "/v1/billing/credits/request", token, { sum: 100_000 });
    const paid = (await call("POST", "/v1/billing/credits/request", token, { sum: 100_000 })).json();
    const a = await adminToken();
    await call("POST", `/v1/admin/credits/requests/${paid.id}/approve`, a, {});
    expect(await balanceOf(accountId)).toBe(1_583);
    // An unpaid invoice left from a payment that was never finished.
    await db.db.insert(invoices).values({
      accountId,
      items: [],
      intent: { type: "credits", credits: 1_000 },
      subtotalSum: 120_000,
      discountSum: 0,
      vatSum: 0,
      totalSum: 120_000,
      provider: "payme",
      dueAt: new Date(Date.now() + 86_400_000),
    });

    expect((await call("POST", `/v1/admin/credits/${accountId}/restart-payments`)).statusCode).toBe(401);
    const restarted = await call("POST", `/v1/admin/credits/${accountId}/restart-payments`, a);
    expect(restarted.statusCode).toBe(200);
    expect(restarted.json()).toEqual({ cancelledInvoices: 1, cancelledRequests: 1 });

    const all = await db.db.select().from(invoices).where(eq(invoices.accountId, accountId));
    expect(all.map((i) => i.status).sort()).toEqual(["cancelled", "paid"]);
    expect((await call("GET", "/v1/admin/credits/requests", a)).json().pendingCount).toBe(0);
    expect(await balanceOf(accountId)).toBe(1_583);
    // The customer can begin again.
    expect((await call("POST", "/v1/billing/credits/request", token, { sum: 100_000 })).statusCode).toBe(200);
    // A second restart on a clean account has nothing to clear.
    await call("POST", `/v1/admin/credits/${accountId}/restart-payments`, a);
    expect((await call("POST", `/v1/admin/credits/${accountId}/restart-payments`, a)).json()).toEqual({
      cancelledInvoices: 0,
      cancelledRequests: 0,
    });
  });

  it("an unknown account cannot be restarted", async () => {
    const a = await adminToken();
    const res = await call(
      "POST",
      "/v1/admin/credits/3f2c7c0e-6f0f-4f0e-9d0e-5a1b2c3d4e5f/restart-payments",
      a,
    );
    expect(res.statusCode).toBe(404);
  });
});
