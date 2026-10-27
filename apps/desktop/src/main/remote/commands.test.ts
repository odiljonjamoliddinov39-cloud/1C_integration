import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WsCommand } from "@platform/shared";
import { describe, expect, it } from "vitest";

import type { AssistantEvent, AssistantInput, Proposal, Result } from "../../shared/ipc.js";
import type { Operation } from "../engine/journal.js";
import type { SecretBox } from "../store.js";
import { type RemoteAssistant, RemoteCommands, cardOf, phoneBlock, proposalHash } from "./commands.js";
import { RemoteState } from "./state.js";

const secrets: SecretBox = { encrypt: (p) => `enc:${p}`, decrypt: (e) => e.slice(4) };

const A = { id: "company-a", inn: "111111111", name: "Texmash Import", lastSyncAt: "2026-05-01T10:00:00Z" };
const B = { id: "company-b", inn: "222222222", name: "Other LLC", lastSyncAt: null };

const batch = (over: Partial<Extract<Proposal, { kind: "batch" }>> = {}): Proposal => ({
  kind: "batch",
  title: "Bank statement 2026-05",
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
  ...over,
});

/** The assistant as the remote layer sees it: scripted by the test, emitting the events the real one does. */
class FakeAssistant implements RemoteAssistant {
  observers = new Set<(e: AssistantEvent) => void>();
  waiting: { companyId: string; id: string; proposal: Proposal; shownAt: number }[] = [];
  busy = new Set<string>();
  sent: AssistantInput[] = [];
  decisions: { id: string; approve: boolean }[] = [];
  script: (
    input: AssistantInput,
    emit: (e: AssistantEvent["type"] extends never ? never : Record<string, unknown>) => void,
  ) => Promise<Result<null>> = async () => ({ ok: true, data: null });
  outcomeOnApprove: Extract<AssistantEvent, { type: "decided" }>["outcome"] = {
    status: "batch",
    results: [
      {
        ok: true,
        state: { object: "x", ref: null, presentation: "", posted: false, deletionMark: false, version: "" },
      },
      null,
    ],
  };

  emit(event: AssistantEvent) {
    for (const o of this.observers) o(event);
  }
  observe(l: (e: AssistantEvent) => void) {
    this.observers.add(l);
    return () => this.observers.delete(l);
  }
  isBusy(id: string) {
    return this.busy.has(id);
  }
  pendingProposals() {
    return this.waiting;
  }
  async send(input: AssistantInput) {
    this.sent.push(input);
    return this.script(input, (e) => this.emit({ companyId: input.companyId, ...e } as AssistantEvent));
  }
  decide(companyId: string, id: string, approve: boolean) {
    this.decisions.push({ id, approve });
    this.waiting = this.waiting.filter((w) => w.id !== id);
    queueMicrotask(() =>
      this.emit({
        companyId,
        type: "decided",
        id,
        outcome: approve ? this.outcomeOnApprove : { status: "declined" },
      }),
    );
  }
  reports: Record<string, unknown>[] = [];
  async report(input: Record<string, unknown>) {
    this.reports.push(input);
    return {
      ok: true as const,
      data: { report: String(input.report), data: {}, text: `Assets 1 200 000\nLiabilities 300 000` },
    };
  }
  async audit(input: { companyId: string }) {
    this.emit({
      companyId: input.companyId,
      type: "audit",
      audit: {
        from: "2026-01-01",
        to: "2026-05-31",
        language: "en",
        finished: true,
        checks: [{ id: "c1", section: "Cash", title: "Cash is not negative", status: "ok", summary: "fine" }],
      },
    });
    return { ok: true as const, data: null };
  }
}

function setup(over: { license?: boolean; readOnlyCompany?: boolean } = {}) {
  const state = new RemoteState(join(mkdtempSync(join(tmpdir(), "remote-cmd-")), "r.json"), secrets);
  state.setPin("4321");
  const assistant = new FakeAssistant();
  const journal: { company: string; op: Operation }[] = [];
  const uploads: { commandId: string; name: string; size: number }[] = [];
  const downloads = new Map<string, Uint8Array>();
  const runner = new RemoteCommands({
    state,
    assistant,
    companies: () => [A, B],
    onecReachable: async () => true,
    licenseReadOnly: async () => over.license === true,
    companyReadOnly: () => over.readOnlyCompany === true,
    appVersion: "9.9.9",
    files: {
      download: async (id) => {
        const data = downloads.get(id);
        if (!data) throw new Error("gone");
        return { data, sha256: createHash("sha256").update(data).digest("hex") };
      },
      upload: async (commandId, name, data) => {
        uploads.push({ commandId, name, size: data.byteLength });
        return {
          id: "11111111-1111-4111-8111-111111111111",
          name,
          size: data.byteLength,
          sha256: "a".repeat(64),
        };
      },
    },
    journal: (company, op) => journal.push({ company, op }),
    renderPdf: async () => new Uint8Array([37, 80, 68, 70]),
  });
  return { state, assistant, runner, journal, uploads, downloads };
}

let counter = 0;
const cmd = (over: Partial<WsCommand> & Pick<WsCommand, "command_type">): WsCommand => ({
  type: "command",
  id: `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  class:
    over.command_type === "proposal.apply"
      ? "apply"
      : over.command_type === "chat.attach"
        ? "prepare"
        : "read",
  company_inn: A.inn,
  payload: {},
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  ceiling: "apply",
  telegram_user: "42",
  ...over,
});
const noop = () => undefined;

describe("RemoteCommands: the checks the PC makes itself", () => {
  it("runs nothing while the kill switch is off", async () => {
    const t = setup();
    t.state.setEnabled(false);
    expect(await t.runner.run(cmd({ command_type: "status.get" }), noop)).toMatchObject({
      ok: false,
      error: { code: "DISABLED" },
    });
  });

  it("refuses a request that waited past its time to live", async () => {
    const t = setup();
    const out = await t.runner.run(
      cmd({ command_type: "status.get", expires_at: new Date(Date.now() - 1000).toISOString() }),
      noop,
    );
    expect(out).toMatchObject({ ok: false, error: { code: "EXPIRED" } });
  });

  it("never runs a command for company A in company B: the company is found by its INN", async () => {
    const t = setup();
    t.assistant.script = async (input, emit) => {
      emit({ type: "text", text: `answered for ${input.companyId}` });
      return { ok: true, data: null };
    };
    const out = await t.runner.run(
      cmd({ command_type: "chat.message", class: "prepare", company_inn: B.inn, payload: { text: "hello" } }),
      noop,
    );
    expect(t.assistant.sent.map((s) => s.companyId)).toEqual([B.id]);
    expect(out).toMatchObject({ ok: true, result: { reply: "answered for company-b" } });
    const unknown = await t.runner.run(cmd({ command_type: "status.get", company_inn: "999999999" }), noop);
    expect(unknown).toMatchObject({ ok: false, error: { code: "COMPANY_NOT_FOUND" } });
  });

  it("applies the PC's own ceiling, whatever the server says", async () => {
    const t = setup();
    t.state.setCeiling("read");
    const out = await t.runner.run(
      cmd({
        command_type: "chat.attach",
        payload: { blob_id: "11111111-1111-4111-8111-111111111111", name: "a.xlsx" },
      }),
      noop,
    );
    expect(out).toMatchObject({ ok: false, error: { code: "CEILING" } });
    // The link's ceiling is checked too.
    t.state.setCeiling("apply");
    const low = await t.runner.run(
      cmd({
        command_type: "proposal.apply",
        ceiling: "prepare",
        payload: { proposal_id: "p" },
        proposal_hash: "a".repeat(64),
      }),
      noop,
    );
    expect(low).toMatchObject({ ok: false, error: { code: "CEILING" } });
  });

  it("refuses a class that does not belong to the command type", async () => {
    const t = setup();
    const out = await t.runner.run(
      cmd({
        command_type: "proposal.apply",
        class: "read",
        payload: { proposal_id: "p" },
        proposal_hash: "a".repeat(64),
      }),
      noop,
    );
    expect(out).toMatchObject({ ok: false, error: { code: "CLASS_MISMATCH" } });
  });

  it("an expired license allows Read and refuses Prepare and Apply", async () => {
    const t = setup({ license: true });
    expect(await t.runner.run(cmd({ command_type: "status.get" }), noop)).toMatchObject({ ok: true });
    expect(
      await t.runner.run(
        cmd({ command_type: "chat.message", class: "prepare", payload: { text: "hi" } }),
        noop,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "LICENSE_READ_ONLY" },
    });
    expect(
      await t.runner.run(
        cmd({
          command_type: "proposal.apply",
          payload: { proposal_id: "p", pin: "4321" },
          proposal_hash: "a".repeat(64),
        }),
        noop,
      ),
    ).toMatchObject({ ok: false, error: { code: "LICENSE_READ_ONLY" } });
  });

  it("a company over the plan's limit can only be read", async () => {
    const t = setup({ readOnlyCompany: true });
    expect(await t.runner.run(cmd({ command_type: "proposal.list" }), noop)).toMatchObject({ ok: true });
    expect(
      await t.runner.run(
        cmd({ command_type: "chat.message", class: "prepare", payload: { text: "hi" } }),
        noop,
      ),
    ).toMatchObject({
      error: { code: "COMPANY_READ_ONLY" },
    });
  });

  it("a payload that is not the command's is refused before anything runs", async () => {
    const t = setup();
    const out = await t.runner.run(
      cmd({ command_type: "chat.message", class: "prepare", payload: { text: "" } }),
      noop,
    );
    expect(out).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(t.assistant.sent).toHaveLength(0);
  });
});

describe("RemoteCommands: Read", () => {
  it("status.get says what the PC knows", async () => {
    const t = setup();
    expect(await t.runner.run(cmd({ command_type: "status.get" }), noop)).toEqual({
      ok: true,
      result: {
        online: true,
        onec_reachable: true,
        company: "Texmash Import",
        app_version: "9.9.9",
        last_import: "2026-05-01T10:00:00Z",
      },
      blobs: [],
    });
  });

  it("proposal.list shows the cards waiting in this company only, with hashes", async () => {
    const t = setup();
    const mine = batch();
    t.assistant.waiting = [
      { companyId: A.id, id: "p1", proposal: mine, shownAt: 1 },
      { companyId: B.id, id: "p2", proposal: batch({ title: "Other" }), shownAt: 2 },
    ];
    const out = await t.runner.run(cmd({ command_type: "proposal.list" }), noop);
    expect(out).toMatchObject({ ok: true });
    const cards = (out.result as { cards: { id: string; hash: string; status: string; lines: string[] }[] })
      .cards;
    expect(cards.map((c) => c.id)).toEqual(["p1"]);
    expect(cards[0]?.hash).toBe(proposalHash(mine));
    expect(cards[0]?.status).toBe("waiting");
    expect(cards[0]?.lines[0]).toContain("Сумма: 1200000");
  });

  it("a proposal that posts or changes existing documents is shown but cannot be applied from the phone", () => {
    const posting = batch();
    if (posting.kind === "batch" && posting.items[0]?.preview) posting.items[0].preview.willPost = true;
    expect(phoneBlock(posting)).toMatch(/posting/i);
    expect(cardOf("p", posting).status).toBe("refused");
    const update = batch();
    if (update.kind === "batch" && update.items[0]) update.items[0].action = "update";
    expect(phoneBlock(update)).toMatch(/existing/i);
    expect(phoneBlock(batch())).toBeNull();
  });

  it("report.make builds an Excel file, sends it as an output and summarizes it", async () => {
    const t = setup();
    const c = cmd({
      command_type: "report.make",
      payload: { report: "balance", format: "xlsx", to: "2026-05-31", lang: "en" },
    });
    const out = await t.runner.run(c, noop);
    expect(out).toMatchObject({ ok: true, result: { summary: expect.stringContaining("Assets") } });
    expect(out.blobs).toHaveLength(1);
    expect(t.uploads[0]).toMatchObject({ commandId: c.id, name: "balance-111111111-20260531.xlsx" });
    expect(t.uploads[0]?.size).toBeGreaterThan(200);
    expect(t.assistant.reports[0]).toMatchObject({
      report: "balance",
      companyId: A.id,
      lang: "en",
      date: "2026-05-31",
    });
  });

  it("report.make renders a PDF, and debts is receivables plus payables", async () => {
    const t = setup();
    const out = await t.runner.run(
      cmd({ command_type: "report.make", payload: { report: "debts", format: "pdf" } }),
      noop,
    );
    expect(out).toMatchObject({ ok: true });
    expect(t.assistant.reports.map((r) => r.report)).toEqual(["receivables", "payables"]);
    expect(t.uploads[0]?.name.endsWith(".pdf")).toBe(true);
  });

  it("the audit report runs the checklist and lists each check", async () => {
    const t = setup();
    const out = await t.runner.run(
      cmd({
        command_type: "report.make",
        payload: { report: "audit", format: "xlsx", from: "2026-01-01", to: "2026-05-31" },
      }),
      noop,
    );
    expect(out).toMatchObject({
      ok: true,
      result: { summary: expect.stringContaining("Cash is not negative") },
    });
  });
});

describe("RemoteCommands: Prepare", () => {
  it("a message is answered with the assistant's reply, in the company's own chat", async () => {
    const t = setup();
    t.assistant.script = async (_i, emit) => {
      emit({ type: "tool", name: "run_query", detail: "SELECT secret amount 1 200 000" });
      emit({ type: "text", text: "Cash is " });
      emit({ type: "text", text: "1 200 000" });
      return { ok: true, data: null };
    };
    const progress: string[] = [];
    const out = await t.runner.run(
      cmd({ command_type: "chat.message", class: "prepare", payload: { text: "cash?" } }),
      (p) => progress.push(p),
    );
    expect(out).toMatchObject({ ok: true, result: { reply: "Cash is 1 200 000", cards: [] } });
    // The progress the phone sees is the tool's name, never its detail.
    expect(progress).toEqual(["run_query"]);
    expect(t.assistant.sent[0]).toEqual({ companyId: A.id, text: "cash?" });
  });

  it("returns at the first card instead of waiting for the answer, and the card then waits in the list", async () => {
    const t = setup();
    t.assistant.script = (_i, emit) =>
      new Promise((resolve) => {
        emit({ type: "text", text: "12 payments prepared" });
        emit({ type: "confirm", id: "p1", proposal: batch() });
        // The real assistant now waits for decide(); this one never ends in the test.
        void resolve;
      });
    const out = await t.runner.run(
      cmd({ command_type: "chat.message", class: "prepare", payload: { text: "enter the statement" } }),
      noop,
    );
    expect(out).toMatchObject({ ok: true, result: { reply: "12 payments prepared" } });
    const cards = (out.result as { cards: { id: string; hash: string }[] }).cards;
    expect(cards[0]).toMatchObject({ id: "p1", hash: proposalHash(batch()) });
  });

  it("a message that may only ask is declined on the PC when the assistant wants to propose", async () => {
    const t = setup();
    t.assistant.script = (_i, emit) =>
      new Promise(() => {
        emit({ type: "confirm", id: "p1", proposal: batch() });
      });
    const out = await t.runner.run(
      cmd({ command_type: "chat.message", class: "read", payload: { text: "enter it" } }),
      noop,
    );
    expect(out).toMatchObject({ ok: false, error: { code: "PREPARE_NOT_ALLOWED" } });
    expect(t.assistant.decisions).toEqual([{ id: "p1", approve: false }]);
  });

  it("does not interrupt a question the person is asking on the PC", async () => {
    const t = setup();
    t.assistant.busy.add(A.id);
    const out = await t.runner.run(
      cmd({ command_type: "chat.message", class: "prepare", payload: { text: "hi" } }),
      noop,
    );
    expect(out).toMatchObject({ ok: false, error: { code: "BUSY" } });
    expect(t.assistant.sent).toHaveLength(0);
  });

  it("an error of the assistant comes back as the command's error", async () => {
    const t = setup();
    t.assistant.script = async () => ({
      ok: false,
      code: "AI_DISABLED",
      message: "Turn the assistant on first",
    });
    expect(
      await t.runner.run(
        cmd({ command_type: "chat.message", class: "prepare", payload: { text: "hi" } }),
        noop,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "AI_DISABLED" },
    });
  });

  it("a file from the phone is read as if it was attached on the PC", async () => {
    const t = setup();
    const bytes = new TextEncoder().encode("date;sum\n2026-05-01;1000");
    t.downloads.set("22222222-2222-4222-8222-222222222222", bytes);
    t.assistant.script = async (_i, emit) => {
      emit({ type: "text", text: "Read 1 statement: 1 payment" });
      return { ok: true, data: null };
    };
    const out = await t.runner.run(
      cmd({
        command_type: "chat.attach",
        payload: { blob_id: "22222222-2222-4222-8222-222222222222", name: "stmt.csv" },
      }),
      noop,
    );
    expect(out).toMatchObject({ ok: true, result: { summary: "Read 1 statement: 1 payment" } });
    expect(t.assistant.sent[0]).toMatchObject({ companyId: A.id, text: "" });
    expect(t.assistant.sent[0]?.files?.[0]).toMatchObject({ name: "stmt.csv" });
  });

  it("a damaged or missing file is a failed command, not a run", async () => {
    const t = setup();
    expect(
      await t.runner.run(
        cmd({
          command_type: "chat.attach",
          payload: { blob_id: "33333333-3333-4333-8333-333333333333", name: "x.csv" },
        }),
        noop,
      ),
    ).toMatchObject({ ok: false, error: { code: "FILE_LOST" } });
    expect(t.assistant.sent).toHaveLength(0);
  });
});

describe("RemoteCommands: Apply", () => {
  const applyCmd = (id: string, hash: string, pin = "4321") =>
    cmd({ command_type: "proposal.apply", payload: { proposal_id: id, pin }, proposal_hash: hash });

  it("applies a proposal the user confirmed, with its hash and the PIN, and reports what was made", async () => {
    const t = setup();
    const proposal = batch();
    t.assistant.waiting = [{ companyId: A.id, id: "p1", proposal, shownAt: 1 }];
    const out = await t.runner.run(applyCmd("p1", proposalHash(proposal)), noop);
    expect(out).toMatchObject({ ok: true, result: { created: 1, skipped: 1, refused: 0, reasons: [] } });
    expect(t.assistant.decisions).toEqual([{ id: "p1", approve: true }]);
  });

  it("refuses when the proposal changed on the PC after it was shown (the hash differs), and says why", async () => {
    const t = setup();
    const shown = batch();
    const changed = batch({ title: "Bank statement 2026-05 (edited)" });
    t.assistant.waiting = [{ companyId: A.id, id: "p1", proposal: changed, shownAt: 1 }];
    const out = await t.runner.run(applyCmd("p1", proposalHash(shown)), noop);
    expect(out).toMatchObject({ ok: false, error: { code: "PROPOSAL_CHANGED" } });
    expect(t.assistant.decisions).toEqual([]);
  });

  it("refuses a proposal that is no longer waiting (already applied, or from another company)", async () => {
    const t = setup();
    const proposal = batch();
    t.assistant.waiting = [{ companyId: B.id, id: "p9", proposal, shownAt: 1 }];
    expect(await t.runner.run(applyCmd("p9", proposalHash(proposal)), noop)).toMatchObject({
      ok: false,
      error: { code: "PROPOSAL_GONE" },
    });
    expect(await t.runner.run(applyCmd("nope", proposalHash(proposal)), noop)).toMatchObject({
      ok: false,
      error: { code: "PROPOSAL_GONE" },
    });
  });

  it("needs the PIN: none set, a wrong one, and too many wrong ones", async () => {
    const t = setup();
    const proposal = batch();
    t.assistant.waiting = [{ companyId: A.id, id: "p1", proposal, shownAt: 1 }];
    expect(await t.runner.run(applyCmd("p1", proposalHash(proposal), "0000"), noop)).toMatchObject({
      error: { code: "PIN_WRONG" },
    });
    const noPin = await t.runner.run(
      cmd({
        command_type: "proposal.apply",
        payload: { proposal_id: "p1" },
        proposal_hash: proposalHash(proposal),
      }),
      noop,
    );
    expect(noPin).toMatchObject({ error: { code: "PIN_WRONG" } });
    t.state.clearPin();
    expect(await t.runner.run(applyCmd("p1", proposalHash(proposal)), noop)).toMatchObject({
      error: { code: "PIN_NOT_SET" },
    });
    expect(t.assistant.decisions).toEqual([]);
    t.state.setPin("4321");
    for (let i = 0; i < 5; i++) await t.runner.run(applyCmd("p1", proposalHash(proposal), "1111"), noop);
    expect(await t.runner.run(applyCmd("p1", proposalHash(proposal)), noop)).toMatchObject({
      error: { code: "PIN_LOCKED" },
    });
  });

  it("will not post or change existing documents from the phone", async () => {
    const t = setup();
    const posting = batch();
    if (posting.kind === "batch" && posting.items[0]?.preview) posting.items[0].preview.willPost = true;
    t.assistant.waiting = [{ companyId: A.id, id: "p1", proposal: posting, shownAt: 1 }];
    expect(await t.runner.run(applyCmd("p1", proposalHash(posting)), noop)).toMatchObject({
      error: { code: "NOT_FROM_PHONE" },
    });
    expect(t.assistant.decisions).toEqual([]);
  });

  it("what 1C refused is counted with its reason", async () => {
    const t = setup();
    const proposal = batch();
    t.assistant.waiting = [{ companyId: A.id, id: "p1", proposal, shownAt: 1 }];
    t.assistant.outcomeOnApprove = {
      status: "batch",
      results: [{ ok: false, code: "FILL_CHECK", message: "Counterparty is empty" }],
    };
    expect(await t.runner.run(applyCmd("p1", proposalHash(proposal)), noop)).toMatchObject({
      ok: true,
      result: { created: 0, refused: 1, reasons: ["FILL_CHECK: Counterparty is empty"] },
    });
  });
});

describe("RemoteCommands: the log", () => {
  it("writes every command, run or refused, to the PC's journal and the Settings log, without content", async () => {
    const t = setup();
    t.state.setEnabled(true);
    await t.runner.run(cmd({ command_type: "status.get", telegram_user: "777" }), noop);
    await t.runner.run(
      cmd({ command_type: "chat.message", class: "prepare", payload: { text: "secret amount 5 000 000" } }),
      noop,
    );
    t.state.setCeiling("read");
    await t.runner.run(
      cmd({
        command_type: "chat.attach",
        payload: { blob_id: "22222222-2222-4222-8222-222222222222", name: "s.csv" },
      }),
      noop,
    );
    const rows = t.state.journal();
    expect(rows.map((r) => [r.type, r.status])).toEqual([
      ["chat.attach", "refused"],
      ["chat.message", "done"],
      ["status.get", "done"],
    ]);
    expect(rows[2]?.telegramUser).toBe("777");
    expect(t.journal).toHaveLength(3);
    expect(t.journal[0]?.op.intent).toContain("Telegram 777");
    expect(JSON.stringify(t.journal)).not.toContain("5 000 000");
    expect(JSON.stringify(rows)).not.toContain("5 000 000");
  });
});
