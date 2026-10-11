import { generateKeyPairSync } from "node:crypto";

import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, runMigrations } from "./db/client.js";
import { companies, plans, subscriptionAddons, subscriptions } from "./db/schema.js";

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
      ADMIN_EMAIL: "boss@platform.uz",
      ADMIN_PASSWORD: "admin-password-123",
    });
    app = await buildApp(db.db, config, { aiModel: fakeModel });
  });

  beforeEach(async () => {
    await db.sql`TRUNCATE accounts, refresh_tokens CASCADE`;
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
});
