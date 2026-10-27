/**
 * A real server for tests that live outside this package (the desktop's end-to-end test): a fresh Postgres database,
 * the Fastify app on a real port, an account on a paid plan that is signed in, and a fake Telegram. Needs PostgreSQL
 * (TEST_DATABASE_ADMIN_URL).
 */
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import postgres from "postgres";

import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createDb, runMigrations } from "../db/client.js";
import { plans, subscriptions } from "../db/schema.js";
import type { Bot, TelegramApi } from "./telegram.js";

export const TEST_BOT_TOKEN = "123456:e2e-bot-token";

export async function databaseAvailable(): Promise<boolean> {
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => undefined });
  try {
    await admin`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await admin.end();
  }
}

const adminUrl = () => process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";

export interface TestServer {
  base: string;
  accessToken: string;
  bot: Bot;
  /** What the bot said, in order. */
  telegram: { chat: string; text: string }[];
  /** The Mini App's signed initData for a Telegram user. */
  initData(user: { id: number; username?: string; language_code?: string }): string;
  close(): Promise<void>;
}

export async function startTestServer(
  name: string,
  options: { miniappDir?: string } = {},
): Promise<TestServer> {
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => undefined });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = adminUrl().replace(/\/[^/]*$/, `/${name}`);
  const db = createDb(url);
  await runMigrations(db.db);
  const config = loadConfig({
    DATABASE_URL: url,
    JWT_SECRET: "test-secret-that-is-long-enough-1234567890",
    LICENSE_PRIVATE_KEY: generateKeyPairSync("ed25519")
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
    LOG_LEVEL: "silent",
    AUTH_RATE_PER_MINUTE: "1000",
    ENTITLEMENTS_CACHE_SECONDS: "0",
    BILLING_JOBS: "off",
    REMOTE_JOBS: "off",
    TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: "secret",
    TELEGRAM_BOT_USERNAME: "platform_bot",
    MINIAPP_URL: "https://server.example/app/",
    REMOTE_BLOB_DIR: mkdtempSync(join(tmpdir(), "remote-test-blobs-")),
  });
  const telegram: TestServer["telegram"] = [];
  const api: TelegramApi = {
    async sendMessage(chat, text) {
      telegram.push({ chat, text });
    },
    async download() {
      return null;
    },
  };
  let bot: Bot | undefined;
  const app = await buildApp(db.db, config, {
    telegram: api,
    ...(options.miniappDir ? { miniappDir: options.miniappDir } : {}),
    onRemote: (parts) => {
      bot = parts.bot as Bot;
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  const reg = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: {
      email: "e2e@example.com",
      password: "correct-horse-battery",
      name: "Owner",
      accountName: "Texmash MChJ",
    },
  });
  const { accessToken, me } = reg.json() as { accessToken: string; me: { account: { id: string } } };
  const plan = await db.db.query.plans.findFirst({ where: eq(plans.code, "business") });
  if (!plan) throw new Error("The business plan is not seeded");
  await db.db
    .update(subscriptions)
    .set({ planId: plan.id, status: "active", endsAt: new Date(Date.now() + 20 * 86_400_000) })
    .where(eq(subscriptions.accountId, me.account.id));

  return {
    base,
    accessToken,
    bot: bot as Bot,
    telegram,
    initData(user) {
      const params = new URLSearchParams({
        auth_date: String(Math.floor(Date.now() / 1000)),
        query_id: "AAH",
        user: JSON.stringify(user),
      });
      const check = [...params.entries()]
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join("\n");
      const secret = createHmac("sha256", "WebAppData").update(TEST_BOT_TOKEN).digest();
      params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
      return params.toString();
    },
    async close() {
      await app.close();
      await db.sql.end();
      await admin.end();
    },
  };
}
