/**
 * The AI assistant's loop (TD §7). Each model turn goes through the control system's AI proxy; the
 * tools it asks for run here, against the company's 1C, and only their results go back. The
 * conversation is sent back unchanged every turn (thinking blocks included, as the API requires)
 * and is saved on this PC, so a chat can be reopened and continued later.
 *
 * Reads run at once. A document the assistant prepares (propose_* tools) is shown to the user as a
 * card and the loop waits: only the user's click writes it to 1C, unposted, and the model is told
 * what happened. Nothing is written while the license is read-only.
 */
import { randomUUID } from "node:crypto";

import {
  AI_TOOLS,
  type AiChatInput,
  type AiContentBlock,
  type AiMessage,
  type AiProposalTool,
  AiToolUse,
  type ChangeBatchInput,
  type ChangeInput,
  type ChangePreview,
  type CreateInvoiceResult,
  type InvoiceIssuedPreview,
  type InvoiceReceivedDraft,
  type ObjectState,
  type ReadAttachmentInput,
  isAiToolName,
  isProposalTool,
} from "@platform/shared";

import type {
  AssistantEvent,
  AssistantInput,
  BatchItem,
  BatchItemResult,
  ChatSummary,
  ChatView,
  Proposal,
  ProposalOutcome,
  Result,
} from "../shared/ipc.js";
import { applyEvent } from "../shared/transcript.js";
import { AttachmentError, type ShrinkImage, readAttachments } from "./attachments.js";
import type { ChatStore, StoredChat } from "./chats.js";
import { readTable } from "./tables.js";
import type { ConnectorRunner } from "./connector.js";
import { ControlError } from "./control-client.js";
import type { ToolResult } from "./onec-jobs.js";
import type { SessionService } from "./session.js";
import type { LocalStore } from "./store.js";

/**
 * Model turns per question: a safety stop for a model going in circles, far above what real work
 * takes (a whole bank statement with checks and cards). The user can stop it at any time. Before
 * the last turn the model is told to answer with what it has found.
 */
const MAX_TURNS = 300;
/** Sent with the tool results before the last turn, so a long check ends with an answer, not an error. */
const LAST_STEP_NOTE =
  "Step limit: this is your last step. Do not call any more tools. Answer now with what you have " +
  "found so far, and say clearly what is still unchecked and how the accountant can check it.";
/** Tool results are cut to this many characters before they go to the model. */
const MAX_RESULT_CHARS = 150_000;
/** Sent when a turn reached the model's output limit with an unfinished answer. */
const CONTINUE_NOTE =
  "Your answer reached the output limit and was cut off. Continue exactly where it stopped, without " +
  "repeating what you already wrote.";
/** Sent with the results when a turn reached the output limit inside a tool call, which was not run. */
const CUT_TOOL_NOTE =
  "Your last tool call reached the output limit and was cut off, so it was not run. Send it again in " +
  "smaller parts (for example propose_changes with at most 50 changes per card, one card after another).";
/**
 * A chat is sent whole every turn and the AI service takes at most 32 MB per request; past this
 * size (mostly attached files) the user starts a new chat.
 */
const MAX_CHAT_CHARS = 24_000_000;
/** Failures worth trying again: the connection, the web server in front of ours, a busy AI service. */
const RETRYABLE = new Set([
  "OFFLINE",
  "SERVER_ERROR",
  "BAD_RESPONSE",
  "AI_BUSY",
  "AI_UNAVAILABLE",
  "RATE_LIMITED",
]);
/** Waits before each further attempt: a server restart or a busy AI service rides through. */
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 40_000];

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export interface AssistantDeps {
  store: LocalStore;
  chats: ChatStore;
  session: SessionService;
  connector: ConnectorRunner;
  emit: (event: AssistantEvent) => void;
  /** Scales photos down before they are sent (Electron's nativeImage); absent in tests. */
  shrinkImage?: ShrinkImage;
  /** Waits between retries of a failed model turn (tests make them short). */
  retryDelaysMs?: readonly number[];
  /** Model turns per question (tests make it small). */
  maxTurns?: number;
}

type Emit = (event: DistributiveOmit<AssistantEvent, "companyId">) => void;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class AssistantService {
  /** Per company: the open chat. */
  private readonly open = new Map<string, StoredChat>();
  private readonly running = new Map<string, AbortController>();
  /** Per company: the card waiting for the user's answer. */
  private readonly waiting = new Map<string, { id: string; answer: (approve: boolean) => void }>();
  /**
   * Per chat: changes already sent back once for 1C's filling-check warnings. The same change sent
   * again unchanged could not be fixed, and is shown with its warnings.
   */
  private readonly checked = new Map<string, Set<string>>();
  /** Per company: time the current task's cards waited for the user, left out of its work time. */
  private readonly cardWaitMs = new Map<string, number>();

  constructor(private readonly deps: AssistantDeps) {}

  async send({ companyId, chatId, text, files = [] }: AssistantInput): Promise<Result<null>> {
    const notify: Emit = (event) => this.deps.emit({ companyId, ...event } as AssistantEvent);
    const company = this.deps.store.company(companyId);
    if (!company.aiEnabled)
      return this.fail(notify, "AI_DISABLED", "Turn the assistant on for this company first");
    if (this.running.has(companyId)) return this.fail(notify, "BUSY", "The assistant is still answering");

    const chat = this.chat(companyId, chatId ?? this.open.get(companyId)?.id ?? randomUUID());
    // Everything shown in the window is also kept in the chat, so it reopens as it was.
    const emit: Emit = (event) => {
      chat.entries = applyEvent(chat.entries, event);
      notify(event);
    };
    let attached;
    try {
      attached = await readAttachments(files, this.deps.shrinkImage);
    } catch (e) {
      if (e instanceof AttachmentError) return this.fail(notify, e.code, e.message);
      throw e;
    }
    const question = text.trim() || attached.info.map((file) => file.name).join(", ");
    const content: AiMessage["content"] =
      attached.blocks.length > 0 ? [...attached.blocks, { type: "text", text: question }] : question;
    if (JSON.stringify(chat.messages).length + JSON.stringify(content).length > MAX_CHAT_CHARS) {
      return this.fail(notify, "CHAT_TOO_LARGE", "This chat is too large; start a new chat");
    }

    const abort = new AbortController();
    this.running.set(companyId, abort);
    const history = chat.messages;
    history.push({ role: "user", content });
    chat.entries = [
      ...chat.entries,
      { kind: "user", text: text.trim(), ...(attached.info.length > 0 ? { files: attached.info } : {}) },
    ];
    if (attached.tables.length > 0) chat.tables = [...(chat.tables ?? []), ...attached.tables];
    if (!chat.title) chat.title = question.replace(/\s+/g, " ").slice(0, 80);
    this.save(chat);
    const started = Date.now();
    this.cardWaitMs.set(companyId, 0);
    try {
      const maxTurns = this.deps.maxTurns ?? MAX_TURNS;
      for (let turn = 0; turn < maxTurns; turn++) {
        const answer = await this.turnWithRetries(
          { company: company.name, tools: Object.keys(AI_TOOLS), messages: history },
          emit,
          abort.signal,
        );
        if (answer.content.length > 0) history.push({ role: "assistant", content: answer.content });

        const toolUses = answer.content.flatMap((block) => {
          const use = AiToolUse.safeParse(block);
          return use.success ? [use.data] : [];
        });
        if (answer.stopReason === "max_tokens") {
          // Never an error for the user: the model goes on where it stopped. A tool call that was
          // cut off may be incomplete, so it is not run; it still needs a result.
          const notRun = { ok: false, code: "NOT_RUN", message: "Cut off at the output limit" } as const;
          history.push({
            role: "user",
            content:
              toolUses.length > 0
                ? [
                    ...toolUses.map((use) => toToolResult(use.id, notRun)),
                    { type: "text", text: CUT_TOOL_NOTE },
                  ]
                : [{ type: "text", text: CONTINUE_NOTE }],
          });
          this.save(chat);
          continue;
        }
        if (answer.stopReason !== "tool_use" || toolUses.length === 0) {
          // A refusal may hold a tool call that must not run; it still needs a result, or the next
          // question is rejected.
          if (toolUses.length > 0) {
            const notRun = { ok: false, code: "NOT_RUN", message: "The turn was cut off" } as const;
            history.push({ role: "user", content: toolUses.map((use) => toToolResult(use.id, notRun)) });
          }
          if (answer.stopReason === "refusal") {
            return this.fail(emit, "AI_REFUSED", "The assistant declined to answer this question");
          }
          emit({ type: "done" });
          return { ok: true, data: null };
        }
        // Every tool_use gets a tool_result, even when stopped, so the conversation stays valid.
        const results: AiContentBlock[] = [];
        for (const use of toolUses) {
          const result = abort.signal.aborted
            ? ({ ok: false, code: "STOPPED", message: "Stopped by the user" } as const)
            : await this.runTool(chat, use, emit, abort.signal);
          results.push(toToolResult(use.id, result));
        }
        if (turn === maxTurns - 2) results.push({ type: "text", text: LAST_STEP_NOTE });
        history.push({ role: "user", content: results });
        this.save(chat);
        if (abort.signal.aborted) return this.fail(emit, "AI_ABORTED", "Stopped");
      }
      return this.fail(
        emit,
        "AI_TOO_MANY_STEPS",
        "The question needed too many steps; try to narrow it down",
      );
    } catch (e) {
      if (e instanceof ControlError) return this.fail(emit, e.code, e.message);
      return this.fail(emit, "INTERNAL", e instanceof Error ? e.message : String(e));
    } finally {
      const waited = this.cardWaitMs.get(companyId) ?? 0;
      this.cardWaitMs.delete(companyId);
      emit({ type: "elapsed", ms: Math.max(0, Date.now() - started - waited) });
      this.running.delete(companyId);
      this.save(chat);
    }
  }

  /**
   * One model turn. A dropped connection, a server restart (a 5xx from the web server in front of
   * it) or a busy AI service is retried a few times, after a short wait, before it reaches the
   * user: the conversation is unchanged until a turn completes, so a retry repeats nothing that
   * was done in 1C. What a failed attempt had already shown is taken back first.
   */
  private async turnWithRetries(input: AiChatInput, emit: Emit, signal: AbortSignal) {
    for (let attempt = 1; ; attempt++) {
      let shown = false;
      try {
        const { client, accessToken } = await this.deps.session.authorized();
        return await client.aiTurn(
          accessToken,
          input,
          {
            onText: (delta) => {
              shown = true;
              emit({ type: "text", text: delta });
            },
            onProgress: (delta) => {
              shown = true;
              emit({ type: "progress", text: delta });
            },
          },
          signal,
        );
      } catch (e) {
        const retryable = e instanceof ControlError && RETRYABLE.has(e.code);
        const delays = this.deps.retryDelaysMs ?? RETRY_DELAYS_MS;
        if (!retryable || signal.aborted || attempt > delays.length) throw e;
        if (shown) emit({ type: "retry", attempt });
        await sleep(delays[attempt - 1] ?? 0, signal);
        if (signal.aborted) throw new ControlError("AI_ABORTED", "Stopped");
      }
    }
  }

  stop(companyId: string): void {
    this.running.get(companyId)?.abort();
  }

  /** The user's answer to the card on screen; an answer to an older card is ignored. */
  decide(companyId: string, proposalId: string, approve: boolean): void {
    const waiting = this.waiting.get(companyId);
    if (waiting?.id === proposalId) waiting.answer(approve);
  }

  /** Stops the assistant and closes the open chat; the next question starts a new one. */
  reset(companyId: string): void {
    this.stop(companyId);
    this.open.delete(companyId);
  }

  chats(companyId: string): ChatSummary[] {
    return this.deps.chats.list(companyId);
  }

  openChat(companyId: string, chatId: string): Result<ChatView> {
    if (this.running.has(companyId) && this.open.get(companyId)?.id !== chatId) {
      return { ok: false, code: "BUSY", message: "The assistant is still answering" };
    }
    if (!this.deps.chats.load(companyId, chatId) && this.open.get(companyId)?.id !== chatId) {
      return { ok: false, code: "NOT_FOUND", message: "This chat was deleted" };
    }
    const { id, title, createdAt, updatedAt, entries } = this.chat(companyId, chatId);
    return { ok: true, data: { id, title, createdAt, updatedAt, entries } };
  }

  deleteChat(companyId: string, chatId: string): Result<null> {
    if (this.open.get(companyId)?.id === chatId) {
      if (this.running.has(companyId)) {
        return { ok: false, code: "BUSY", message: "The assistant is still answering" };
      }
      this.open.delete(companyId);
    }
    this.deps.chats.delete(companyId, chatId);
    return { ok: true, data: null };
  }

  /** The company is removed from the app: its chats go too. */
  removeCompany(companyId: string): void {
    this.reset(companyId);
    this.deps.chats.deleteCompany(companyId);
  }

  /** The chat with this id, made the open one: in memory, saved, or a new one. */
  private chat(companyId: string, chatId: string): StoredChat {
    const current = this.open.get(companyId);
    if (current?.id === chatId) return current;
    const saved = this.deps.chats.load(companyId, chatId);
    const now = new Date().toISOString();
    const chat = saved
      ? repair(saved)
      : { id: chatId, companyId, title: "", createdAt: now, updatedAt: now, messages: [], entries: [] };
    this.open.set(companyId, chat);
    return chat;
  }

  private save(chat: StoredChat): void {
    chat.updatedAt = new Date().toISOString();
    try {
      this.deps.chats.save(chat);
    } catch (e) {
      // The answer still reaches the window; only reopening this chat later is lost.
      console.error("The chat was not saved:", e);
    }
  }

  private async runTool(
    chat: StoredChat,
    use: AiToolUse,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    if (!isAiToolName(use.name)) return { ok: false, code: "UNKNOWN_TOOL", message: `No tool ${use.name}` };
    const input = AI_TOOLS[use.name].safeParse(use.input);
    if (!input.success) {
      return {
        ok: false,
        code: "VALIDATION",
        message: input.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    }
    if (isProposalTool(use.name)) return this.propose(chat, use.name, input.data, emit, signal);
    emit({ type: "tool", name: use.name, detail: describe(use.name, input.data) });
    if (use.name === "read_attachment") {
      return readTable(chat.tables ?? [], input.data as ReadAttachmentInput);
    }
    return this.deps.connector.tool(this.deps.store.connection(chat.companyId), use.name, input.data);
  }

  /**
   * Shows the prepared document and waits for the user. Approved: written to 1C, unposted. The
   * result tells the model what the user decided, so it never claims a document it did not create.
   */
  private async propose(
    chat: StoredChat,
    tool: AiProposalTool,
    input: unknown,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const companyId = chat.companyId;
    const session = await this.deps.session.view();
    if (session?.license?.mode !== "active") {
      return {
        ok: false,
        code: "READ_ONLY",
        message: "The license is read-only: no documents can be created",
      };
    }
    const connection = this.deps.store.connection(companyId);
    let proposal: Proposal;
    let create: () => Promise<ToolResult>;
    if (tool === "propose_changes") {
      const batch = input as ChangeBatchInput;
      emit({ type: "tool", name: tool, detail: describe(tool, batch) });
      // 1C checks every change first; the ones it refuses are shown and left out.
      const items: BatchItem[] = [];
      for (const change of batch.changes) {
        if (signal.aborted) return { ok: false, code: "STOPPED", message: "Stopped by the user" };
        const preview = await this.deps.connector.tool(connection, "previewChange", change);
        items.push({
          action: change.action,
          object: change.object,
          preview: preview.ok ? (preview.data as ChangePreview) : null,
          error: preview.ok ? null : { code: preview.code, message: preview.message },
        });
      }
      if (items.every((item) => item.preview === null)) {
        return {
          ok: false,
          code: "ALL_REFUSED",
          message: `1C refused every change: ${items
            .map((item, i) => `#${i + 1} ${item.error?.code}: ${item.error?.message}`)
            .join("; ")}`,
        };
      }
      const unfixed = this.fillCheck(
        chat.id,
        batch.changes.map((change, i) => ({
          n: i + 1,
          change,
          warnings: items[i]?.preview?.warnings ?? [],
        })),
      );
      if (unfixed) return unfixed;
      proposal = { kind: "batch", title: batch.title, items };
      create = async () => {
        const results: BatchItemResult[] = [];
        for (const [i, change] of batch.changes.entries()) {
          const shown = items[i]?.preview;
          if (!shown) {
            results.push(null);
          } else if (signal.aborted) {
            results.push({ ok: false, code: "STOPPED", message: "Stopped by the user" });
          } else {
            const applied = await this.deps.connector.tool(connection, "applyChange", {
              ...change,
              version: shown.version,
            });
            results.push(
              applied.ok
                ? { ok: true, state: applied.data as ObjectState }
                : { ok: false, code: applied.code, message: applied.message },
            );
          }
        }
        return { ok: true, data: results };
      };
    } else if (tool === "propose_change") {
      const change = input as ChangeInput;
      emit({ type: "tool", name: tool, detail: describe(tool, change) });
      const preview = await this.deps.connector.tool(connection, "previewChange", change);
      if (!preview.ok) return preview;
      const shown = preview.data as ChangePreview;
      const unfixed = this.fillCheck(chat.id, [{ n: 1, change, warnings: shown.warnings }]);
      if (unfixed) return unfixed;
      proposal = { kind: "change", preview: shown };
      // The version seen on the card: if someone changes the object meanwhile, 1C refuses.
      create = () =>
        this.deps.connector.tool(connection, "applyChange", { ...change, version: shown.version });
    } else if (tool === "propose_invoice_issued") {
      emit({ type: "tool", name: tool, detail: describe(tool, input) });
      const preview = await this.deps.connector.tool(connection, "previewInvoiceIssued", input);
      if (!preview.ok) return preview;
      const { sale, existing } = preview.data as InvoiceIssuedPreview;
      // Already invoiced (by the app or by hand): nothing to confirm.
      if (existing) return { ok: true, data: { status: "already_exists", invoice: existing, sale } };
      proposal = { kind: "invoice_issued", sale };
      create = () => this.deps.connector.tool(connection, "createInvoiceIssued", { sale: { ref: sale.ref } });
    } else {
      const invoice = input as InvoiceReceivedDraft;
      // One id per confirmed card: a second confirmation of the same card cannot happen, and a new
      // card for the same paper invoice is the user's explicit choice.
      const externalId = `chat-${randomUUID()}`;
      proposal = { kind: "invoice_received", invoice };
      create = () =>
        this.deps.connector.tool(connection, "createInvoiceReceived", {
          ...invoice,
          source: "manual",
          externalId,
        });
    }

    const id = randomUUID();
    emit({ type: "confirm", id, proposal });
    const shownAt = Date.now();
    const approved = await new Promise<boolean>((resolve) => {
      const answer = (approve: boolean) => {
        this.waiting.delete(companyId);
        signal.removeEventListener("abort", onAbort);
        resolve(approve);
      };
      const onAbort = () => answer(false);
      this.waiting.set(companyId, { id, answer });
      if (signal.aborted) answer(false);
      else signal.addEventListener("abort", onAbort);
    });
    this.cardWaitMs.set(companyId, (this.cardWaitMs.get(companyId) ?? 0) + Date.now() - shownAt);
    const decided = (outcome: ProposalOutcome) => emit({ type: "decided", id, outcome });
    if (!approved) {
      decided({ status: "declined" });
      return { ok: true, data: { status: "declined_by_user" } };
    }
    const result = await create();
    if (!result.ok) {
      decided({ status: "failed", code: result.code, message: result.message });
      return result;
    }
    if (proposal.kind === "batch") {
      const results = result.data as BatchItemResult[];
      decided({ status: "batch", results });
      return {
        ok: true,
        data: {
          status: "done",
          applied: results.flatMap((r, i) => (r?.ok ? [{ n: i + 1, object: r.state }] : [])),
          failed: results.flatMap((r, i) =>
            r && !r.ok ? [{ n: i + 1, error: r.code, message: r.message }] : [],
          ),
          refusedBefore: proposal.items.flatMap((item, i) =>
            item.error ? [{ n: i + 1, error: item.error.code, message: item.error.message }] : [],
          ),
        },
      };
    }
    if (proposal.kind === "change") {
      const state = result.data as ObjectState;
      decided({ status: "applied", state });
      return { ok: true, data: { status: "done", action: proposal.preview.action, object: state } };
    }
    const document = result.data as CreateInvoiceResult;
    decided({ status: "created", document });
    return { ok: true, data: { status: document.duplicate ? "already_exists" : "created", document } };
  }

  /**
   * 1C's filling check (ПроверитьЗаполнение) found empty required fields: the model fixes them
   * before the accountant sees a card, as a colleague would. A change sent back once and sent again
   * unchanged could not be fixed, and goes on the card with its warnings.
   */
  private fillCheck(
    chatId: string,
    changes: { n: number; change: ChangeInput; warnings: string[] }[],
  ): ToolResult | null {
    const seen = this.checked.get(chatId) ?? new Set<string>();
    this.checked.set(chatId, seen);
    const fresh = changes.filter(({ change, warnings }) => {
      if (warnings.length === 0) return false;
      const key = JSON.stringify(change);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (fresh.length === 0) return null;
    return {
      ok: false,
      code: "FILL_CHECK",
      message:
        "Nothing was shown to the accountant yet: 1C's filling check found empty fields. " +
        fresh.map(({ n, warnings }) => `#${n}: ${warnings.join("; ")}`).join(" | ") +
        ". Fill them (get_object on a posted document of the same kind shows how this company fills " +
        "them, tabular sections included) and send the whole proposal again. A change you cannot fix " +
        "from 1C or the files: send it again unchanged, and it is shown with its warning.",
    };
  }

  private fail(emit: Emit, code: string, message: string): Result<null> {
    emit({ type: "error", code, message });
    return { ok: false, code, message };
  }
}

/**
 * A chat saved while the app was closed mid-answer: a card nobody answered was never written to
 * 1C, and a tool call without a result would make the API refuse the next question.
 */
function repair(chat: StoredChat): StoredChat {
  const entries = chat.entries.map((e) =>
    e.kind === "proposal" && e.outcome === null ? { ...e, outcome: { status: "declined" as const } } : e,
  );
  const messages = [...chat.messages];
  const last = messages.at(-1);
  if (last?.role === "assistant" && Array.isArray(last.content)) {
    const unanswered = last.content.flatMap((block) => {
      const use = AiToolUse.safeParse(block);
      return use.success ? [use.data] : [];
    });
    if (unanswered.length > 0) {
      const notRun = { ok: false, code: "NOT_RUN", message: "The app was closed" } as const;
      messages.push({ role: "user", content: unanswered.map((use) => toToolResult(use.id, notRun)) });
    }
  }
  return { ...chat, entries, messages };
}

function toToolResult(toolUseId: string, result: ToolResult): AiContentBlock {
  const body = JSON.stringify(result.ok ? result.data : { error: result.code, message: result.message });
  const content =
    body.length > MAX_RESULT_CHARS
      ? `${body.slice(0, MAX_RESULT_CHARS)}… [cut: the result was ${body.length} characters; ask for fewer rows or columns]`
      : body;
  return { type: "tool_result", tool_use_id: toolUseId, content, ...(result.ok ? {} : { is_error: true }) };
}

/** A short line for the UI about what is being read from 1C. */
function describe(name: string, input: unknown): string {
  if (name === "run_query")
    return String((input as { query: string }).query)
      .replace(/\s+/g, " ")
      .slice(0, 160);
  if (name === "describe_objects") return (input as { objects: string[] }).objects.join(", ");
  if (name === "get_object") return (input as { object: string }).object;
  if (name === "read_attachment") {
    const read = input as ReadAttachmentInput;
    const parts = [read.file];
    if (read.group_by) parts.push(`by ${read.group_by.column} (${read.group_by.by})`);
    if (read.sum) parts.push(`sum ${read.sum.join(", ")}`);
    if (read.from || read.to) parts.push(`rows ${read.from ?? 1}–${read.to ?? "end"}`);
    return parts.join(" · ");
  }
  if (name === "propose_changes") {
    const batch = input as { title: string; changes: unknown[] };
    return `${batch.changes.length} · ${batch.title}`;
  }
  if (name === "propose_change") {
    const change = input as { action: string; object: string };
    return `${change.action} ${change.object}`;
  }
  if (name === "propose_invoice_issued") {
    const { sale } = input as { sale: { number?: string; date?: string } };
    return [sale.number, sale.date].filter(Boolean).join(" · ");
  }
  return "";
}
