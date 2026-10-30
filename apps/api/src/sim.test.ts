import { generateKeyPairSync } from "node:crypto";

import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, runMigrations } from "./db/client.js";
import { plans, subscriptions } from "./db/schema.js";

/**
 * Simulation: many fake accounts acting as users of the AI. Each is on a plan, asks more questions than its plan
 * allows, in the way the desktop app does (a question, then the steps of its answer that carry tool results), and
 * the control system must count every question once, never count a step, stop at the limit with the same code
 * every time, leave every other account alone, and never answer with a server error.
 * Scale with SIM_CASES; the seed with SIM_SEED. Needs PostgreSQL (CI starts one).
 */
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const TEST_DB = "platform_sim_test";
const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
const available = await admin`select 1`.then(() => true).catch(() => false);

const { privateKey } = generateKeyPairSync("ed25519");

const fakeModel = {
  async turn(_params: BetaMessageStreamParams, { onText }: { onText: (text: string) => void }) {
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

/** A small seeded generator, the same as the desktop simulations use. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { int: (a: number, b: number) => Math.floor(next() * (b - a + 1)) + a, next };
}
const scale = Number(process.env.SIM_CASES ?? 1);

describe.skipIf(!available)("simulation: fake accounts use the AI", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    const url = ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`);
    db = createDb(url);
    await runMigrations(db.db);
    const config = loadConfig({
      // These tests cover the older question quota and dollar budget; the credit balance has its own (credits.test.ts).
      AI_CREDITS: "off",
      DATABASE_URL: url,
      JWT_SECRET: "test-secret-that-is-long-enough-1234567890",
      LICENSE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      LOG_LEVEL: process.env.TEST_LOG ?? "silent",
      AUTH_RATE_PER_MINUTE: "100000",
      ENTITLEMENTS_CACHE_SECONDS: "0",
      BILLING_JOBS: "off",
      ADMIN_EMAIL: "boss@platform.uz",
      ADMIN_PASSWORD: "admin-password-123",
    });
    app = await buildApp(db.db, config, { aiModel: fakeModel });
  });

  afterAll(async () => {
    await app?.close();
    await db?.sql.end();
    await admin.end();
  });

  /** Each fake account has its own address, as real users do: the rate limits count by address. */
  const call = (method: "GET" | "POST", url: string, token?: string, payload?: unknown, from = "10.0.0.1") =>
    app.inject({
      method,
      url,
      remoteAddress: from,
      ...(payload === undefined ? {} : { payload: payload as object }),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  it("counts a question once, stops at the plan's limit, keeps accounts apart", async () => {
    const random = rng(Number(process.env.SIM_SEED ?? 20261021) + 200);
    // The big plans allow hundreds of questions: the limits are cut to a few dozen so that every plan is run past its
    // limit in a moment (the route also limits one address to 120 requests a minute, which real users never meet).
    const all = await db.db.select().from(plans);
    const catalog = {
      plans: await Promise.all(
        all.map(async (p, k) => {
          const limit =
            p.aiQuestionsPerMonth > 0 && p.aiQuestionsPerMonth <= 30 ? p.aiQuestionsPerMonth : 12 + k * 7;
          if (limit !== p.aiQuestionsPerMonth)
            await db.db.update(plans).set({ aiQuestionsPerMonth: limit }).where(eq(plans.id, p.id));
          return { code: p.code, aiQuestionsPerMonth: limit as number | null };
        }),
      ),
    };
    const accounts: { token: string; limit: number | null; asked: number; plan: string; ip: string }[] = [];
    const problems: string[] = [];

    for (let a = 0; a < Math.max(4, Math.round(12 * scale)); a++) {
      const reg = (
        await call("POST", "/v1/auth/register", undefined, {
          email: `fake${a}@example.com`,
          password: "correct-horse-battery",
          name: `Fake ${a}`,
          accountName: `Fake Company ${a}`,
        })
      ).json();
      const plan = catalog.plans[a % catalog.plans.length]!;
      const row = await db.db.query.plans.findFirst({ where: eq(plans.code, plan.code) });
      await db.db
        .update(subscriptions)
        .set({ planId: row!.id, status: "active", endsAt: new Date(Date.now() + 20 * 86_400_000) })
        .where(eq(subscriptions.accountId, reg.me.account.id));
      accounts.push({
        token: reg.accessToken as string,
        limit: plan.aiQuestionsPerMonth,
        asked: 0,
        plan: plan.code,
        ip: `10.1.${Math.floor(a / 250)}.${(a % 250) + 1}`,
      });
    }

    // The accounts take turns, in a random order, like users working at once.
    const queue = accounts.flatMap((acc, index) => {
      const target = (acc.limit ?? 40) + random.int(2, 8);
      return Array.from({ length: target }, (_, n) => ({ index, n }));
    });
    for (let i = queue.length - 1; i > 0; i--) {
      const j = random.int(0, i);
      [queue[i], queue[j]] = [queue[j]!, queue[i]!];
    }
    const counters = new Map<number, number>();
    for (const { index } of queue) {
      const acc = accounts[index]!;
      const n = (counters.get(index) ?? 0) + 1;
      counters.set(index, n);
      const text = `question ${n} of account ${index}`;
      const first = await call(
        "POST",
        "/v1/ai/chat",
        acc.token,
        { company: "X", messages: [{ role: "user", content: text }] },
        acc.ip,
      );
      const allowed = acc.limit === null || acc.asked < acc.limit;
      if (allowed) {
        if (first.statusCode !== 200)
          problems.push(`${acc.plan} #${n}: status ${first.statusCode} within the limit`);
        else acc.asked += 1;
        // The steps of the answer carry tool results: they are not new questions, at any point.
        if (first.statusCode === 200 && random.next() < 0.4) {
          const messages = [
            { role: "user", content: text },
            { role: "assistant", content: [{ type: "tool_use", id: `t${n}`, name: "x", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: "rows" }] },
          ];
          const step = await call("POST", "/v1/ai/chat", acc.token, { company: "X", messages }, acc.ip);
          if (step.statusCode !== 200)
            problems.push(`${acc.plan} #${n}: a step of an answer got ${step.statusCode}`);
        }
      } else if (first.statusCode !== 402 || first.json().code !== "AI_QUESTIONS_LIMIT") {
        problems.push(`${acc.plan} #${n}: past the limit got ${first.statusCode} ${first.body.slice(0, 80)}`);
      }
      if (first.statusCode >= 500) problems.push(`${acc.plan} #${n}: server error`);
    }

    for (const acc of accounts) {
      const used = (await call("GET", "/v1/billing/entitlements", acc.token, undefined, acc.ip)).json().usage
        .aiQuestions;
      if (used !== acc.asked) problems.push(`${acc.plan}: usage ${used}, asked ${acc.asked}`);
    }
    expect(problems.slice(0, 10), `${problems.length} problems`).toEqual([]);
  }, 300_000);

  it("junk sent to any route is refused politely: never a server error", async () => {
    const random = rng(Number(process.env.SIM_SEED ?? 20261021) + 300);
    const reg = (
      await call("POST", "/v1/auth/register", undefined, {
        email: "fuzzer@example.com",
        password: "correct-horse-battery",
        name: "Fuzzer",
        accountName: "Fuzz Company",
      })
    ).json();
    const token = reg.accessToken as string;
    const adminLogin = await call("POST", "/v1/admin/login", undefined, {
      email: "boss@platform.uz",
      password: "admin-password-123",
    });
    const adminToken = adminLogin.statusCode === 200 ? (adminLogin.json().accessToken as string) : undefined;

    expect(adminToken, "the admin signs in, so the admin routes are attacked too").toBeTruthy();
    const routes: [string, string, "user" | "admin" | "none"][] = [
      ["POST", "/v1/auth/register", "none"],
      ["POST", "/v1/auth/login", "none"],
      ["POST", "/v1/auth/refresh", "none"],
      ["POST", "/v1/auth/logout", "user"],
      ["POST", "/v1/ai/chat", "user"],
      ["POST", "/v1/ai/templates/reject", "user"],
      ["POST", "/v1/ai/traces", "user"],
      ["POST", "/v1/ai/answers", "user"],
      ["POST", "/v1/ai/answers/lookup", "user"],
      ["POST", "/v1/ai/free", "user"],
      ["PUT", "/v1/ai/digest", "user"],
      ["POST", "/v1/audits/runs", "user"],
      ["POST", "/v1/billing/trial", "user"],
      ["POST", "/v1/billing/quote", "user"],
      ["POST", "/v1/billing/checkout", "user"],
      ["POST", "/v1/billing/change-plan", "user"],
      ["POST", "/v1/billing/payme", "none"],
      ["POST", "/v1/companies", "user"],
      ["POST", "/v1/companies/active", "user"],
      ["POST", "/v1/users", "user"],
      ["POST", "/v1/usage/import", "user"],
      ["POST", "/v1/devices/activate", "user"],
      ["POST", "/v1/license/check", "user"],
      ["POST", "/v1/admin/ai-settings", "admin"],
      ["PUT", "/v1/admin/ai-policies", "admin"],
      ["PUT", "/v1/admin/query-templates", "admin"],
      ["POST", "/v1/admin/promo-codes", "admin"],
      ["POST", "/v1/admin/admins", "admin"],
      ["PUT", "/v1/admin/plans/free", "admin"],
      ["PUT", "/v1/admin/addons/addon_user", "admin"],
      ["POST", "/v1/admin/engine/run", "admin"],
    ];
    const scalar = () =>
      [
        null,
        true,
        0,
        -1,
        1e308,
        "",
        "x".repeat(random.int(1, 3000)),
        "\u0000",
        "' OR 1=1 --",
        "../../etc/passwd",
        "😀".repeat(5),
        NaN as unknown as number,
      ][random.int(0, 11)];
    const junk = (depth = 0): unknown => {
      const k = random.int(0, depth > 2 ? 2 : 5);
      if (k === 0) return scalar();
      if (k === 1) return Array.from({ length: random.int(0, 4) }, () => junk(depth + 1));
      if (k === 2)
        return {
          email: scalar(),
          password: scalar(),
          name: scalar(),
          company: scalar(),
          messages: scalar(),
          code: scalar(),
          plan: scalar(),
        };
      if (k === 3)
        return {
          messages: Array.from({ length: random.int(0, 4) }, () => ({
            role: scalar(),
            content: junk(depth + 1),
          })),
        };
      if (k === 4)
        return Object.fromEntries(
          Array.from({ length: random.int(0, 5) }, () => [String(scalar()).slice(0, 12), junk(depth + 1)]),
        );
      return { id: scalar(), type: scalar(), params: junk(depth + 1), key: scalar(), value: junk(depth + 1) };
    };
    const serverErrors: string[] = [];
    const n = Math.max(30, Math.round(250 * scale));
    for (let i = 0; i < n; i++) {
      const [method, url, who] = routes[random.int(0, routes.length - 1)]!;
      const authToken = who === "user" ? token : who === "admin" ? adminToken : undefined;
      const res = await app.inject({
        method: method as "POST" | "PUT",
        url,
        remoteAddress: `10.7.${random.int(0, 250)}.${random.int(1, 250)}`,
        payload: JSON.stringify(junk()),
        headers: {
          "content-type": "application/json",
          ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
        },
      });
      if (res.statusCode >= 500)
        serverErrors.push(`${method} ${url} → ${res.statusCode} ${res.body.slice(0, 120)}`);
    }
    // Bodies that are not JSON at all.
    for (const body of ["", "{", "null", "[1,2", "\u0000\u0001", '{"a":' + "[".repeat(2000)]) {
      for (const [method, url] of routes.slice(0, 6) as [string, string, string][]) {
        const res = await app.inject({
          method: method as "POST",
          url,
          payload: body,
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        });
        if (res.statusCode >= 500)
          serverErrors.push(`${method} ${url} raw ${JSON.stringify(body).slice(0, 20)} → ${res.statusCode}`);
      }
    }
    expect(serverErrors.slice(0, 10), `${serverErrors.length} server errors`).toEqual([]);
  }, 180_000);

  it("holds the limit when one account asks many questions at the same moment", async () => {
    const reg = (
      await call("POST", "/v1/auth/register", undefined, {
        email: "racer@example.com",
        password: "correct-horse-battery",
        name: "Racer",
        accountName: "Racing Company",
      })
    ).json();
    const free = await db.db.query.plans.findFirst({ where: eq(plans.code, "free") });
    await db.db
      .update(subscriptions)
      .set({ planId: free!.id, status: "active", endsAt: new Date(Date.now() + 20 * 86_400_000) })
      .where(eq(subscriptions.accountId, reg.me.account.id));
    const limit = free!.aiQuestionsPerMonth;
    expect(limit).toBeGreaterThan(0);
    const token = reg.accessToken as string;
    const results = await Promise.all(
      Array.from({ length: limit * 3 }, (_, n) =>
        call(
          "POST",
          "/v1/ai/chat",
          token,
          { company: "X", messages: [{ role: "user", content: `parallel question ${n}` }] },
          "10.9.9.9",
        ),
      ),
    );
    const ok = results.filter((r) => r.statusCode === 200).length;
    const blocked = results.filter((r) => r.statusCode === 402).length;
    const used = (await call("GET", "/v1/billing/entitlements", token, undefined, "10.9.9.9")).json().usage
      .aiQuestions;
    // Never more than the plan allows, never a server error; what was counted is what was answered.
    expect(results.filter((r) => r.statusCode >= 500).length).toBe(0);
    expect(ok).toBeLessThanOrEqual(limit);
    expect(used).toBe(ok);
    expect(ok + blocked).toBe(results.length);
  }, 120_000);
});
