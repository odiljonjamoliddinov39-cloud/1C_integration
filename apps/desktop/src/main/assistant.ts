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
  AI_PROPOSAL_TOOLS,
  AI_TOOLS,
  AUDIT_TOOLS,
  CHAT_TOOLS,
  CONTINUE_NOTE,
  type AiChatInput,
  type AiContentBlock,
  type AiMessage,
  type AiPolicy,
  type AiProposalTool,
  type AiReadTool,
  AiToolUse,
  type ChangeBatchInput,
  type CheckChangesInput,
  type InvoicesIssuedInput,
  type InvoicesReceivedInput,
  expandBatch,
  type ChangeInput,
  type ChangePreview,
  type CreateInvoiceResult,
  type InvoiceIssuedPreview,
  type InvoiceReceivedDraft,
  type ObjectState,
  type ReadAttachmentInput,
  ReportFindingsInput,
  type RunQueryInput,
  isAiToolName,
  isProposalTool,
} from "@platform/shared";

import { CostEngine } from "./ai/engine.js";
import { classifyTask } from "./ai/classify.js";
import { TraceBuilder } from "./ai/trace.js";
import { clampQuery, shapeQueryResult } from "./ai/trim.js";
import type {
  AssistantEvent,
  AssistantInput,
  AuditCheckView,
  AuditInput,
  AuditView,
  BatchItem,
  BatchItemResult,
  ChatSummary,
  ChatView,
  Proposal,
  ProposalOutcome,
  Result,
  UiLanguage,
} from "../shared/ipc.js";
import { applyEvent } from "../shared/transcript.js";
import { AUDIT_CHECKS, AUDIT_SECTIONS, type AuditCheck } from "./audit-checks.js";
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
const MAX_RESULT_CHARS = 60_000;
/** Sent with the results when a turn reached the output limit inside a tool call, which was not run. */
const CUT_TOOL_NOTE =
  "Your last tool call reached the output limit and was cut off, so it was not run. Send it again in " +
  "smaller parts (for example propose_changes with at most 50 changes per card, one card after another).";
/**
 * A chat is sent whole every turn and the AI service takes at most 32 MB per request; past this
 * size (mostly attached files) the user starts a new chat.
 */
const MAX_CHAT_CHARS = 24_000_000;
/** Steps of one audit check: it reads with totals, so a few queries are usually enough. */
const CHECK_MAX_TURNS = 30;
/** Audit checks that run at the same time. */
const AUDIT_CONCURRENCY = 3;
/** Sent to a check that answered without reporting, or is near its last step. */
const REPORT_NOW =
  "Finish this check now: call report_findings with what you have found (say in the summary what you " +
  "could not check).";
const LANGUAGE_NAMES: Record<UiLanguage, string> = {
  en: "English",
  ru: "Russian",
  uz: "Uzbek (Latin script)",
};
const AUDIT_TITLE: Record<UiLanguage, string> = { en: "Audit", ru: "Аудит", uz: "Audit" };

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
  /** The audit's checklist and how many checks run at once (tests use their own). */
  auditChecks?: AuditCheck[];
  auditConcurrency?: number;
  /** The cost engine (limits, templates, answer cache, digest); one is made when absent. */
  engine?: CostEngine;
}

/** What one question runs under: the limits in force, and what kind of question it is. */
interface Run {
  policy: AiPolicy;
  task: "lookup" | "work";
  /** Set once the user declined an answer: the rest of the question runs on the default model. */
  escalate: boolean;
  /** What was done for this question: the engine learns from it when it ends. */
  trace: TraceBuilder;
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

  private readonly engine: CostEngine;

  constructor(private readonly deps: AssistantDeps) {
    this.engine = deps.engine ?? new CostEngine(deps.session, deps.connector);
  }

  async send({
    companyId,
    chatId,
    text,
    files = [],
    skipFree,
    rejectTemplate,
  }: AssistantInput): Promise<Result<null>> {
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
    chat.messages.push({ role: "user", content });
    chat.entries = [
      ...chat.entries,
      { kind: "user", text: text.trim(), ...(attached.info.length > 0 ? { files: attached.info } : {}) },
    ];
    if (attached.tables.length > 0) chat.tables = [...(chat.tables ?? []), ...attached.tables];
    if (!chat.title) chat.title = question.replace(/\s+/g, " ").slice(0, 80);
    this.save(chat);
    if (rejectTemplate) void this.engine.reject(rejectTemplate);
    // A read-only question that opens a chat may be answered without the model, and its answer kept.
    const standalone = chat.messages.length === 1 && attached.blocks.length === 0;
    return this.task(companyId, chat, emit, async () => {
      const connection = this.deps.store.connection(companyId);
      try {
        if (standalone && !skipFree) {
          const free = await this.engine.tryFree(companyId, company.name, connection, question, true);
          if (free?.route === "template" && free.action) {
            // The template does the action too: a card from what its query returns, which the user confirms.
            const done = await this.runAction(chat, question, free, emit, abort.signal);
            if (done) return done;
          } else if (free) {
            return this.answerFree(chat, question, free, emit);
          }
        }
        const run: Run = {
          policy: await this.engine.policy(),
          task: classifyTask(question, attached.blocks.length > 0),
          escalate: false,
          trace: new TraceBuilder(),
        };
        const result = await this.converse(chat, company.name, emit, abort.signal, run);
        if (result.ok && standalone) this.rememberAnswer(chat, company.name, question);
        // Every finished question teaches the engine: what was done, how it ended, no data.
        void this.engine.sendTrace(
          run.trace.build(
            company.name,
            question,
            result.ok ? { ok: true } : { ok: false, code: result.code },
          ),
        );
        return result;
      } finally {
        // Built after the answer, so the first question is not held up by it.
        this.engine.ensureDigest(companyId, company.name, connection);
      }
    });
  }

  /** An answer from a template or the cache: shown, kept in the chat, no model involved. */
  private answerFree(
    chat: StoredChat,
    question: string,
    free: NonNullable<Awaited<ReturnType<CostEngine["tryFree"]>>>,
    emit: Emit,
  ): Result<null> {
    emit({
      type: "route",
      route: free.route,
      question,
      ...(free.route === "template"
        ? { title: free.title, ...(free.learned ? { learnedCode: free.code } : {}) }
        : { ageSeconds: free.ageSeconds }),
    });
    emit({ type: "text", text: free.text });
    chat.messages.push({ role: "assistant", content: [{ type: "text", text: free.text }] });
    emit({ type: "done" });
    return { ok: true, data: null };
  }

  /**
   * A learned action template: its query's rows become a card (issued invoices for those sales) that
   * the user confirms, like any card. Null when nothing was shown and the model should take over.
   */
  private async runAction(
    chat: StoredChat,
    question: string,
    free: Extract<NonNullable<Awaited<ReturnType<CostEngine["tryFree"]>>>, { route: "template" }>,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<Result<null> | null> {
    const action = free.action;
    if (!action) return null;
    // Nothing to prepare: the (empty) result is the answer.
    if (action.sales.length === 0) return this.answerFree(chat, question, free, emit);
    let shown = false;
    const watch: Emit = (event) => {
      if (event.type === "confirm" && !shown) {
        shown = true;
        emit({
          type: "route",
          route: "template",
          question,
          title: free.title,
          ...(free.learned ? { learnedCode: free.code } : {}),
        });
      }
      emit(event);
    };
    const result = await this.propose(
      chat,
      action.tool,
      { title: free.title, sales: action.sales.map((ref) => ({ ref })) },
      watch,
      signal,
    );
    // A card that could not be prepared (read-only license, 1C refused it) was never shown: the model decides.
    if (!shown) return null;
    let text = `**${free.title}**\n\n—`;
    if (result.ok) {
      const data = result.data as { status?: string; applied?: unknown[]; failed?: unknown[] };
      if (data.status === "done") {
        const failed = data.failed?.length ?? 0;
        text = `**${free.title}**\n\n✓ ${data.applied?.length ?? 0}${failed > 0 ? ` · ✗ ${failed}` : ""}`;
      }
    } else {
      text = `**${free.title}**\n\n✗ ${result.message}`;
    }
    emit({ type: "text", text });
    chat.messages.push({ role: "assistant", content: [{ type: "text", text }] });
    emit({ type: "done" });
    return { ok: true, data: null };
  }

  /** Keeps the finished answer to a read-only question: no card, no change to 1C, ended normally. */
  private rememberAnswer(chat: StoredChat, companyName: string, question: string): void {
    const rest = chat.messages.slice(1);
    const wrote = rest.some(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some(
          (b) =>
            (b as { type?: string }).type === "tool_use" &&
            (AI_PROPOSAL_TOOLS as readonly string[]).includes((b as { name?: string }).name ?? ""),
        ),
    );
    const last = chat.messages.at(-1);
    if (wrote || last?.role !== "assistant" || !Array.isArray(last.content)) return;
    const text = last.content
      .flatMap((b) => {
        const { type, text: t } = b as { type?: string; text?: unknown };
        return type === "text" && typeof t === "string" ? [t] : [];
      })
      .join("\n")
      .trim();
    if (text) void this.engine.remember(chat.companyId, companyName, question, text);
  }

  /** A task of the company's chat: busy until it ends, then its working time, and the chat is saved. */
  private async task(
    companyId: string,
    chat: StoredChat,
    emit: Emit,
    work: () => Promise<Result<null>>,
  ): Promise<Result<null>> {
    const started = Date.now();
    this.cardWaitMs.set(companyId, 0);
    try {
      return await work();
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

  /** The model works on the chat until it answers: its 1C lookups run here, its changes go on cards. */
  private async converse(
    chat: StoredChat,
    companyName: string,
    emit: Emit,
    signal: AbortSignal,
    run: Run,
  ): Promise<Result<null>> {
    const history = chat.messages;
    const maxTurns = this.deps.maxTurns ?? MAX_TURNS;
    for (let turn = 0; turn < maxTurns; turn++) {
      const answer = await this.turnWithRetries(
        {
          company: companyName,
          tools: CHAT_TOOLS,
          task: run.task,
          ...(run.escalate ? { escalate: true } : {}),
          messages: history,
        },
        emit,
        signal,
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
        const result = signal.aborted
          ? ({ ok: false, code: "STOPPED", message: "Stopped by the user" } as const)
          : await this.runTool(chat, use, emit, signal, run);
        // A card the user declined: the rest of the question runs on the default model.
        if (isDeclined(result)) run.escalate = true;
        if (!signal.aborted) {
          if ((AI_PROPOSAL_TOOLS as readonly string[]).includes(use.name)) {
            run.trace.propose(use.name, use.input, result);
          } else {
            run.trace.read(use.name, use.input, result);
          }
        }
        results.push(toToolResult(use.id, result, shaped(use.name, result, run.policy)));
      }
      if (turn === maxTurns - 2) results.push({ type: "text", text: LAST_STEP_NOTE });
      history.push({ role: "user", content: results });
      this.save(chat);
      if (signal.aborted) return this.fail(emit, "AI_ABORTED", "Stopped");
    }
    return this.fail(emit, "AI_TOO_MANY_STEPS", "The question needed too many steps; try to narrow it down");
  }

  /**
   * An audit of the company's base over a period: the same checklist every time, each check its own
   * short conversation with the model (it only reads 1C and ends with report_findings), a few at a
   * time, so a whole base is covered without one huge chat. The results then go into the chat, where
   * the model writes the report, and the accountant can ask about it or have problems fixed.
   */
  async audit({ companyId, chatId, from, to, language }: AuditInput): Promise<Result<null>> {
    const notify: Emit = (event) => this.deps.emit({ companyId, ...event } as AssistantEvent);
    const company = this.deps.store.company(companyId);
    if (!company.aiEnabled)
      return this.fail(notify, "AI_DISABLED", "Turn the assistant on for this company first");
    if (this.running.has(companyId)) return this.fail(notify, "BUSY", "The assistant is still answering");

    const abort = new AbortController();
    this.running.set(companyId, abort);
    const chat = this.chat(companyId, chatId);
    const emit: Emit = (event) => {
      chat.entries = applyEvent(chat.entries, event);
      notify(event);
    };
    const checks = this.deps.auditChecks ?? AUDIT_CHECKS;
    const view: AuditView = {
      from,
      to,
      language,
      finished: false,
      checks: checks.map((check) => ({
        id: check.id,
        section: AUDIT_SECTIONS[check.section][language],
        title: check.title[language],
        status: "pending",
      })),
    };
    const show = () => emit({ type: "audit", audit: structuredClone(view) });
    if (!chat.title) chat.title = `${AUDIT_TITLE[language]} ${dayMonthYear(from)}–${dayMonthYear(to)}`;
    show();
    this.save(chat);

    return this.task(companyId, chat, emit, async () => {
      const connection = this.deps.store.connection(companyId);
      const policy = await this.engine.policy();
      const queue = checks.map((check, i) => ({ check, state: view.checks[i] as AuditCheckView }));
      const worker = async () => {
        for (let next = queue.shift(); next && !abort.signal.aborted; next = queue.shift()) {
          const { check, state } = next;
          state.status = "running";
          show();
          const started = Date.now();
          const result = await this.runCheck(
            company.name,
            connection,
            policy,
            check,
            view,
            (activity) => {
              state.activity = activity;
              show();
            },
            abort.signal,
          );
          Object.assign(state, result, { ms: Date.now() - started });
          delete state.activity;
          show();
          this.save(chat);
        }
      };
      const workers = Math.min(this.deps.auditConcurrency ?? AUDIT_CONCURRENCY, queue.length);
      await Promise.all(Array.from({ length: workers }, worker));
      for (const state of view.checks) {
        if (state.status === "pending" || state.status === "running") {
          Object.assign(state, { status: "failed", summary: "Stopped" });
          delete state.activity;
        }
      }
      view.finished = true;
      show();
      if (abort.signal.aborted) return this.fail(emit, "AI_ABORTED", "Stopped");

      chat.messages.push({ role: "user", content: auditReportRequest(view) });
      this.save(chat);
      return this.converse(chat, company.name, emit, abort.signal, {
        policy,
        task: "work",
        escalate: false,
        trace: new TraceBuilder(),
      });
    });
  }

  /** One audit check: the model reads 1C until it reports what it found. */
  private async runCheck(
    companyName: string,
    connection: ReturnType<LocalStore["connection"]>,
    policy: AiPolicy,
    check: AuditCheck,
    view: AuditView,
    onActivity: (activity: string) => void,
    signal: AbortSignal,
  ): Promise<Pick<AuditCheckView, "status" | "summary" | "findings">> {
    const messages: AiMessage[] = [{ role: "user", content: auditCheckPrompt(check, view) }];
    // What the model writes inside a check is not shown: only its result is.
    const quiet: Emit = () => undefined;
    let nudged = false;
    for (let turn = 0; turn < CHECK_MAX_TURNS; turn++) {
      let answer;
      try {
        answer = await this.turnWithRetries(
          { company: companyName, tools: AUDIT_TOOLS, messages },
          quiet,
          signal,
        );
      } catch (e) {
        return { status: "failed", summary: e instanceof Error ? e.message : String(e) };
      }
      if (answer.content.length > 0) messages.push({ role: "assistant", content: answer.content });
      const uses = answer.content.flatMap((block) => {
        const use = AiToolUse.safeParse(block);
        return use.success ? [use.data] : [];
      });
      const report = uses.find((use) => use.name === "report_findings");
      const reported = report && ReportFindingsInput.safeParse(report.input);
      if (reported?.success && answer.stopReason !== "max_tokens") {
        const { status, summary, findings } = reported.data;
        return { status, summary, findings };
      }

      const results: AiContentBlock[] = [];
      for (const use of uses) {
        const result = await this.runCheckTool(
          connection,
          policy,
          use,
          answer.stopReason,
          onActivity,
          signal,
        );
        results.push(toToolResult(use.id, result, shaped(use.name, result, policy)));
      }
      if (answer.stopReason === "max_tokens") {
        results.push({
          type: "text",
          text: "Your output was cut off. Report again with at most the 50 most important findings and shorter details.",
        });
      } else if (uses.length === 0) {
        // Answered in words instead of reporting: asked once, then the words are the result.
        const text = answer.content
          .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
          .join("\n")
          .trim();
        if (nudged) return { status: "failed", summary: text.slice(0, 1000) || "No result" };
        nudged = true;
        results.push({ type: "text", text: REPORT_NOW });
      } else if (turn === CHECK_MAX_TURNS - 3) {
        results.push({ type: "text", text: REPORT_NOW });
      }
      messages.push({ role: "user", content: results });
      if (signal.aborted) return { status: "failed", summary: "Stopped" };
    }
    return { status: "failed", summary: "The check did not finish in its steps" };
  }

  /** A tool call inside an audit check: reads only. */
  private async runCheckTool(
    connection: ReturnType<LocalStore["connection"]>,
    policy: AiPolicy,
    use: AiToolUse,
    stopReason: string | null,
    onActivity: (activity: string) => void,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    if (signal.aborted) return { ok: false, code: "STOPPED", message: "Stopped by the user" };
    if (stopReason === "max_tokens")
      return { ok: false, code: "NOT_RUN", message: "Cut off at the output limit" };
    if (!isAiToolName(use.name) || !AUDIT_TOOLS.includes(use.name) || use.name === "report_findings") {
      return { ok: false, code: "UNKNOWN_TOOL", message: `No tool ${use.name} in an audit check` };
    }
    const input = AI_TOOLS[use.name].safeParse(use.input);
    if (!input.success) {
      return {
        ok: false,
        code: "VALIDATION",
        message: input.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    }
    onActivity(`${use.name}: ${describe(use.name, input.data)}`);
    // An audit check's tools other than report_findings all read 1C.
    const data = use.name === "run_query" ? clampQuery(input.data as RunQueryInput, policy) : input.data;
    return this.deps.connector.tool(connection, use.name as AiReadTool, data);
  }

  /** An audit's findings as CSV (semicolons, UTF-8 with BOM), the way Excel opens it. */
  auditCsv(companyId: string, chatId: string): Result<{ name: string; csv: string }> {
    const chat =
      this.open.get(companyId)?.id === chatId
        ? this.open.get(companyId)
        : this.deps.chats.load(companyId, chatId);
    const entry = chat?.entries.findLast((e) => e.kind === "audit");
    if (!chat || entry?.kind !== "audit")
      return { ok: false, code: "NOT_FOUND", message: "This chat has no audit" };
    return {
      ok: true,
      data: {
        name: `${chat.title.replace(/[\\/:*?"<>|]+/g, "_")}.csv`,
        csv: auditToCsv(entry.audit),
      },
    };
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
            onWarning: (code, message) => emit({ type: "notice", code, message }),
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
    run: Run,
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
    if (use.name === "report_findings") {
      return { ok: false, code: "UNKNOWN_TOOL", message: "report_findings is only for audit checks" };
    }
    emit({ type: "tool", name: use.name, detail: describe(use.name, input.data) });
    if (use.name === "read_attachment") {
      return readTable(chat.tables ?? [], input.data as ReadAttachmentInput);
    }
    if (use.name === "check_changes") {
      return this.checkChanges(
        this.deps.store.connection(chat.companyId),
        input.data as CheckChangesInput,
        signal,
      );
    }
    const data = use.name === "run_query" ? clampQuery(input.data as RunQueryInput, run.policy) : input.data;
    return this.deps.connector.tool(this.deps.store.connection(chat.companyId), use.name, data);
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
    if (
      tool === "propose_changes" ||
      tool === "propose_invoices_issued" ||
      tool === "propose_invoices_received"
    ) {
      emit({ type: "tool", name: tool, detail: describe(tool, input) });
      const prepared = await this.prepareBatch(chat.id, tool, input, connection, signal);
      if (!("entries" in prepared)) return prepared;
      const { title, entries } = prepared;
      proposal = { kind: "batch", title, items: entries.map((entry) => entry.item) };
      create = async () => {
        const results: BatchItemResult[] = [];
        for (const entry of entries) {
          if (!entry.apply) results.push(null);
          else if (signal.aborted)
            results.push({ ok: false, code: "STOPPED", message: "Stopped by the user" });
          else results.push(await entry.apply());
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
    // The books are about to change: answers kept before now are no longer valid.
    this.engine.noteWrite(companyId);
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
   * The items of a batch card, each checked by 1C first (the ones it refuses are shown and left
   * out), with how to write each once the accountant confirms: documents and directory items,
   * issued invoices for many sales, or many suppliers' invoices.
   */
  private async prepareBatch(
    chatId: string,
    tool: "propose_changes" | "propose_invoices_issued" | "propose_invoices_received",
    input: unknown,
    connection: ReturnType<LocalStore["connection"]>,
    signal: AbortSignal,
  ): Promise<{ title: string; entries: BatchEntry[] } | ToolResult> {
    const stopped = { ok: false, code: "STOPPED", message: "Stopped by the user" } as const;
    const entries: BatchEntry[] = [];

    if (tool === "propose_changes") {
      const batch = input as ChangeBatchInput;
      const expanded = expandBatch(batch);
      for (const [i, item] of expanded.entries()) {
        if (signal.aborted) return stopped;
        const raw = batch.changes[i];
        if (!item.ok) {
          entries.push({
            item: {
              action: raw?.action ?? batch.defaults?.action ?? "create",
              object: raw?.object ?? batch.defaults?.object ?? "?",
              preview: null,
              error: { code: "VALIDATION", message: item.message },
            },
            apply: null,
          });
          continue;
        }
        const change = item.change;
        const preview = await this.deps.connector.tool(connection, "previewChange", change);
        const shown = preview.ok ? (preview.data as ChangePreview) : null;
        entries.push({
          item: {
            action: change.action,
            object: change.object,
            preview: shown,
            error: preview.ok ? null : { code: preview.code, message: preview.message },
          },
          change,
          // The version seen on the card: if someone changes the object meanwhile, 1C refuses.
          apply: shown
            ? async () => {
                const applied = await this.deps.connector.tool(connection, "applyChange", {
                  ...change,
                  version: shown.version,
                });
                return applied.ok
                  ? { ok: true, state: applied.data as ObjectState }
                  : { ok: false, code: applied.code, message: applied.message };
              }
            : null,
        });
      }
      const unfixed = this.fillCheck(
        chatId,
        entries.flatMap((entry, i) =>
          entry.change
            ? [{ n: i + 1, change: entry.change, warnings: entry.item.preview?.warnings ?? [] }]
            : [],
        ),
      );
      if (unfixed) return unfixed;
    } else if (tool === "propose_invoices_issued") {
      for (const sale of (input as InvoicesIssuedInput).sales) {
        if (signal.aborted) return stopped;
        const preview = await this.deps.connector.tool(connection, "previewInvoiceIssued", { sale });
        const object = "Документ.СчетФактураВыданный";
        if (!preview.ok) {
          entries.push({
            item: {
              action: "create",
              object,
              preview: null,
              error: { code: preview.code, message: preview.message },
            },
            apply: null,
          });
          continue;
        }
        const { sale: found, existing } = preview.data as InvoiceIssuedPreview;
        const basis = `${found.number} · ${found.date.slice(0, 10)}`;
        entries.push({
          item: {
            action: "create",
            object,
            preview: existing
              ? null
              : draftPreview(object, basis, [
                  ["Основание", basis],
                  ["Контрагент", found.counterparty],
                  ["Сумма", found.amount],
                ]),
            // Already invoiced (by the app or by hand): left out, nothing to write.
            error: existing
              ? { code: "ALREADY_EXISTS", message: `${existing.number} · ${existing.date.slice(0, 10)}` }
              : null,
          },
          apply: existing
            ? null
            : async () =>
                createdState(
                  object,
                  await this.deps.connector.tool(connection, "createInvoiceIssued", {
                    sale: { ref: found.ref },
                  }),
                ),
        });
      }
    } else {
      for (const invoice of (input as InvoicesReceivedInput).invoices) {
        const object = "Документ.СчетФактураПолученный";
        const total = invoice.lines.reduce((sum, line) => sum + line.total, 0);
        // One id per invoice of a confirmed card, as for a single one.
        const externalId = `chat-${randomUUID()}`;
        entries.push({
          item: {
            action: "create",
            object,
            preview: draftPreview(object, `${invoice.number} · ${invoice.date}`, [
              ["Номер", invoice.number],
              ["Контрагент", invoice.counterparty.inn ?? invoice.counterparty.ref ?? null],
              ["Сумма", Math.round(total * 100) / 100],
            ]),
            error: null,
          },
          apply: async () =>
            createdState(
              object,
              await this.deps.connector.tool(connection, "createInvoiceReceived", {
                ...invoice,
                source: "manual",
                externalId,
              }),
            ),
        });
      }
    }

    if (entries.every((entry) => !entry.apply)) {
      const reasons = entries.map(
        (entry, i) => `#${i + 1} ${entry.item.error?.code}: ${entry.item.error?.message}`,
      );
      return entries.every((entry) => entry.item.error?.code === "ALREADY_EXISTS")
        ? { ok: true, data: { status: "already_exists", count: entries.length } }
        : { ok: false, code: "ALL_REFUSED", message: `1C refused every item: ${reasons.join("; ")}` };
    }
    const title = (input as { title: string }).title;
    return { title, entries };
  }

  /** check_changes: what 1C would say about a few changes, without a card and without writing. */
  private async checkChanges(
    connection: ReturnType<LocalStore["connection"]>,
    input: CheckChangesInput,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const results: unknown[] = [];
    for (const [i, item] of expandBatch(input).entries()) {
      if (signal.aborted) return { ok: false, code: "STOPPED", message: "Stopped by the user" };
      if (!item.ok) {
        results.push({ n: i + 1, ok: false, error: "VALIDATION", message: item.message });
        continue;
      }
      const preview = await this.deps.connector.tool(connection, "previewChange", item.change);
      if (!preview.ok) {
        results.push({ n: i + 1, ok: false, error: preview.code, message: preview.message });
        continue;
      }
      const shown = preview.data as ChangePreview;
      results.push({
        n: i + 1,
        ok: shown.warnings.length === 0,
        presentation: shown.presentation,
        warnings: shown.warnings,
        fieldsSet: shown.changes.map((c) => c.field),
      });
    }
    return { ok: true, data: { results, note: "Nothing was shown or written." } };
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
        "them, tabular sections included) and send the whole proposal again; a field every document " +
        "lacks goes once into defaults (fields, or rows for a tabular section). A change you cannot fix " +
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

/** A run_query result goes up as a compact table; every other result as JSON. */
function shaped(name: string, result: ToolResult, policy: AiPolicy): string | null {
  return name === "run_query" && result.ok ? shapeQueryResult(result.data, policy) : null;
}

function isDeclined(result: ToolResult): boolean {
  return result.ok && (result.data as { status?: unknown } | null)?.status === "declined_by_user";
}

function toToolResult(toolUseId: string, result: ToolResult, text: string | null = null): AiContentBlock {
  const body =
    text ?? JSON.stringify(result.ok ? result.data : { error: result.code, message: result.message });
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
  if (name === "propose_invoices_issued") {
    const batch = input as { title: string; sales: unknown[] };
    return `${batch.sales.length} · ${batch.title}`;
  }
  if (name === "propose_invoices_received") {
    const batch = input as { title: string; invoices: unknown[] };
    return `${batch.invoices.length} · ${batch.title}`;
  }
  if (name === "check_changes") return String((input as { changes: unknown[] }).changes.length);
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

function dayMonthYear(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

/** What one audit check asks of the model. */
function auditCheckPrompt(check: AuditCheck, view: AuditView): string {
  return [
    `Automated audit check, part of a full audit of this company's 1C base for the period ${view.from} to ${view.to} (both days included).`,
    `Check: ${check.title.en}.`,
    `What to check: ${check.instructions}`,
    "",
    "How:",
    "- Only read 1C (run_query, get_object, describe_objects). Change nothing.",
    "- Work with totals and grouped queries over the whole period; read single documents only where the totals " +
      "show a problem. Keep to about 15 steps, and run independent queries in the same step.",
    "- When the base has several organizations, check only this company's.",
    "- The account numbers above are the usual НСБУ ones: if they do not fit, look the accounts up in " +
      "ПланСчетов.Хозрасчетный (Код, Наименование). If an object or field is missing, find the right one in " +
      "Справочник.ИдентификаторыОбъектовМетаданных (ПолноеИмя, Синоним) or with describe_objects.",
    "- Finish with report_findings, once: ok when nothing is wrong; issues with one finding per problem (most " +
      "important first, at most 50, grouping small similar ones; the amount in UZS, date, counterparty and " +
      "document when known); not_applicable when the area does not exist in this company. If 1C did not let " +
      "you check something, say so in the summary.",
    `- Write the summary, titles and details in ${LANGUAGE_NAMES[view.language]}, short and concrete.`,
  ].join("\n");
}

/** After the checks: the model writes the report from their results, in the chat. */
function auditReportRequest(view: AuditView): string {
  const results = view.checks.map((check) => ({
    section: check.section,
    check: check.title,
    status: check.status,
    summary: check.summary,
    findings: check.findings?.slice(0, 20),
    ...(check.findings && check.findings.length > 20 ? { moreFindings: check.findings.length - 20 } : {}),
  }));
  return [
    `The audit of this company's base for ${view.from} – ${view.to} is finished. The result of each check (JSON):`,
    JSON.stringify(results),
    "",
    `Write the audit report for the accountant in ${LANGUAGE_NAMES[view.language]}: one or two sentences with ` +
      "the overall verdict; then the main problems as a table (problem, amount, what to do), most important " +
      "first, at most 15 rows; then one line on what is in order. Every finding is listed on the screen above " +
      "the report and can be downloaded, so do not repeat them all. Change nothing now; end by saying which " +
      "problems you can fix with cards if the accountant asks.",
  ].join("\n");
}

const CSV_TEXT: Record<
  UiLanguage,
  { header: string[]; status: Record<AuditCheckView["status"], string>; severity: Record<string, string> }
> = {
  en: {
    header: [
      "Section",
      "Check",
      "Result",
      "Importance",
      "Problem",
      "Details",
      "Amount",
      "Date",
      "Counterparty",
      "Document",
    ],
    status: {
      pending: "Not run",
      running: "Not finished",
      ok: "In order",
      issues: "Problems",
      not_applicable: "Not applicable",
      failed: "Not checked",
    },
    severity: { high: "High", medium: "Medium", low: "Low" },
  },
  ru: {
    header: [
      "Раздел",
      "Проверка",
      "Итог",
      "Важность",
      "Проблема",
      "Подробности",
      "Сумма",
      "Дата",
      "Контрагент",
      "Документ",
    ],
    status: {
      pending: "Не запускалась",
      running: "Не завершена",
      ok: "В порядке",
      issues: "Есть проблемы",
      not_applicable: "Не применимо",
      failed: "Не проверено",
    },
    severity: { high: "Высокая", medium: "Средняя", low: "Низкая" },
  },
  uz: {
    header: [
      "Boʻlim",
      "Tekshiruv",
      "Natija",
      "Muhimlik",
      "Muammo",
      "Tafsilotlar",
      "Summa",
      "Sana",
      "Kontragent",
      "Hujjat",
    ],
    status: {
      pending: "Ishga tushmagan",
      running: "Tugamagan",
      ok: "Joyida",
      issues: "Muammolar bor",
      not_applicable: "Taalluqli emas",
      failed: "Tekshirilmagan",
    },
    severity: { high: "Yuqori", medium: "Oʻrta", low: "Past" },
  },
};

export function auditToCsv(view: AuditView): string {
  const text = CSV_TEXT[view.language];
  const cell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  // Excel with a Russian or Uzbek locale reads "1234,5" as a number, not "1234.5".
  const amount = (n: number | undefined) =>
    n === undefined ? "" : view.language === "en" ? String(n) : String(n).replace(".", ",");
  const rows: unknown[][] = [text.header];
  for (const check of view.checks) {
    const base = [check.section, check.title, text.status[check.status]];
    if (!check.findings || check.findings.length === 0) {
      rows.push([...base, "", check.summary ?? "", "", "", "", "", ""]);
      continue;
    }
    for (const f of check.findings) {
      rows.push([
        ...base,
        text.severity[f.severity] ?? f.severity,
        f.title,
        f.detail,
        amount(f.amount),
        f.date ?? "",
        f.counterparty ?? "",
        f.document ?? "",
      ]);
    }
  }
  return `\uFEFF${rows.map((row) => row.map(cell).join(";")).join("\r\n")}\r\n`;
}

/** One item of a batch card and how to write it; apply is null when it is left out. */
interface BatchEntry {
  item: BatchItem;
  change?: ChangeInput;
  apply: (() => Promise<BatchItemResult>) | null;
}

/** What a batch card shows for a document 1C fills itself (an invoice), in the shape of a preview. */
function draftPreview(object: string, presentation: string, fields: [string, unknown][]): ChangePreview {
  return {
    object,
    ref: null,
    presentation,
    posted: false,
    deletionMark: false,
    version: "",
    action: "create",
    willPost: false,
    changes: fields
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([field, after]) => ({ field, before: null, after })),
    tables: [],
    warnings: [],
  };
}

function createdState(object: string, result: ToolResult): BatchItemResult {
  if (!result.ok) return { ok: false, code: result.code, message: result.message };
  const document = result.data as CreateInvoiceResult;
  return {
    ok: true,
    state: {
      object,
      ref: document.ref,
      presentation: `${document.number} · ${document.date.slice(0, 10)}${document.duplicate ? " (already existed)" : ""}`,
      posted: false,
      deletionMark: false,
      version: "",
    },
  };
}
