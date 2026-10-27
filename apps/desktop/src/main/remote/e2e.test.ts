/**
 * The desktop's remote layer against the real server (Postgres, the Fastify app, a real WebSocket on a real port),
 * with a fake Telegram and a fake assistant/1C. It checks that the two halves speak the same protocol: acceptance
 * tests 1 (offline then online), 3 (a statement from the phone), 4 (the Apply guard) and 10 (an output file).
 * Needs PostgreSQL (TEST_DATABASE_ADMIN_URL); skipped without it.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseAvailable, startTestServer, type TestServer } from "../../../../api/src/remote/testing.js";

import type { AssistantEvent, AssistantInput, Proposal, Result } from "../../shared/ipc.js";
import type { SecretBox } from "../store.js";
import { proposalHash, type RemoteAssistant } from "./commands.js";
import { RemoteService } from "./service.js";
import { RemoteState } from "./state.js";

const available = await databaseAvailable();

const INN = "311012912";
const secrets: SecretBox = { encrypt: (p) => `enc:${p}`, decrypt: (e) => e.slice(4) };
const phone = { id: 555, username: "owner", language_code: "ru" };

const batch = (title: string): Proposal => ({
  kind: "batch",
  title,
  items: [
    {
      action: "create",
      object: "Документ.СписаниеСРасчетногоСчета",
      preview: {
        action: "create",
        object: "Документ.СписаниеСРасчетногоСчета",
        ref: null,
        presentation: "new",
        posted: false,
        deletionMark: false,
        version: "",
        willPost: false,
        changes: [{ field: "Сумма", before: null, after: 1_200_000 }],
        tables: [],
        warnings: [],
      },
      error: null,
    },
  ],
});

class FakeAssistant implements RemoteAssistant {
  private observers = new Set<(e: AssistantEvent) => void>();
  waiting: { companyId: string; id: string; proposal: Proposal; shownAt: number }[] = [];
  files: { name: string; text: string }[] = [];
  observe(l: (e: AssistantEvent) => void) {
    this.observers.add(l);
    return () => this.observers.delete(l);
  }
  private emit(e: AssistantEvent) {
    for (const o of this.observers) o(e);
  }
  isBusy = () => false;
  pendingProposals() {
    return this.waiting;
  }
  async send(input: AssistantInput): Promise<Result<null>> {
    const file = input.files?.[0];
    if (file) {
      this.files.push({ name: file.name, text: new TextDecoder().decode(file.data) });
      this.emit({ companyId: input.companyId, type: "text", text: "Read 1 statement: 2 payments" });
      this.waiting.push({
        companyId: input.companyId,
        id: "card-1",
        proposal: batch("Bank statement"),
        shownAt: 1,
      });
      this.emit({
        companyId: input.companyId,
        type: "confirm",
        id: "card-1",
        proposal: batch("Bank statement"),
      });
      return new Promise(() => undefined);
    }
    this.emit({ companyId: input.companyId, type: "text", text: `Echo: ${input.text}` });
    return { ok: true, data: null };
  }
  decide(companyId: string, id: string) {
    this.waiting = this.waiting.filter((w) => w.id !== id);
    queueMicrotask(() =>
      this.emit({
        companyId,
        type: "decided",
        id,
        outcome: {
          status: "batch",
          results: [
            {
              ok: true,
              state: {
                object: "x",
                ref: null,
                presentation: "",
                posted: false,
                deletionMark: false,
                version: "",
              },
            },
          ],
        },
      }),
    );
  }
  async report() {
    return { ok: true as const, data: { report: "balance", data: {}, text: "Assets 1 200 000" } };
  }
  async audit(): Promise<Result<null>> {
    return { ok: true, data: null };
  }
}

const wait = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
};

describe.skipIf(!available)("desktop remote layer against the real server", () => {
  let server: TestServer;
  let base = "";

  beforeAll(async () => {
    server = await startTestServer("platform_remote_e2e");
    base = server.base;
  });

  afterAll(async () => {
    await server?.close();
  });

  const tma = () => ({ authorization: `tma ${server.initData(phone)}`, "content-type": "application/json" });
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: tma(), body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: tma() });
    return (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  it("works end to end: offline, then online; a statement; the Apply guard; an output file", async () => {
    const assistant = new FakeAssistant();
    const state = new RemoteState(join(mkdtempSync(join(tmpdir(), "remote-e2e-")), "remote.json"), secrets);
    const journal: string[] = [];
    const service = new RemoteService({
      state,
      assistant,
      deviceName: "Office PC",
      appVersion: "0.1.300",
      companies: () => [{ id: "company-1", inn: INN, name: "Texmash Import", lastSyncAt: null }],
      authorized: async () => ({ accessToken: server.accessToken, serverUrl: base }),
      onecReachable: async () => true,
      licenseReadOnly: async () => false,
      companyReadOnly: () => false,
      journal: (_company, op) => journal.push(op.intent),
      renderPdf: async () => new Uint8Array([1]),
      backoffMs: [50],
    });

    // Pairing: the desktop asks for a code, the phone opens the link.
    const pairing = await service.connectTelegram();
    expect(pairing.ok).toBe(true);
    if (!pairing.ok) return;
    expect(pairing.data.link).toContain("t.me/platform_bot?start=");
    // The PC was paired but is still offline: stop its channel to start from "off".
    service.stop();
    await server.bot.handle({
      message: { chat: { id: 555 }, from: phone, text: `/start ${pairing.data.code}` },
    });
    state.setPin("2468");

    // 1. A message is sent while the PC is off: it waits, queued.
    const queued = await post("/remote/commands", {
      type: "chat.message",
      company_inn: INN,
      payload: { text: "salom" },
      request_id: randomUUID(),
    });
    expect(queued.status).toBe(201);
    // The PC says hello once; the server needs the company list from it.
    expect((await get(`/remote/commands/${queued.body.id}`)).state).toBe("queued");

    // The PC comes online: delivered, run, answered; the state is done.
    service.start();
    await wait(async () => (await get(`/remote/commands/${queued.body.id}`)).state === "done");
    expect((await get(`/remote/commands/${queued.body.id}`)).result).toMatchObject({ reply: "Echo: salom" });

    // 3. A statement from the phone: uploaded, the command attaches it, the PC reads it.
    const csv = new TextEncoder().encode("date;sum\n2026-05-01;1200000\n");
    const sha = createHash("sha256").update(csv).digest("hex");
    const up = await fetch(`${base}/remote/blobs`, {
      method: "POST",
      headers: {
        ...tma(),
        "content-type": "application/octet-stream",
        "x-file-name": "stmt.csv",
        "x-sha256": sha,
      },
      body: Buffer.from(csv),
    });
    expect(up.status).toBe(201);
    const blob = (await up.json()) as { id: string };
    const attach = await post("/remote/commands", {
      type: "chat.attach",
      company_inn: INN,
      payload: { blob_id: blob.id, name: "stmt.csv" },
      request_id: randomUUID(),
    });
    expect(attach.status).toBe(201);
    await wait(async () => (await get(`/remote/commands/${attach.body.id}`)).state === "done");
    expect((await get(`/remote/commands/${attach.body.id}`)).result.summary).toContain("2 payments");
    expect(assistant.files[0]).toEqual({ name: "stmt.csv", text: "date;sum\n2026-05-01;1200000\n" });

    // The card waits on the PC; the phone lists it.
    const list = await post("/remote/commands", {
      type: "proposal.list",
      company_inn: INN,
      payload: {},
      request_id: randomUUID(),
    });
    await wait(async () => (await get(`/remote/commands/${list.body.id}`)).state === "done");
    const cards = (await get(`/remote/commands/${list.body.id}`)).result.cards as {
      id: string;
      hash: string;
    }[];
    expect(cards.map((c) => c.id)).toEqual(["card-1"]);
    expect(cards[0]?.hash).toBe(proposalHash(batch("Bank statement")));

    // 4. The card changes on the PC after it was shown: an Apply with the old hash is refused, and the phone says why.
    assistant.waiting[0]!.proposal = batch("Bank statement (edited on the PC)");
    const stale = await post("/remote/commands", {
      type: "proposal.apply",
      company_inn: INN,
      payload: { proposal_id: "card-1", pin: "2468" },
      proposal_hash: cards[0]!.hash,
      request_id: randomUUID(),
    });
    await wait(async () => (await get(`/remote/commands/${stale.body.id}`)).state === "failed");
    expect((await get(`/remote/commands/${stale.body.id}`)).error).toMatchObject({
      code: "PROPOSAL_CHANGED",
    });

    // The phone opens the card again and applies it with the new hash and the PIN.
    const fresh = await post("/remote/commands", {
      type: "proposal.apply",
      company_inn: INN,
      payload: { proposal_id: "card-1", pin: "2468" },
      proposal_hash: proposalHash(batch("Bank statement (edited on the PC)")),
      request_id: randomUUID(),
    });
    await wait(async () => (await get(`/remote/commands/${fresh.body.id}`)).state === "done");
    expect((await get(`/remote/commands/${fresh.body.id}`)).result).toMatchObject({ created: 1, refused: 0 });

    // 10. A report becomes an Excel file the phone downloads.
    const report = await post("/remote/commands", {
      type: "report.make",
      company_inn: INN,
      payload: { report: "balance", format: "xlsx", lang: "ru" },
      request_id: randomUUID(),
    });
    await wait(async () => (await get(`/remote/commands/${report.body.id}`)).state === "done");
    const done = await get(`/remote/commands/${report.body.id}`);
    expect(done.blobs).toHaveLength(1);
    const file = await fetch(`${base}/remote/blobs/${done.blobs[0].id}`, { headers: tma() });
    expect(file.status).toBe(200);
    expect((await file.arrayBuffer()).byteLength).toBeGreaterThan(200);

    // 12. Every command left a row in the PC's journal.
    expect(journal.filter((j) => j.startsWith("Telegram @owner")).length).toBeGreaterThanOrEqual(6);
    // 6. Nothing in what the bot said holds an amount or a name.
    for (const m of server.telegram) expect(m.text).not.toMatch(/1[\s ]?200[\s ]?000|Texmash/i);
    service.stop();
  }, 60_000);
});
