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
      DATABASE_URL: url,
      JWT_SECRET: "test-secret-that-is-long-enough-1234567890",
      LICENSE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      LOG_LEVEL: process.env.TEST_LOG ?? "silent",
      AUTH_RATE_PER_MINUTE: "100000",
      ENTITLEMENTS_CACHE_SECONDS: "0",
      BILLING_JOBS: "off",
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
});
