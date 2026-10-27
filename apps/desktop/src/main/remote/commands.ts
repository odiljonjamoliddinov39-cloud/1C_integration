/**
 * Maps each remote command to what the desktop already does: the assistant answers a message, reads a file,
 * lists and applies the cards it made; the report worker makes a report. The remote layer adds no accounting
 * logic of its own: 1C writes stay unposted, ExternalID is checked by the existing tools, and an error comes
 * back as {code, message}. The PC never trusts the server alone: the kill switch, the company, the class
 * against the PC's own ceiling, the time to live, the license and (for Apply) the hash of the proposal and the
 * PIN are all checked here.
 */
import { createHash, randomUUID } from "node:crypto";

import { classAllowed, classOf, parsePayload, type ProposalCard, type WsCommand } from "@platform/shared";

import type {
  AssistantEvent,
  AssistantInput,
  AuditView,
  BatchItem,
  Proposal,
  ProposalOutcome,
  ReportRunInput,
  ReportView,
  Result,
} from "../../shared/ipc.js";
import { ATTACHMENTS } from "../../shared/ipc.js";
import { newOperation } from "../engine/journal.js";
import type { CommandRunner, RunOutcome } from "./client.js";
import { makeXlsx, type Cell } from "./xlsx.js";
import { sha256, type RemoteState } from "./state.js";

/** The part of the assistant the remote layer uses. */
export interface RemoteAssistant {
  send(input: AssistantInput): Promise<Result<null>>;
  decide(companyId: string, proposalId: string, approve: boolean): void;
  observe(listener: (event: AssistantEvent) => void): () => void;
  isBusy(companyId: string): boolean;
  pendingProposals(): { companyId: string; id: string; proposal: Proposal; shownAt: number }[];
  report(input: ReportRunInput): Promise<Result<ReportView>>;
  audit(input: {
    companyId: string;
    chatId: string;
    from: string;
    to: string;
    language: "en" | "ru" | "uz";
  }): Promise<Result<null>>;
}

export interface RemoteCompanyInfo {
  id: string;
  inn: string;
  name: string;
  lastSyncAt: string | null;
}

export interface CommandDeps {
  state: RemoteState;
  assistant: RemoteAssistant;
  companies: () => RemoteCompanyInfo[];
  /** Whether 1C answers for the company (a ping with its own short limit). */
  onecReachable: (companyId: string) => Promise<boolean>;
  /** The license is read-only (expired, suspended, another machine): then only Read commands run. */
  licenseReadOnly: () => Promise<boolean>;
  /** The plan keeps this company read-only (over the plan's limit). */
  companyReadOnly: (inn: string) => boolean;
  appVersion: string;
  files: {
    download: (blobId: string) => Promise<{ data: Uint8Array; sha256: string }>;
    upload: (
      commandId: string,
      name: string,
      data: Uint8Array,
    ) => Promise<{
      id: string;
      name: string;
      size: number;
      sha256: string;
    }>;
  };
  /** Writes the command to the company's journal on the PC. */
  journal: (companyId: string, operation: ReturnType<typeof newOperation>) => void;
  /** Prints an HTML page to a PDF (Electron); absent in tests that make no PDF. */
  renderPdf?: (html: string) => Promise<Uint8Array>;
  now?: () => number;
}

const fail = (code: string, message: string): RunOutcome => ({
  ok: false,
  blobs: [],
  error: { code, message },
});
const ok = (result: unknown, blobs: RunOutcome["blobs"] = []): RunOutcome => ({ ok: true, result, blobs });

/** JSON with keys in order, so the same proposal always hashes the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** The hash of what a card shows: an Apply carries it, and the PC refuses the Apply if the card changed since. */
export const proposalHash = (proposal: Proposal): string => sha256(stable(proposal));

const cut = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const show = (value: unknown): string =>
  value === null || value === undefined
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

const shortObject = (object: string) => object.replace(/^(Документ|Справочник)\./, "");

/** A batch item as one line the phone shows: what is made, and its main fields. */
function itemLine(item: BatchItem, index: number): string {
  const head = `${index + 1}. ${item.action} ${shortObject(item.object)}`;
  if (item.error) return cut(`${head} — ${item.error.message}`);
  const fields = (item.preview?.changes ?? [])
    .filter((c) => c.after !== null && c.after !== undefined && c.after !== "")
    .slice(0, 6)
    .map((c) => `${c.field}: ${show(c.after)}`);
  return cut(fields.length > 0 ? `${head} — ${fields.join("; ")}` : head);
}

/** Why this proposal cannot be applied from the phone, or null when it can. */
export function phoneBlock(proposal: Proposal): string | null {
  switch (proposal.kind) {
    case "batch": {
      const live = proposal.items.filter((item) => !item.error);
      if (live.some((item) => item.action !== "create"))
        return "It changes existing documents: apply it on the PC";
      if (live.some((item) => item.preview?.willPost))
        return "It posts documents: posting is not available from the phone";
      return null;
    }
    case "change":
      if (proposal.preview.action !== "create") return "It changes an existing object: apply it on the PC";
      if (proposal.preview.willPost) return "It posts a document: posting is not available from the phone";
      return null;
    case "invoice_issued":
    case "invoice_received":
      return null;
    default:
      return "This one is confirmed on the PC";
  }
}

/** A card as the Mini App shows it. */
export function cardOf(
  id: string,
  proposal: Proposal,
  status: ProposalCard["status"] = "waiting",
): ProposalCard {
  let title: string;
  let lines: string[];
  switch (proposal.kind) {
    case "batch": {
      title = proposal.title;
      lines = proposal.items.map(itemLine);
      break;
    }
    case "change": {
      title = `${proposal.preview.action} ${shortObject(proposal.preview.object)}`.trim();
      lines = proposal.preview.changes.slice(0, 12).map((c) => cut(`${c.field}: ${show(c.after)}`));
      break;
    }
    case "invoice_issued":
      title = "Invoice issued";
      lines = [cut(show(proposal.sale))];
      break;
    case "invoice_received":
      title = "Invoice received";
      lines = [cut(show(proposal.invoice))];
      break;
    default:
      title = proposal.kind;
      lines = [];
  }
  const block = phoneBlock(proposal);
  if (block) lines = [block, ...lines];
  if (lines.length > 50) lines = [...lines.slice(0, 49), `… +${lines.length - 49}`];
  return {
    id,
    title: cut(title, 200),
    lines,
    hash: proposalHash(proposal),
    status: block && status === "waiting" ? "refused" : status,
  };
}

const today = () => new Date().toISOString().slice(0, 10);

export class RemoteCommands implements CommandRunner {
  /** Companies whose assistant is answering a phone's message right now (the phone gets the card in the answer). */
  private readonly asking = new Map<string, number>();

  constructor(private readonly deps: CommandDeps) {}

  /** True while a phone's own message is being answered for the company: a card made then needs no notification. */
  isAsking(companyId: string): boolean {
    return (this.asking.get(companyId) ?? 0) > 0;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async run(command: WsCommand, progress: (text: string) => void): Promise<RunOutcome> {
    const started = this.now();
    const company = this.deps.companies().find((c) => c.inn === command.company_inn);
    const outcome = await this.guarded(command, company, progress);
    this.record(command, company, outcome, started);
    return outcome;
  }

  /** Every command is written to the journal of the PC (and the Settings screen's log): who asked, what, how it ended. No content. */
  private record(
    command: WsCommand,
    company: RemoteCompanyInfo | undefined,
    outcome: RunOutcome,
    started: number,
  ): void {
    const code = outcome.error?.code;
    const status: "done" | "failed" | "refused" | "expired" = outcome.ok
      ? "done"
      : code === "EXPIRED"
        ? "expired"
        : code && REFUSALS.has(code)
          ? "refused"
          : "failed";
    this.deps.state.log({
      id: command.id,
      type: command.command_type,
      class: command.class,
      companyInn: command.company_inn,
      telegramUser: command.telegram_user,
      status,
      ...(code ? { code } : {}),
    });
    if (!company) return;
    try {
      this.deps.journal(
        company.id,
        newOperation(
          `Telegram ${command.telegram_user}: ${command.command_type} (${command.id})`,
          [
            {
              function: command.command_type,
              decision: "rule",
              durationMs: this.now() - started,
              ...(code ? { error: code } : {}),
            },
          ],
          outcome.ok ? "done" : "failed",
        ),
      );
    } catch {
      // The journal never stops a command.
    }
  }

  private async guarded(
    command: WsCommand,
    company: RemoteCompanyInfo | undefined,
    progress: (text: string) => void,
  ): Promise<RunOutcome> {
    const { state } = this.deps;
    if (!state.enabled) return fail("DISABLED", "Remote control is switched off on this PC");
    if (Date.parse(command.expires_at) < this.now())
      return fail("EXPIRED", "The request waited too long and was not run");
    const type = command.command_type;
    // The class a command has is fixed by its type (a message is a Read or a Prepare one by the link's ceiling).
    const expected = type === "chat.message" ? command.class : classOf(type, "apply");
    if (command.class !== expected || (type === "chat.message" && command.class === "apply"))
      return fail("CLASS_MISMATCH", "The request's class does not match its type");
    if (!classAllowed(state.ceiling, command.class) || !classAllowed(command.ceiling, command.class))
      return fail("CEILING", `This phone may not do ${command.class} requests on this PC`);
    if (!company) return fail("COMPANY_NOT_FOUND", "This company is not connected on the PC");
    if (command.class !== "read" && (await this.deps.licenseReadOnly()))
      return fail("LICENSE_READ_ONLY", "The license is read-only: the phone can only read");
    if (command.class !== "read" && this.deps.companyReadOnly(company.inn))
      return fail("COMPANY_READ_ONLY", "This company is over the plan's limit: it can only be read");
    const parsed = parsePayload({
      type,
      payload: command.payload,
      ...(command.proposal_hash ? { proposal_hash: command.proposal_hash } : {}),
    });
    if (!parsed.ok) return fail("VALIDATION", parsed.message);
    const payload = parsed.payload as Record<string, unknown>;
    switch (type) {
      case "status.get":
        return this.status(company);
      case "proposal.list":
        return this.list(company);
      case "chat.message":
        return this.converse(company, String(payload.text), command.class === "read", progress);
      case "chat.attach":
        return this.attach(company, String(payload.blob_id), String(payload.name), progress);
      case "proposal.apply":
        return this.apply(
          company,
          String(payload.proposal_id),
          command.proposal_hash ?? "",
          payload.pin === undefined ? undefined : String(payload.pin),
        );
      case "proposal.decline":
        return this.decline(company, String(payload.proposal_id));
      case "report.make":
        return this.report(command, company, payload, progress);
    }
  }

  // ---- Read ----

  private async status(company: RemoteCompanyInfo): Promise<RunOutcome> {
    const reachable = await this.deps.onecReachable(company.id).catch(() => false);
    return ok({
      online: true,
      onec_reachable: reachable,
      company: company.name,
      app_version: this.deps.appVersion,
      last_import: company.lastSyncAt,
    });
  }

  private waiting(company: RemoteCompanyInfo) {
    return this.deps.assistant.pendingProposals().filter((p) => p.companyId === company.id);
  }

  private list(company: RemoteCompanyInfo): RunOutcome {
    return ok({ cards: this.waiting(company).map((p) => cardOf(p.id, p.proposal)) });
  }

  // ---- Prepare ----

  /** One message (or a file) through the assistant, as if typed on the PC; ends at its answer or at its first card. */
  private async converse(
    company: RemoteCompanyInfo,
    text: string,
    readOnly: boolean,
    progress: (text: string) => void,
    files: AssistantInput["files"] = [],
  ): Promise<RunOutcome & { summary?: string }> {
    const { assistant } = this.deps;
    if (assistant.isBusy(company.id))
      // A card nobody has answered keeps the assistant waiting: that is not "busy", the card has to be applied or declined.
      return this.waiting(company).length > 0
        ? fail("CARD_WAITING", "A proposal is waiting for an answer: apply or decline it first")
        : fail("BUSY", "The assistant is working on the PC: try again in a minute");
    let reply = "";
    const notices: string[] = [];
    const cards: ProposalCard[] = [];
    let cardId: string | null = null;
    let onCard: () => void = () => undefined;
    const carded = new Promise<void>((resolve) => (onCard = resolve));
    const off = assistant.observe((event) => {
      if (event.companyId !== company.id) return;
      switch (event.type) {
        case "text":
          reply += event.text;
          break;
        case "retry":
          reply = "";
          break;
        case "tool":
          // Only the tool's name: its detail can hold names and amounts.
          progress(event.name);
          break;
        case "notice":
          notices.push(event.message);
          break;
        case "confirm":
          cards.push(cardOf(event.id, event.proposal));
          cardId ??= event.id;
          onCard();
          break;
      }
    });
    this.asking.set(company.id, (this.asking.get(company.id) ?? 0) + 1);
    const sent = assistant.send({ companyId: company.id, text, ...(files.length ? { files } : {}) });
    // The question goes on after a card is shown (it waits for the answer): the phone gets the card now.
    void sent.then(
      () => off(),
      () => off(),
    );
    const first = await Promise.race([sent.then((r) => ({ done: r })), carded.then(() => null)]).finally(
      () => {
        this.asking.set(company.id, Math.max(0, (this.asking.get(company.id) ?? 1) - 1));
      },
    );
    const words = [reply.trim(), ...notices].filter(Boolean).join("\n\n");
    if (first === null) {
      if (readOnly && cardId) {
        // A question that only asks may not make proposals: the card is declined on the PC.
        assistant.decide(company.id, cardId, false);
        void sent.catch(() => undefined);
        return fail(
          "PREPARE_NOT_ALLOWED",
          "This phone may only ask questions: the assistant wanted to make a proposal",
        );
      }
      void sent.catch(() => undefined);
      return { ...ok({ reply: words, cards }), summary: words };
    }
    const result = first.done;
    if (!result.ok) return fail(result.code, result.message);
    return { ...ok({ reply: words, cards }), summary: words };
  }

  private async attach(
    company: RemoteCompanyInfo,
    blobId: string,
    name: string,
    progress: (text: string) => void,
  ): Promise<RunOutcome> {
    let file: { data: Uint8Array; sha256: string };
    try {
      progress("downloading");
      file = await this.deps.files.download(blobId);
    } catch (e) {
      return fail("FILE_LOST", e instanceof Error ? e.message.slice(0, 200) : "The file could not be taken");
    }
    if (sha256Bytes(file.data) !== file.sha256)
      return fail("CHECKSUM", "The file arrived damaged: send it again");
    if (file.data.byteLength > ATTACHMENTS.maxBytes)
      return fail("FILE_TOO_LARGE", "The assistant reads files up to 10 MB");
    const outcome = await this.converse(company, "", false, progress, [
      { name, data: new Uint8Array(file.data) },
    ]);
    if (!outcome.ok) return outcome;
    return ok({ summary: outcome.summary ?? "" });
  }

  // ---- Decline ----

  /** The card is declined as if the user pressed "no" on the PC; the assistant's turn ends and it can take the next message. */
  private async decline(company: RemoteCompanyInfo, proposalId: string): Promise<RunOutcome> {
    const { assistant } = this.deps;
    if (!this.waiting(company).some((p) => p.id === proposalId))
      return fail("PROPOSAL_GONE", "The proposal is no longer waiting: it was applied, declined or closed");
    assistant.decide(company.id, proposalId, false);
    // The turn that showed the card still has to finish; the next message must not meet it as "busy".
    for (let i = 0; i < 75 && assistant.isBusy(company.id); i++) await new Promise((r) => setTimeout(r, 200));
    return ok({ declined: true });
  }

  // ---- Apply ----

  private async apply(
    company: RemoteCompanyInfo,
    proposalId: string,
    hash: string,
    pin: string | undefined,
  ): Promise<RunOutcome> {
    const { state, assistant } = this.deps;
    const pending = this.waiting(company).find((p) => p.id === proposalId);
    if (!pending)
      return fail("PROPOSAL_GONE", "The proposal is no longer waiting: it was applied, declined or closed");
    if (proposalHash(pending.proposal) !== hash)
      return fail("PROPOSAL_CHANGED", "The proposal changed on the PC after it was shown: open it again");
    const block = phoneBlock(pending.proposal);
    if (block) return fail("NOT_FROM_PHONE", block);
    switch (state.checkPin(pin)) {
      case "unset":
        return fail("PIN_NOT_SET", "Set a PIN on the PC (Settings → Remote control) to apply from the phone");
      case "wrong":
        return fail("PIN_WRONG", "The PIN is wrong");
      case "locked":
        return fail("PIN_LOCKED", "Too many wrong PINs: try again in 15 minutes");
      case "ok":
        break;
    }
    let outcome: ProposalOutcome | null = null;
    let onDecided: () => void = () => undefined;
    const decided = new Promise<void>((resolve) => (onDecided = resolve));
    const off = assistant.observe((event) => {
      if (event.type === "decided" && event.id === proposalId) {
        outcome = event.outcome;
        onDecided();
      }
    });
    try {
      assistant.decide(company.id, proposalId, true);
      await decided;
    } finally {
      off();
    }
    return applied(outcome);
  }

  // ---- Read: reports ----

  private async report(
    command: WsCommand,
    company: RemoteCompanyInfo,
    payload: Record<string, unknown>,
    progress: (text: string) => void,
  ): Promise<RunOutcome> {
    const lang = (payload.lang as "uz" | "ru" | "en" | undefined) ?? "ru";
    const kind = payload.report as "audit" | "balance" | "debts" | "vat";
    const format = payload.format as "xlsx" | "pdf";
    const from = payload.from as string | undefined;
    const to = payload.to as string | undefined;
    progress(kind);
    let title = kind;
    let lines: string[];
    if (kind === "audit") {
      const done = await this.audit(company, from ?? `${today().slice(0, 4)}-01-01`, to ?? today(), lang);
      if (!done.ok) return fail(done.code, done.message);
      title = `audit`;
      lines = done.lines;
    } else {
      const asks: Omit<ReportRunInput, "companyId" | "lang">[] =
        kind === "balance"
          ? [{ report: "balance", ...(to ? { date: to } : {}) }]
          : kind === "debts"
            ? [
                { report: "receivables", ...(to ? { date: to } : {}) },
                { report: "payables", ...(to ? { date: to } : {}) },
              ]
            : [{ report: "tax_accrual", ...(from ? { from } : {}), ...(to ? { to } : {}) }];
      lines = [];
      for (const ask of asks) {
        const made = await this.deps.assistant.report({ ...ask, companyId: company.id, lang });
        if (!made.ok) return fail(made.code, made.message);
        lines.push(...made.data.text.split(/\r?\n/), "");
      }
    }
    const name = `${kind}-${company.inn}-${(to ?? today()).replace(/-/g, "")}.${format}`;
    let data: Uint8Array;
    if (format === "xlsx") {
      data = makeXlsx(
        title,
        lines.map((line): Cell[] => [line]),
      );
    } else {
      if (!this.deps.renderPdf) return fail("NOT_SUPPORTED", "This build cannot make a PDF");
      data = await this.deps.renderPdf(reportHtml(company.name, title, lines));
    }
    let blob;
    try {
      blob = await this.deps.files.upload(command.id, name, data);
    } catch (e) {
      return fail(
        "UPLOAD_FAILED",
        e instanceof Error ? e.message.slice(0, 200) : "The file could not be sent",
      );
    }
    const summary = lines
      .filter((l) => l.trim())
      .slice(0, 12)
      .join("\n");
    return ok({ summary: cut(summary, 1500) }, [blob]);
  }

  /** The audit's checklist over the period, one line per check. */
  private async audit(
    company: RemoteCompanyInfo,
    from: string,
    to: string,
    lang: "uz" | "ru" | "en",
  ): Promise<{ ok: true; lines: string[] } | { ok: false; code: string; message: string }> {
    const { assistant } = this.deps;
    if (assistant.isBusy(company.id))
      return {
        ok: false,
        code: "BUSY",
        message: "The assistant is working on the PC: try again in a minute",
      };
    let last: AuditView | null = null;
    const off = assistant.observe((event) => {
      if (event.companyId === company.id && event.type === "audit") last = event.audit;
    });
    let result: Result<null>;
    try {
      result = await assistant.audit({
        companyId: company.id,
        chatId: randomUUID(),
        from,
        to,
        language: lang,
      });
    } finally {
      off();
    }
    if (!result.ok) return result;
    const view = last as AuditView | null;
    const lines = [`${from} – ${to}`, ""];
    for (const check of view?.checks ?? [])
      lines.push(
        `${check.section} · ${check.title}: ${check.status}${check.summary ? ` — ${check.summary}` : ""}`,
      );
    return { ok: true, lines };
  }
}

/** What a batch or a single document made, as the phone's Apply result. */
function applied(outcome: ProposalOutcome | null): RunOutcome {
  if (!outcome) return fail("INTERNAL", "The PC did not report what it made");
  switch (outcome.status) {
    case "batch": {
      const reasons: string[] = [];
      let created = 0;
      let refused = 0;
      let skipped = 0;
      for (const item of outcome.results) {
        if (item === null) skipped += 1;
        else if (item.ok) created += 1;
        else {
          refused += 1;
          reasons.push(cut(`${item.code}: ${item.message}`));
        }
      }
      return ok({ created, skipped, refused, reasons: reasons.slice(0, 50) });
    }
    case "created":
    case "applied":
      return ok({ created: 1, skipped: 0, refused: 0, reasons: [] });
    case "declined":
      return ok({ created: 0, skipped: 1, refused: 0, reasons: ["declined"] });
    case "failed":
      return fail(outcome.code, outcome.message);
    default:
      return ok({ created: 0, skipped: 1, refused: 0, reasons: [outcome.status] });
  }
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function reportHtml(company: string, title: string, lines: string[]): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font:12px/1.5 sans-serif;margin:24px}h1{font-size:16px}p{margin:0;white-space:pre-wrap}</style></head><body><h1>${escapeHtml(company)} · ${escapeHtml(title)}</h1>${lines.map((l) => `<p>${escapeHtml(l) || "&nbsp;"}</p>`).join("")}</body></html>`;
}

const sha256Bytes = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Errors that mean "not allowed here" rather than "went wrong": the log tells them apart. */
const REFUSALS = new Set([
  "DISABLED",
  "CLASS_MISMATCH",
  "CEILING",
  "COMPANY_NOT_FOUND",
  "LICENSE_READ_ONLY",
  "COMPANY_READ_ONLY",
  "PROPOSAL_GONE",
  "CARD_WAITING",
  "PROPOSAL_CHANGED",
  "NOT_FROM_PHONE",
  "PIN_NOT_SET",
  "PIN_WRONG",
  "PIN_LOCKED",
  "PREPARE_NOT_ALLOWED",
]);
