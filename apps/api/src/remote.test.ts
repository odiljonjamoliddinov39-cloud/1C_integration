import { createHash, createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REMOTE_LIMITS, type WsCommand, notificationText } from "@platform/shared";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, runMigrations } from "./db/client.js";
import {
  plans,
  remoteAudit,
  remoteBlobs,
  remoteCommands,
  subscriptions,
  telegramPairings,
} from "./db/schema.js";
import type { Blobs } from "./remote/blobs.js";
import type { DeviceHub, Socket } from "./remote/hub.js";
import type { RemoteService } from "./remote/service.js";
import type { Bot, TelegramApi } from "./remote/telegram.js";

// Needs PostgreSQL (CI starts one). Each run gets a fresh database.
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const TEST_DB = "platform_remote_test";
const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
const available = await admin`select 1`.then(() => true).catch(() => false);

const { privateKey } = generateKeyPairSync("ed25519");
const BOT_TOKEN = "123456:test-bot-token";
const WEBHOOK_SECRET = "webhook-secret-value";
const INN = "311012912";
const OTHER_INN = "300000001";
const account = {
  email: "Owner@Example.com",
  password: "correct-horse-battery",
  name: "Owner",
  accountName: "Texmash MChJ",
};

/** What Telegram would sign: the Mini App's initData for a user. */
function initData(
  user: { id: number; username?: string; language_code?: string },
  authDate = Math.floor(Date.now() / 1000),
  token = BOT_TOKEN,
) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "AAH",
    user: JSON.stringify(user),
  });
  const check = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

/** A PC's end of the WebSocket. */
class FakeSocket implements Socket {
  sent: Record<string, unknown>[] = [];
  closed = false;
  private message: ((data: string) => void)[] = [];
  private close_: (() => void)[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.close_) l();
  }
  on(event: string, listener: (...args: never[]) => void) {
    if (event === "message") this.message.push(listener as never);
    if (event === "close") this.close_.push(listener as never);
  }
  /** The PC says something. */
  say(msg: Record<string, unknown>) {
    for (const l of this.message) l(JSON.stringify(msg));
  }
  commands(): WsCommand[] {
    return this.sent.filter((m) => m.type === "command") as unknown as WsCommand[];
  }
}

const settle = () => new Promise((r) => setTimeout(r, 40));

describe.skipIf(!available)("Telegram remote control", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: ReturnType<typeof createDb>;
  let service: RemoteService;
  let hub: DeviceHub;
  let blobs: Blobs;
  let bot: Bot;
  const sent: { chat: string; text: string; button?: { text: string; url: string } }[] = [];
  const telegramFiles = new Map<string, { name: string; data: Uint8Array }>();
  const api: TelegramApi = {
    async sendMessage(chat, text, button) {
      sent.push({ chat, text, ...(button ? { button } : {}) });
    },
    async download(fileId) {
      return telegramFiles.get(fileId) ?? null;
    },
  };

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
      REMOTE_JOBS: "off",
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_BOT_USERNAME: "@platform_bot",
      MINIAPP_URL: "https://server.example/app/",
      REMOTE_BLOB_DIR: mkdtempSync(join(tmpdir(), "remote-blobs-")),
    });
    app = await buildApp(db.db, config, {
      telegram: api,
      onRemote: (parts) => {
        service = parts.service;
        hub = parts.hub;
        blobs = parts.blobs;
        bot = parts.bot as Bot;
      },
    });
  });

  beforeEach(async () => {
    await db.sql`TRUNCATE accounts, refresh_tokens CASCADE`;
    sent.length = 0;
    telegramFiles.clear();
  });

  afterAll(async () => {
    await app?.close();
    await db?.sql.end();
    await admin.end();
  });

  // ---- helpers ----

  const json = (res: { json: () => unknown }) => res.json() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const setPlan = async (
    accountId: string,
    code: string,
    status: "active" | "free" = "active",
    days = 20,
  ) => {
    const plan = await db.db.query.plans.findFirst({ where: eq(plans.code, code) });
    await db.db
      .update(subscriptions)
      .set({ planId: plan!.id, status, endsAt: new Date(Date.now() + days * 86_400_000) })
      .where(eq(subscriptions.accountId, accountId));
  };

  /** An account on a paid plan with a PC that has said hello, paired with a phone. */
  async function setup(
    options: {
      ceiling?: "read" | "prepare" | "apply";
      plan?: string;
      companies?: { inn: string; name: string }[];
    } = {},
  ) {
    const reg = json(await app.inject({ method: "POST", url: "/v1/auth/register", payload: account }));
    const accountId = reg.me.account.id as string;
    await setPlan(accountId, options.plan ?? "business");
    const registered = json(
      await app.inject({
        method: "POST",
        url: "/remote/devices",
        headers: { authorization: `Bearer ${reg.accessToken}` },
        payload: { name: "Office PC", app_version: "0.1.220" },
      }),
    );
    const deviceToken = registered.token as string;
    const deviceId = registered.device_id as string;
    const dev = (path: string, payload?: unknown, method: "GET" | "POST" | "DELETE" = "POST") =>
      app.inject({
        method,
        url: path,
        headers: { authorization: `Device ${deviceToken}` },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
    const socket = new FakeSocket();
    const row = (await service.deviceByToken(deviceToken))!;
    const connect = async (done: string[] = []) => {
      hub.attachSocket(socket, row);
      socket.say({
        type: "hello",
        app_version: "0.1.220",
        companies: options.companies ?? [{ inn: INN, name: "Texmash Import" }],
        capabilities: ["chat.message"],
        done_ids: done,
      });
      await settle();
    };
    // Pair a phone (Telegram user 777).
    const phone = { id: 777, username: "buxgalter", language_code: "uz" };
    await service.hello(deviceId, {
      app_version: "0.1.220",
      companies: options.companies ?? [{ inn: INN, name: "Texmash Import" }],
    });
    const pairing = json(await dev("/remote/pairing", { ceiling: options.ceiling ?? "prepare" }));
    await bot.handle({ message: { chat: { id: 777 }, from: phone, text: `/start ${pairing.code}` } });
    const tma = (user = phone) => ({ authorization: `tma ${initData(user)}` });
    const send = (
      type: string,
      payload: unknown = {},
      extra: Record<string, unknown> = {},
      headers = tma(),
    ) =>
      app.inject({
        method: "POST",
        url: "/remote/commands",
        headers,
        payload: { type, company_inn: INN, payload, request_id: randomUUID(), ...extra },
      });
    return { accountId, deviceId, deviceToken, dev, socket, connect, phone, tma, send, pairing, reg };
  }

  // ---- 1. offline, then online ----

  it("1. a message sent while the PC is off waits queued; when the PC comes online it is delivered, runs, and the phone is told", async () => {
    const t = await setup();
    const res = await t.send("chat.message", { text: "Qoldiqni ayt" });
    expect(res.statusCode).toBe(201);
    const created = json(res);
    expect(created).toMatchObject({ state: "queued", type: "chat.message", class: "prepare" });

    // The PC is off: still queued, and the phone can ask.
    expect(
      json(await app.inject({ method: "GET", url: `/remote/commands/${created.id}`, headers: t.tma() }))
        .state,
    ).toBe("queued");

    await t.connect();
    const [command] = t.socket.commands();
    expect(command).toMatchObject({
      id: created.id,
      command_type: "chat.message",
      payload: { text: "Qoldiqni ayt" },
      ceiling: "prepare",
    });
    expect(await service.stateOf(created.id)).toBe("delivered");

    t.socket.say({ type: "ack", id: created.id });
    await settle();
    expect(await service.stateOf(created.id)).toBe("running");
    t.socket.say({ type: "progress", id: created.id, text: "asking 1C" });
    await settle();
    expect(
      json(await app.inject({ method: "GET", url: `/remote/commands/${created.id}`, headers: t.tma() }))
        .progress,
    ).toBe("asking 1C");

    t.socket.say({
      type: "result",
      id: created.id,
      ok: true,
      result: { reply: "Qoldiq: 12 mln", cards: [] },
    });
    await settle();
    const done = json(
      await app.inject({ method: "GET", url: `/remote/commands/${created.id}`, headers: t.tma() }),
    );
    expect(done).toMatchObject({ state: "done", result: { reply: "Qoldiq: 12 mln" } });
    // The phone gets a short message with the button, and no content.
    const told = sent.find((m) => m.text === "Javob tayyor. Ilovani oching.");
    expect(told?.chat).toBe("777");
    expect(told?.button?.url).toBe("https://server.example/app");
  });

  // ---- 2. exactly once ----

  it("2. a dropped link never runs a command twice: unacknowledged and Read go back to the queue, Prepare that was running is failed: interrupted", async () => {
    const t = await setup();
    await t.connect();
    const read = json(await t.send("status.get"));
    const prepare = json(await t.send("chat.message", { text: "kirit" }));
    const fresh = json(await t.send("proposal.list"));
    await settle();
    expect(t.socket.commands().map((c) => c.id)).toEqual([read.id, prepare.id, fresh.id]);
    // read and prepare are acknowledged; `fresh` is not.
    t.socket.say({ type: "ack", id: read.id });
    t.socket.say({ type: "ack", id: prepare.id });
    await settle();
    t.socket.close();
    await settle();
    expect(await service.stateOf(read.id)).toBe("queued");
    expect(await service.stateOf(fresh.id)).toBe("queued");
    expect(await service.stateOf(prepare.id)).toBe("failed");
    const failed = json(
      await app.inject({ method: "GET", url: `/remote/commands/${prepare.id}`, headers: t.tma() }),
    );
    expect(failed.error).toMatchObject({ code: "INTERRUPTED" });
    expect(sent.some((m) => m.text.includes("Ulanish uzilib qoldi"))).toBe(true);

    // The PC comes back: only what is queued is sent, never the failed one.
    const again = new FakeSocket();
    const row = (await service.deviceByToken(t.deviceToken))!;
    hub.attachSocket(again, row);
    again.say({
      type: "hello",
      app_version: "x",
      companies: [{ inn: INN, name: "T" }],
      capabilities: [],
      done_ids: [],
    });
    await settle();
    expect(
      again
        .commands()
        .map((c) => c.id)
        .sort(),
    ).toEqual([read.id, fresh.id].sort());
  });

  it("2b. an id the PC already holds in its hello is not sent again", async () => {
    const t = await setup();
    const read = json(await t.send("status.get"));
    await t.connect([read.id]);
    expect(t.socket.commands()).toEqual([]);
    expect(await service.stateOf(read.id)).toBe("running");
  });

  // ---- 3. a statement from the phone ----

  it("3. a statement uploaded from the Mini App is stored sealed, attached to a command, delivered, and deleted after the PC downloads it", async () => {
    const t = await setup();
    await t.connect();
    const xlsx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("statement bytes")]);
    const upload = await app.inject({
      method: "POST",
      url: "/remote/blobs",
      headers: {
        ...t.tma(),
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent("№ счёта 20208.xlsx"),
        "x-sha256": createHash("sha256").update(xlsx).digest("hex"),
      },
      payload: xlsx,
    });
    expect(upload.statusCode).toBe(201);
    const blob = json(upload);
    const cmd = json(await t.send("chat.attach", { blob_id: blob.id, name: "№ счёта 20208.xlsx" }));
    await settle();
    expect(t.socket.commands()[0]).toMatchObject({ id: cmd.id, command_type: "chat.attach" });
    // The bytes on the server are sealed, not the file.
    const stored = await blobs.read(blob.id);
    expect(stored?.data.equals(xlsx)).toBe(true);

    const download = await t.dev(`/remote/blobs/${blob.id}`, undefined, "GET");
    expect(download.statusCode).toBe(200);
    expect(Buffer.from(download.rawPayload).equals(xlsx)).toBe(true);
    expect(download.headers["x-sha256"]).toBe(blob.sha256);
    // Taken: gone.
    expect((await t.dev(`/remote/blobs/${blob.id}`, undefined, "GET")).statusCode).toBe(404);
    expect(await blobs.read(blob.id)).toBeNull();
  });

  it("a file is refused before it is stored: a wrong checksum, a renamed file, a large one, a kind not accepted", async () => {
    const t = await setup();
    const post = (name: string, data: Buffer, sha = createHash("sha256").update(data).digest("hex")) =>
      app.inject({
        method: "POST",
        url: "/remote/blobs",
        headers: {
          ...t.tma(),
          "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent(name),
          "x-sha256": sha,
        },
        payload: data,
      });
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("x")]);
    expect(json(await post("a.xlsx", zip, "0".repeat(64))).code).toBe("CHECKSUM");
    expect(json(await post("a.pdf", zip)).code).toBe("FILE_CONTENT");
    expect(json(await post("a.exe", zip)).code).toBe("FILE_TYPE");
    expect(json(await post("a.zip", zip)).code).toBe("FILE_TYPE");
    expect(json(await post("a.csv", Buffer.alloc(0))).code).toBe("EMPTY_FILE");
    const big = Buffer.alloc(REMOTE_LIMITS.maxFileBytes + 1, 0x41);
    const refused = await post("big.csv", big);
    expect([400, 413]).toContain(refused.statusCode);
    expect((await db.db.select().from(remoteBlobs)).length).toBe(0);
  });

  // ---- 4. apply is guarded ----

  it("4. an Apply command carries the proposal's hash and a ceiling of apply; a confirmation older than 2 hours expires", async () => {
    const hash = "a".repeat(64);
    const low = await setup({ ceiling: "prepare" });
    expect(json(await low.send("proposal.apply", { proposal_id: "p1" }, { proposal_hash: hash })).code).toBe(
      "CEILING",
    );

    await db.sql`TRUNCATE accounts, refresh_tokens CASCADE`;
    const t = await setup({ ceiling: "apply" });
    expect(json(await t.send("proposal.apply", { proposal_id: "p1" })).code).toBe("VALIDATION");
    const made = json(await t.send("proposal.apply", { proposal_id: "p1" }, { proposal_hash: hash }));
    expect(made).toMatchObject({ class: "apply", state: "queued" });
    await t.connect();
    expect(t.socket.commands()[0]).toMatchObject({ class: "apply", proposal_hash: hash, ceiling: "apply" });

    // Queued again, and the PC stays away for more than 2 hours: expired, and the phone is told.
    const waiting = json(await t.send("proposal.apply", { proposal_id: "p2" }, { proposal_hash: hash }));
    t.socket.close();
    await settle();
    expect(await service.stateOf(waiting.id)).toBe("queued");
    await db.db
      .update(remoteCommands)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(remoteCommands.id, waiting.id));
    expect(await service.expireDue()).toBeGreaterThanOrEqual(1);
    await settle();
    expect(await service.stateOf(waiting.id)).toBe("expired");
    expect(sent.some((m) => m.text.includes("muddati o'tdi"))).toBe(true);
    // The time to live of an Apply command is 2 hours, of a Read command a day.
    const [row] = await db.db.select().from(remoteCommands).where(eq(remoteCommands.id, made.id));
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(2 * 3_600_000);
  });

  it("the PC's result of the wrong shape is stored as failed, never shown to the phone", async () => {
    const t = await setup();
    await t.connect();
    const cmd = json(await t.send("status.get"));
    await settle();
    t.socket.say({ type: "ack", id: cmd.id });
    t.socket.say({ type: "result", id: cmd.id, ok: true, result: { nonsense: true } });
    await settle();
    const view = json(
      await app.inject({ method: "GET", url: `/remote/commands/${cmd.id}`, headers: t.tma() }),
    );
    expect(view.state).toBe("failed");
    expect(view.error.code).toBe("BAD_RESULT");
    expect(view.result).toBeUndefined();
  });

  // ---- 5. wrong company ----

  it("5. a command for a company the PC does not have is refused; the command carries the company the phone named", async () => {
    const t = await setup();
    const res = await t.send("chat.message", { text: "x" }, { company_inn: OTHER_INN });
    expect(res.statusCode).toBe(404);
    expect(json(res).code).toBe("COMPANY_NOT_FOUND");
    await t.connect();
    const ok = json(await t.send("chat.message", { text: "x" }, { company_inn: INN }));
    await settle();
    expect(t.socket.commands().find((c) => c.id === ok.id)?.company_inn).toBe(INN);
  });

  // ---- 6. no content in Telegram ----

  it("6. no bot message carries an amount, an INN, an account number or a name from the books", async () => {
    const t = await setup();
    await t.connect();
    const cmd = json(
      await t.send("chat.message", {
        text: "Texmash Import 311012912 hisob 20208000705733821001 qarz 124 500 000",
      }),
    );
    await settle();
    t.socket.say({ type: "ack", id: cmd.id });
    t.socket.say({
      type: "result",
      id: cmd.id,
      ok: true,
      result: {
        reply: "Texmash Import: 124 500 000 so'm, INN 311012912, hisob 20208000705733821001",
        cards: [],
      },
    });
    t.socket.say({ type: "notify", event: "import.finished", count: 12 });
    t.socket.say({ type: "notify", event: "proposal.waiting", count: 2 });
    await settle();
    expect(sent.length).toBeGreaterThanOrEqual(3);
    for (const message of sent) {
      expect(message.text).not.toMatch(/\d{9,}/);
      expect(message.text).not.toMatch(/\d{1,3}(?:[ .,]\d{3})+/);
      expect(message.text).not.toMatch(/Texmash|mln|so'm/i);
    }
    // The counts are there, and only as counts.
    expect(sent.some((m) => m.text === notificationText("import.finished", "uz", 12))).toBe(true);
    // The server's mailbox holds the content sealed, never in the clear.
    const [row] = await db.db.select().from(remoteCommands).where(eq(remoteCommands.id, cmd.id));
    expect(row!.payload).not.toContain("Texmash");
    expect(row!.result).not.toContain("124 500 000");
  });

  // ---- 7. pairing ----

  it("7. a pairing code works once and expires after 10 minutes; after /unlink or the kill switch a command is refused and the channel closed", async () => {
    const t = await setup();
    // A second use of the same code is refused.
    await bot.handle({
      message: {
        chat: { id: 888 },
        from: { id: 888, username: "x", language_code: "uz" },
        text: `/start ${t.pairing.code}`,
      },
    });
    expect(sent.at(-1)?.text).toContain("noto'g'ri, muddati o'tgan yoki ishlatilgan");
    // An expired code is refused.
    const second = json(await t.dev("/remote/pairing", {}));
    await db.db.update(telegramPairings).set({ expiresAt: new Date(Date.now() - 1000) });
    await bot.handle({
      message: { chat: { id: 888 }, from: { id: 888, language_code: "uz" }, text: `/start ${second.code}` },
    });
    expect(sent.at(-1)?.text).toContain("noto'g'ri, muddati o'tgan yoki ishlatilgan");

    await t.connect();
    expect(json(await t.send("status.get")).state).toBe("queued");
    await bot.handle({ message: { chat: { id: 777 }, from: t.phone, text: "/unlink" } });
    expect(t.socket.closed).toBe(true);
    expect(t.socket.sent.some((m) => m.type === "revoke" && m.reason === "link_revoked")).toBe(true);
    const refused = await t.send("status.get");
    expect(refused.statusCode).toBe(403);
    expect(json(refused).code).toBe("NOT_LINKED");

    // The kill switch of the account.
    await db.sql`TRUNCATE accounts, refresh_tokens CASCADE`;
    const k = await setup();
    await k.connect();
    const off = await k.dev("/remote/device/enabled", { enabled: false });
    expect(off.statusCode).toBe(200);
    expect(k.socket.closed).toBe(true);
    expect(k.socket.sent.some((m) => m.type === "revoke" && m.reason === "device_disabled")).toBe(true);
    const blocked = await k.send("status.get");
    expect(json(blocked).code).toBe("DEVICE_DISABLED");
    // The PC may switch itself back on.
    expect((await k.dev("/remote/device/enabled", { enabled: true })).statusCode).toBe(200);
    expect((await k.send("status.get")).statusCode).toBe(201);
  });

  // ---- 8. forged caller ----

  it("8. initData with a wrong signature, or older than an hour, is refused; a Telegram id with no binding is refused", async () => {
    const t = await setup();
    const call = (authorization: string) =>
      app.inject({ method: "GET", url: "/remote/me", headers: { authorization } });
    expect((await call(`tma ${initData(t.phone)}`)).statusCode).toBe(200);
    expect(json(await call(`tma ${initData(t.phone, undefined, "999:other-token")}`)).code).toBe(
      "BAD_INIT_DATA",
    );
    expect(
      json(await call(`tma ${initData(t.phone).replace(/hash=[0-9a-f]+/, "hash=" + "0".repeat(64))}`)).code,
    ).toBe("BAD_INIT_DATA");
    const old = Math.floor(Date.now() / 1000) - 3601;
    expect(json(await call(`tma ${initData(t.phone, old)}`)).code).toBe("INIT_DATA_EXPIRED");
    expect(json(await call(`tma ${initData({ id: 555 })}`)).code).toBe("NOT_LINKED");
    expect(json(await call("Bearer abc")).code).toBe("UNAUTHORIZED");
    // The webhook trusts only Telegram's secret header.
    const hook = (secret?: string) =>
      app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {},
        payload: { message: { chat: { id: 777 }, from: t.phone, text: "/status" } },
      });
    expect((await hook()).statusCode).toBe(401);
    expect((await hook("wrong")).statusCode).toBe(401);
    expect((await hook(WEBHOOK_SECRET)).statusCode).toBe(200);
  });

  // ---- 9. limits ----

  it("9. the 31st command in a minute is refused with a clear message; an expired license allows Read and refuses Prepare and Apply; a plan without the feature is refused", async () => {
    const t = await setup({ ceiling: "apply" });
    for (let i = 0; i < REMOTE_LIMITS.commandsPerMinute; i++)
      expect((await t.send("status.get")).statusCode).toBe(201);
    const over = await t.send("status.get");
    expect(over.statusCode).toBe(429);
    expect(json(over)).toMatchObject({ code: "RATE_LIMIT" });
    expect(json(over).message).toContain("30 commands a minute");

    await db.sql`TRUNCATE accounts, refresh_tokens CASCADE`;
    const e = await setup({ ceiling: "apply" });
    // The paid plan has run out: the account has fallen back to Free.
    await db.db
      .update(subscriptions)
      .set({ endsAt: new Date(Date.now() - 30 * 86_400_000) })
      .where(eq(subscriptions.accountId, e.accountId));
    expect((await e.send("status.get")).statusCode).toBe(201);
    expect(json(await e.send("chat.message", { text: "x" })).code).toBe("READ_ONLY");
    expect(
      json(await e.send("proposal.apply", { proposal_id: "p" }, { proposal_hash: "b".repeat(64) })).code,
    ).toBe("READ_ONLY");

    await db.sql`TRUNCATE accounts, refresh_tokens CASCADE`;
    const reg = json(await app.inject({ method: "POST", url: "/v1/auth/register", payload: account }));
    const free = await app.inject({
      method: "POST",
      url: "/remote/devices",
      headers: { authorization: `Bearer ${reg.accessToken}` },
      payload: { name: "PC", app_version: "1" },
    });
    expect(free.statusCode).toBe(402);
    expect(json(free).code).toBe("FEATURE_NOT_IN_PLAN");
  });

  it("the open requests of a PC are limited to 50, and a cancelled one frees the place", async () => {
    const t = await setup({ ceiling: "apply" });
    // Two phones would share the limit by device: fill it with the one.
    const ids: string[] = [];
    for (let i = 0; i < REMOTE_LIMITS.openPerDevice; i++) {
      const res = await t.send("proposal.list");
      if (res.statusCode === 429) break;
      ids.push(json(res).id);
      // keep under the per-minute limit
      await db.sql`UPDATE remote_commands SET created_at = created_at - interval '2 minutes' WHERE id = ${ids.at(-1)!}`;
    }
    expect(ids).toHaveLength(REMOTE_LIMITS.openPerDevice);
    const over = await t.send("proposal.list");
    expect(json(over).code).toBe("TOO_MANY_OPEN");
    expect(
      (await app.inject({ method: "POST", url: `/remote/commands/${ids[0]}/cancel`, headers: t.tma() }))
        .statusCode,
    ).toBe(200);
    expect((await t.send("proposal.list")).statusCode).toBe(201);
  });

  // ---- 10. output file ----

  it("10. an output the PC made is downloaded by the phone inside the Mini App; after 24 hours the link says it expired", async () => {
    const t = await setup();
    await t.connect();
    const cmd = json(await t.send("report.make", { report: "balance", format: "xlsx" }));
    await settle();
    t.socket.say({ type: "ack", id: cmd.id });
    const xlsx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("report")]);
    const up = await app.inject({
      method: "POST",
      url: "/remote/blobs",
      headers: {
        authorization: `Device ${t.deviceToken}`,
        "content-type": "application/octet-stream",
        "x-file-name": "balance.xlsx",
        "x-sha256": createHash("sha256").update(xlsx).digest("hex"),
        "x-command-id": cmd.id,
      },
      payload: xlsx,
    });
    expect(up.statusCode).toBe(201);
    const blob = json(up);
    t.socket.say({
      type: "result",
      id: cmd.id,
      ok: true,
      result: { summary: "Balans tayyor" },
      blobs: [blob],
    });
    await settle();
    const view = json(
      await app.inject({ method: "GET", url: `/remote/commands/${cmd.id}`, headers: t.tma() }),
    );
    expect(view.blobs).toEqual([blob]);
    const got = await app.inject({ method: "GET", url: `/remote/blobs/${blob.id}`, headers: t.tma() });
    expect(got.statusCode).toBe(200);
    expect(Buffer.from(got.rawPayload).equals(xlsx)).toBe(true);
    // The same link a second time still works (an output stays until it expires); another phone cannot read it.
    expect(
      (await app.inject({ method: "GET", url: `/remote/blobs/${blob.id}`, headers: t.tma() })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/remote/blobs/${blob.id}`,
          headers: { authorization: `tma ${initData({ id: 4242 })}` },
        })
      ).statusCode,
    ).toBe(403);

    await db.db
      .update(remoteBlobs)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(remoteBlobs.id, blob.id));
    const late = await app.inject({ method: "GET", url: `/remote/blobs/${blob.id}`, headers: t.tma() });
    expect(late.statusCode).toBe(404);
    expect(json(late).code).toBe("BLOB_EXPIRED");
    expect(await blobs.purgeExpired()).toBe(1);
    expect((await db.db.select().from(remoteBlobs)).length).toBe(0);
  });

  // ---- data minimization: the server does not keep what a finished request carried ----

  it("a finished request no longer holds its content, and an answer is dropped after a week", async () => {
    const t = await setup({ ceiling: "apply" });
    // A request that is cancelled before delivery does not keep its content either.
    const queued = json(await t.send("chat.message", { text: "another secret" }));
    const cancelled = json(
      await app.inject({ method: "POST", url: `/remote/commands/${queued.id}/cancel`, headers: t.tma() }),
    );
    expect(cancelled.state).toBe("cancelled");
    const [gone] = await db.db.select().from(remoteCommands).where(eq(remoteCommands.id, queued.id));
    expect(JSON.stringify(service.seal.openJson(gone!.payload))).toBe("{}");

    await t.connect();
    const sentCmd = json(await t.send("chat.message", { text: "secret question 5 000 000" }));
    await settle();
    t.socket.say({ type: "ack", id: sentCmd.id });
    t.socket.say({ type: "result", id: sentCmd.id, ok: true, result: { reply: "ok", cards: [] }, blobs: [] });
    await settle();
    let [row] = await db.db.select().from(remoteCommands).where(eq(remoteCommands.id, sentCmd.id));
    expect(row!.state).toBe("done");
    // The message (it could hold a PIN) is gone from the row; the answer stays for the phone's history.
    expect(JSON.stringify(service.seal.openJson(row!.payload))).toBe("{}");
    expect(service.seal.openJson(row!.result)).toMatchObject({ reply: "ok" });
    await db.db
      .update(remoteCommands)
      .set({ finishedAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(eq(remoteCommands.id, sentCmd.id));
    expect(await service.scrubOld()).toBe(1);
    [row] = await db.db.select().from(remoteCommands).where(eq(remoteCommands.id, sentCmd.id));
    expect(row!.result).toBeNull();
  });

  // ---- 11. idempotent create ----

  it("11. the same request id sent twice (a double tap) creates one command; another phone's request id is refused", async () => {
    const t = await setup();
    const request_id = randomUUID();
    const a = await t.send("chat.message", { text: "bir" }, { request_id });
    const b = await t.send("chat.message", { text: "bir" }, { request_id });
    expect(a.statusCode).toBe(201);
    expect(json(b).id).toBe(json(a).id);
    expect(await service.countCommands()).toBe(1);
    // Two taps in the same instant.
    const same = randomUUID();
    const [x, y] = await Promise.all([
      t.send("status.get", {}, { request_id: same }),
      t.send("status.get", {}, { request_id: same }),
    ]);
    expect(json(x).id).toBe(json(y).id);
    expect(await service.countCommands()).toBe(2);
  });

  // ---- 12. audit ----

  it("12. every command has an audit row on the server, with no content", async () => {
    const t = await setup();
    await t.connect();
    const cmd = json(await t.send("chat.message", { text: "maxfiy 311012912" }));
    await settle();
    t.socket.say({ type: "ack", id: cmd.id });
    t.socket.say({ type: "result", id: cmd.id, ok: true, result: { reply: "maxfiy javob", cards: [] } });
    await settle();
    const rows = await db.db.select().from(remoteAudit).where(eq(remoteAudit.commandId, cmd.id));
    expect(rows.map((r) => r.event).sort()).toEqual(["created", "delivered", "done", "running"]);
    expect(JSON.stringify(rows)).not.toMatch(/maxfiy|311012912/);
    expect(rows.every((r) => r.type === "chat.message" && r.class === "prepare")).toBe(true);
    const audit = json(await t.dev("/remote/audit", undefined, "GET")) as unknown as unknown[];
    expect(audit.length).toBeGreaterThan(5);
  });

  // ---- the bot ----

  it("a message and a file written in the bot chat become commands for the active company; /status says whether the PC is online", async () => {
    const t = await setup();
    await bot.handle({ message: { chat: { id: 777 }, from: t.phone, text: "/status" } });
    expect(sent.at(-1)?.text).toContain("kompyuter o'chiq");
    await t.connect();
    await bot.handle({ message: { chat: { id: 777 }, from: t.phone, text: "/status" } });
    expect(sent.at(-1)?.text).toContain("kompyuter ulangan");

    await bot.handle({ message: { chat: { id: 777 }, from: t.phone, text: "Bugungi qoldiq" } });
    await settle();
    expect(t.socket.commands().at(-1)).toMatchObject({
      command_type: "chat.message",
      payload: { text: "Bugungi qoldiq" },
      company_inn: INN,
    });
    expect(sent.at(-1)?.text).toContain("Qabul qilindi");

    const xlsx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("tg file")]);
    telegramFiles.set("F1", { name: "stmt.xlsx", data: xlsx });
    await bot.handle({
      message: {
        chat: { id: 777 },
        from: t.phone,
        document: { file_id: "F1", file_name: "stmt.xlsx", file_size: xlsx.length },
      },
    });
    await settle();
    expect(t.socket.commands().at(-1)).toMatchObject({
      command_type: "chat.attach",
      payload: { name: "stmt.xlsx" },
    });
    // A file Telegram does not give, and one of a kind that is not accepted.
    await bot.handle({
      message: { chat: { id: 777 }, from: t.phone, document: { file_id: "none", file_name: "a.xlsx" } },
    });
    expect(sent.at(-1)?.text).toContain("Faylni qabul qilib bo'lmadi");
    telegramFiles.set("F2", { name: "a.exe", data: xlsx });
    await bot.handle({
      message: { chat: { id: 777 }, from: t.phone, document: { file_id: "F2", file_name: "a.exe" } },
    });
    expect(sent.at(-1)?.text).toContain("Faylni qabul qilib bo'lmadi");
    // A stranger is told nothing is connected.
    await bot.handle({
      message: { chat: { id: 31337 }, from: { id: 31337, language_code: "uz" }, text: "salom" },
    });
    expect(sent.at(-1)).toMatchObject({ chat: "31337" });
    expect(sent.at(-1)?.text).toContain("ulanmagan");
  });

  it("over a real WebSocket: the device token is the subprotocol; a wrong token is closed, a right one gets its queued command", async () => {
    const t = await setup();
    const queued = json(await t.send("status.get"));
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const { port } = app.server.address() as { port: number };
      const open = (token: string) =>
        new Promise<{ ws: WebSocket; messages: Record<string, unknown>[]; closed: Promise<number> }>(
          (resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/remote/device`, [
              "platform.v1",
              `bearer.${token}`,
            ]);
            const messages: Record<string, unknown>[] = [];
            const closed = new Promise<number>((done) => ws.addEventListener("close", (e) => done(e.code)));
            ws.addEventListener("message", (e) =>
              messages.push(JSON.parse(String(e.data)) as Record<string, unknown>),
            );
            ws.addEventListener("open", () => resolve({ ws, messages, closed }));
            ws.addEventListener("error", () => resolve({ ws, messages, closed }));
          },
        );
      const wrong = await open("not-a-token");
      expect(await wrong.closed).toBe(4401);

      const right = await open(t.deviceToken);
      right.ws.send(
        JSON.stringify({
          type: "hello",
          app_version: "1",
          companies: [{ inn: INN, name: "T" }],
          capabilities: [],
          done_ids: [],
        }),
      );
      await new Promise((r) => setTimeout(r, 300));
      expect(right.ws.protocol).toBe("platform.v1");
      expect(right.messages.find((m) => m.type === "command")).toMatchObject({
        id: queued.id,
        command_type: "status.get",
      });
      right.ws.send(JSON.stringify({ type: "ping" }));
      await new Promise((r) => setTimeout(r, 100));
      expect(right.messages.some((m) => m.type === "pong")).toBe(true);
      right.ws.close();
      await right.closed;
    } finally {
      await app.server.close?.();
    }
  });

  it("cancelling: a queued request can be cancelled, a running one cannot (409)", async () => {
    const t = await setup();
    const queued = json(await t.send("chat.message", { text: "bekor" }));
    expect(
      json(
        await app.inject({ method: "POST", url: `/remote/commands/${queued.id}/cancel`, headers: t.tma() }),
      ).state,
    ).toBe("cancelled");
    await t.connect();
    const running = json(await t.send("status.get"));
    await settle();
    t.socket.say({ type: "ack", id: running.id });
    await settle();
    const res = await app.inject({
      method: "POST",
      url: `/remote/commands/${running.id}/cancel`,
      headers: t.tma(),
    });
    expect(res.statusCode).toBe(409);
    // A cancelled command is never delivered.
    expect(t.socket.commands().map((c) => c.id)).not.toContain(queued.id);
  });

  it("commands of one PC are delivered oldest first, and a Read command's drop puts it back in the queue (one PC, two companies)", async () => {
    const t = await setup({
      companies: [
        { inn: INN, name: "A" },
        { inn: OTHER_INN, name: "B" },
      ],
    });
    const first = json(await t.send("chat.message", { text: "1" }));
    const second = json(await t.send("chat.message", { text: "2" }, { company_inn: OTHER_INN }));
    await t.connect();
    expect(t.socket.commands().map((c) => [c.id, c.company_inn])).toEqual([
      [first.id, INN],
      [second.id, OTHER_INN],
    ]);
  });
});
