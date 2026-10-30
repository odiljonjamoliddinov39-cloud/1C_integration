import { generateKeyPairSync } from "node:crypto";

import { OFFER_VERSION } from "@platform/shared";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, runMigrations } from "./db/client.js";
import { offerAcceptances, plans, subscriptions } from "./db/schema.js";

// Needs PostgreSQL (CI starts one). Each run gets a fresh database.
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const TEST_DB = "platform_offer_test";
const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
const available = await admin`select 1`.then(() => true).catch(() => false);

const { privateKey } = generateKeyPairSync("ed25519");
const account = {
  email: "owner@example.com",
  password: "correct-horse-battery",
  name: "Owner",
  accountName: "Buxgalter MChJ",
};

describe.skipIf(!available)("the public offer", () => {
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
    });
    app = await buildApp(db.db, config, {});
  });

  beforeEach(async () => {
    await db.sql`TRUNCATE accounts, refresh_tokens CASCADE`;
  });

  afterAll(async () => {
    await app?.close();
    await db?.sql.end();
    await admin.end();
  });

  const call = (method: "GET" | "POST", url: string, token: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as object }),
      headers: { authorization: `Bearer ${token}`, "user-agent": "vitest" },
    });
  const register = async (email = account.email) => {
    const reg = (
      await app.inject({ method: "POST", url: "/v1/auth/register", payload: { ...account, email } })
    ).json();
    return { token: reg.accessToken as string, accountId: reg.me.account.id as string };
  };
  const checkout = (token: string) =>
    call("POST", "/v1/billing/checkout", token, { plan: "start", cycle: "month", provider: "bank" });

  it("refuses to sell a plan until the owner accepts the offer, and sells after", async () => {
    const { token } = await register();
    expect((await call("GET", "/v1/billing/offer", token)).json()).toMatchObject({
      version: OFFER_VERSION,
      accepted: false,
      required: true,
    });
    const refused = await checkout(token);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("OFFER_NOT_ACCEPTED");

    const accepted = await call("POST", "/v1/billing/offer/accept", token, {
      version: OFFER_VERSION,
      locale: "ru",
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ accepted: true });
    expect((await checkout(token)).statusCode).toBe(200);
  });

  it("refuses the other ways to buy too: credits, a plan change and paying an invoice", async () => {
    const { token, accountId } = await register();
    const plan = await db.db.query.plans.findFirst({ where: eq(plans.code, "start") });
    await db.db
      .update(subscriptions)
      .set({ planId: plan!.id, status: "active", endsAt: new Date(Date.now() + 20 * 86_400_000) })
      .where(eq(subscriptions.accountId, accountId));
    const codes = [
      await call("POST", "/v1/billing/credits/purchase", token, { credits: 1000, provider: "bank" }),
      await call("POST", "/v1/billing/change-plan", token, { plan: "business", provider: "bank" }),
      await call("POST", "/v1/billing/invoices/00000000-0000-4000-8000-000000000000/checkout", token, {
        provider: "bank",
      }),
    ].map((r) => r.json().code);
    expect(codes).toEqual(["OFFER_NOT_ACCEPTED", "OFFER_NOT_ACCEPTED", "OFFER_NOT_ACCEPTED"]);
  });

  it("keeps who accepted, which version, in which language, and does not write a second row", async () => {
    const { token, accountId } = await register();
    await call("POST", "/v1/billing/offer/accept", token, { version: OFFER_VERSION, locale: "uz" });
    await call("POST", "/v1/billing/offer/accept", token, { version: OFFER_VERSION, locale: "ru" });
    const rows = await db.db.select().from(offerAcceptances).where(eq(offerAcceptances.accountId, accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: OFFER_VERSION, locale: "uz", userAgent: "vitest" });
    expect(rows[0]?.ip).toBeTruthy();
  });

  it("asks again for a text that changed: an old version cannot be accepted", async () => {
    const { token } = await register();
    const res = await call("POST", "/v1/billing/offer/accept", token, {
      version: "2020-01-01",
      locale: "uz",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("OFFER_CHANGED");
    expect((await checkout(token)).json().code).toBe("OFFER_NOT_ACCEPTED");
  });

  it("is only for the owner and needs a sign-in", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/offer/accept",
      payload: { version: OFFER_VERSION, locale: "uz" },
    });
    expect(res.statusCode).toBe(401);
  });
});
