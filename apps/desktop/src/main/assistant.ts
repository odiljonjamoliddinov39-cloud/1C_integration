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
  type DeleteMarkedPreview,
  type DeleteMarkedResult,
  type BankPaymentsInput,
  type PostCreatedInput,
  type DidoxDeleteDraftInput,
  type DidoxDocumentInput,
  type DidoxReconciliationInput,
  type ObjectSnapshot,
  type DidoxDraftInput,
  AccountingCalcInput,
  type AccountingKnowledgeInput,
  searchKnowledge,
  type CompanyRulesInput,
  type FetchDidoxInput,
  type DidoxInvoicesInput,
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
  ElapsedParts,
  Result,
  UiLanguage,
} from "../shared/ipc.js";
import { applyEvent } from "../shared/transcript.js";
import { AUDIT_CHECKS, AUDIT_SECTIONS, type AuditCheck } from "./audit-checks.js";
import { AttachmentError, type ShrinkImage, dropPages, readAttachments } from "./attachments.js";
import { type TraceLog, tracesFromMessages } from "./ai/backfill.js";
import type { BillingState } from "./billing.js";
import type { ChatStore, StoredChat } from "./chats.js";
import { readTable } from "./tables.js";
import type { ConnectorRunner } from "./connector.js";
import {
  type BankCache,
  type BankCandidate,
  type BankProblem,
  type BankResolved,
  resolvePayments,
} from "./bank/resolve.js";
import { type LedgerPlan, describeLedger, planLedger } from "./bank/ledger.js";
import { type TransfersResolved, resolveTransfers } from "./bank/transfer.js";
import { accountingCalc } from "./calc.js";
import { readSaleKit } from "./didox/sale-kit.js";
import { PolicyMemory, learnPolicy, reflectOnImport } from "./bank/policy.js";
import type { BankPayment, BankStatement } from "./bank/statement.js";
import { DidoxClient, DidoxError } from "./didox/client.js";
import {
  type DidoxDocument,
  batchOf,
  describeBatch,
  describeOutgoing,
  didoxKey,
  money,
  parseDidoxDocument,
} from "./didox/document.js";
import { fetchDidoxDocuments } from "./didox/fetch.js";
import {
  DOCUMENT_DOCTYPE,
  RECONCILIATION_DOCTYPE,
  type RenderPdf,
  createDraft,
  prepareDocumentDraft,
  prepareDraft,
  prepareReconciliationDraft,
} from "./didox/draft.js";
import { documentJson } from "./didox/fetch.js";
import { readReconciliationAct } from "./didox/reconciliation.js";
import { EImzoClient, EImzoError, EImzoSigner } from "./didox/eimzo.js";
import { type Problem, type ResolverCache, lookup, resolveDocuments } from "./didox/resolve.js";
import { ControlError } from "./control-client.js";
import type { ToolResult } from "./onec-jobs.js";
import type { SessionService } from "./session.js";
import type { LocalStore } from "./store.js";

/**
 * Model turns per question: a safety stop for a model going in circles, far above what real work
 * takes (a whole bank statement with checks and cards). The user can stop it at any time. Before
 * the last turn the model is told to answer with what it has found.
 */
/** Questions that are mostly entering documents the program reads (Didox, bank statements): cheaper thinking is enough. */
const ENTRY_WORDS = /didox|дидокс|didoks|ko['ʻ’]?chirma|выписк|bank statement/i;

/** Reads of 1C a question may make through the model; the program's own reads (tools) are not counted. */
const READ_BUDGET = 40;

/** Model steps for one question: a job that needs more is split by the model into parts, not left to run for an hour. */
const MAX_TURNS = 60;
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
  /** Learn how the company works from its 1C before each question; on unless false (tests count 1C calls). */
  learnPolicy?: boolean;
  /** The audit's checklist and how many checks run at once (tests use their own). */
  auditChecks?: AuditCheck[];
  auditConcurrency?: number;
  /** The cost engine (limits, templates, answer cache, digest); one is made when absent. */
  engine?: CostEngine;
  /** Which messages of which chats the engine has already learned from (see backfillTraces). */
  traceLog?: TraceLog;
  /** The plan's limits: read-only companies, and the monthly counts of imports and audits. */
  billing?: Pick<BillingState, "isReadOnly" | "countImport" | "countAudit">;
  /** E-IMZO and the network for Didox; the real ones unless a test hands in fakes. */
  didox?: { eimzo?: EImzoClient; fetch?: typeof fetch };
  /** Prints an HTML page to a PDF (Electron); absent in tests that do not make letters. */
  renderPdf?: RenderPdf;
}

const READ_ONLY_MESSAGE =
  "This company is over the plan's limit: its data is visible, but imports and the assistant are off. Upgrade the plan or choose which companies stay active.";

/** Where a task's time went (see ElapsedParts). */
interface TaskTiming {
  modelMs: number;
  onecMs: number;
  steps: number;
  tools: { tool: string; ms: number }[];
}

/** The question itself asks for posted documents ("проведи", "post", "o'tkaz"). */
export function asksToPost(question: string): boolean {
  return /провед|проводк|\bpost(ed|ing)?\b|o['ʻ‘’]tkaz/iu.test(question);
}

/** What one question runs under: the limits in force, and what kind of question it is. */
interface Run {
  policy: AiPolicy;
  task: "lookup" | "work";
  /** The question came with files to enter into 1C: the server may think less (AI_IMPORT_EFFORT). */
  import: boolean;
  /** Set once the user declined an answer: the rest of the question runs on the default model. */
  escalate: boolean;
  /** What was done for this question: the engine learns from it when it ends. */
  trace: TraceBuilder;
  /** Times this question read rows of a bank statement by hand (read_attachment without totals). */
  bankRowReads: number;
  /** Reads of 1C by the model in this question (queries, structure, objects): they are capped. */
  reads: number;
}

type Emit = (event: DistributiveOmit<AssistantEvent, "companyId">) => void;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class AssistantService {
  /** Per company: the open chat. */
  private readonly open = new Map<string, StoredChat>();
  /** What was learned of how each company works (its bank accounts, documents, postings), kept for hours. */
  private readonly policies = new PolicyMemory();
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
  /**
   * Companies whose current question brings files to enter into 1C: what it creates is saved
   * unposted, whatever the model asks, unless the accountant asked for posting in the question.
   */
  private readonly unposted = new Set<string>();
  /** What was learned from each base about its nomenclature (which attribute holds the IKPU code). */
  private readonly resolverCache = new Map<string, ResolverCache>();
  /** Per company: where the current task's time goes (model, 1C), to show and to name a slow step. */
  private readonly timing = new Map<string, TaskTiming>();

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
    if (this.deps.billing?.isReadOnly(company.inn))
      return this.fail(notify, "COMPANY_READ_ONLY", READ_ONLY_MESSAGE);
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
    // Several bank statements of one company are read together: what each account is and how they link.
    const blocks = [...attached.blocks];
    if (attached.bank.length > 0) {
      const all = mergeBank(chat.bank ?? [], attached.bank);
      if (all.length >= 2) {
        blocks.push({
          type: "document",
          source: {
            type: "text",
            media_type: "text/plain",
            data: describeLedger(planLedger(all, { ownInn: this.deps.store.company(companyId).inn })),
          },
          title: "Bank accounts of this chat",
        });
      }
    }
    let content: AiMessage["content"] =
      blocks.length > 0 ? [...blocks, { type: "text", text: question }] : question;
    // Pages and pictures of earlier questions were read; only their names stay.
    chat.messages = dropPages(chat.messages);
    // A question that ended without answering the model's last tool calls (a crash, a closed app) would make the API
    // refuse every later one: they are answered first, as not run.
    const unanswered = unansweredCalls(chat.messages);
    if (unanswered.length > 0) {
      const notRun = {
        ok: false,
        code: "NOT_RUN",
        message: "The previous question ended before this ran",
      } as const;
      content = [
        ...unanswered.map((id) => toToolResult(id, notRun)),
        ...(typeof content === "string" ? [{ type: "text", text: content }] : content),
      ];
    }
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
    if (attached.didox.length > 0) chat.didox = mergeDidox(chat.didox ?? [], attached.didox);
    if (attached.bank.length > 0) chat.bank = mergeBank(chat.bank ?? [], attached.bank);
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
        if (attached.blocks.length > 0 && !asksToPost(question)) this.unposted.add(companyId);
        const run: Run = {
          policy: await this.engine.policy(),
          task: classifyTask(question, attached.blocks.length > 0),
          // Files to enter, or a question about Didox or a bank statement: transcription, run at the import effort.
          import: attached.blocks.length > 0 || ENTRY_WORDS.test(question),
          escalate: false,
          trace: new TraceBuilder(),
          bankRowReads: 0,
          reads: 0,
        };
        const result = await this.converse(chat, company.name, emit, abort.signal, run);
        if (result.ok && standalone) this.rememberAnswer(chat, company.name, question);
        // Every finished question teaches the engine: what was done, how it ended, no data.
        void this.engine
          .sendTrace(
            run.trace.build(
              company.name,
              question,
              result.ok ? { ok: true } : { ok: false, code: result.code },
            ),
          )
          .then((sent) => {
            // This chat's questions up to here are learned from; a replay starts after them.
            if (sent) this.deps.traceLog?.set(chat.id, chat.messages.length);
          });
        return result;
      } finally {
        // Built after the answer, so the first question is not held up by it.
        this.engine.ensureDigest(companyId, company.name, connection);
      }
    });
  }

  /**
   * Teaches the engine what this PC already knows: the questions in the saved chats, the queries that
   * answered them and what they returned, replayed through the rules that watch a live question. Only
   * traces (the query, the question, the columns; no figures) go to the server, where the usual
   * reasoning decides which become templates. Each chat is replayed once, from where it was left.
   */
  async backfillTraces(limit = 300): Promise<{ sent: number }> {
    const log = this.deps.traceLog;
    if (!log) return { sent: 0 };
    if (!(await this.engine.policy()).learnTemplates) return { sent: 0 };
    let sent = 0;
    for (const company of this.deps.store.listCompanies()) {
      if (this.running.has(company.id)) continue;
      for (const summary of this.deps.chats.list(company.id)) {
        if (sent >= limit) return { sent };
        const chat = this.deps.chats.load(company.id, summary.id);
        if (!chat || log.get(chat.id) >= chat.messages.length) continue;
        const days = [...new Set([chat.createdAt, chat.updatedAt].map((d) => d.slice(0, 10)))].map(
          (d) => new Date(`${d}T12:00:00Z`),
        );
        let complete = true;
        for (const trace of tracesFromMessages(chat.messages, log.get(chat.id), company.name, days)) {
          if (!(await this.engine.sendTrace(trace))) {
            complete = false;
            break;
          }
          sent += 1;
        }
        if (complete) log.set(chat.id, chat.messages.length);
      }
    }
    return { sent };
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
    this.timing.set(companyId, { modelMs: 0, onecMs: 0, steps: 0, tools: [] });
    try {
      return await work();
    } catch (e) {
      if (e instanceof ControlError) return this.fail(emit, e.code, e.message);
      return this.fail(emit, "INTERNAL", e instanceof Error ? e.message : String(e));
    } finally {
      const waited = this.cardWaitMs.get(companyId) ?? 0;
      this.cardWaitMs.delete(companyId);
      const timing = this.timing.get(companyId);
      this.timing.delete(companyId);
      this.unposted.delete(companyId);
      const parts: ElapsedParts | undefined =
        timing && timing.steps > 0
          ? {
              modelMs: timing.modelMs,
              onecMs: timing.onecMs,
              steps: timing.steps,
              slowest: timing.tools.sort((a, b) => b.ms - a.ms).slice(0, 3),
            }
          : undefined;
      emit({
        type: "elapsed",
        ms: Math.max(0, Date.now() - started - waited),
        ...(parts ? { parts } : {}),
      });
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
    // How the company works, from its own 1C: with every question, so the practice is followed, not guessed.
    const learned = (await this.policyOf(chat.companyId)).text;
    for (let turn = 0; turn < maxTurns; turn++) {
      const stepStarted = Date.now();
      // Read again each step: a rule the model has just saved is in force for the rest of this question.
      const policy = this.practiceOf(chat.companyId, learned);
      const answer = await this.turnWithRetries(
        {
          company: companyName,
          tools: CHAT_TOOLS,
          ...(policy ? { policy } : {}),
          task: run.task,
          ...(run.import ? { kind: "import" as const } : {}),
          ...(run.escalate ? { escalate: true } : {}),
          messages: history,
        },
        emit,
        signal,
      );
      const timing = this.timing.get(chat.companyId);
      if (timing) {
        timing.modelMs += Date.now() - stepStarted;
        timing.steps += 1;
      }
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
        const toolStarted = Date.now();
        const waitedBefore = this.cardWaitMs.get(chat.companyId) ?? 0;
        const result = await this.runToolSafely(chat, use, emit, signal, run);
        // Time in 1C: what the tool took, without the card waiting for the user.
        const toolMs = Math.max(
          0,
          Date.now() - toolStarted - ((this.cardWaitMs.get(chat.companyId) ?? 0) - waitedBefore),
        );
        const timing = this.timing.get(chat.companyId);
        if (timing) {
          timing.onecMs += toolMs;
          timing.tools.push({ tool: use.name, ms: toolMs });
        }
        // A card the user declined: the rest of the question runs on the default model.
        if (isDeclined(result)) run.escalate = true;
        if (!signal.aborted) {
          try {
            if ((AI_PROPOSAL_TOOLS as readonly string[]).includes(use.name)) {
              run.trace.propose(use.name, use.input, result);
            } else {
              run.trace.read(use.name, use.input, result);
            }
          } catch {
            // The trace is for learning only: a call of a shape it does not know never breaks the question.
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
    if (this.deps.billing?.isReadOnly(company.inn))
      return this.fail(notify, "COMPANY_READ_ONLY", READ_ONLY_MESSAGE);
    if (this.running.has(companyId)) return this.fail(notify, "BUSY", "The assistant is still answering");
    const counted = await this.deps.billing?.countAudit(company.inn);
    if (counted && !counted.ok) return this.fail(notify, counted.code, counted.message);

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
      const practice = this.practiceOf(companyId, (await this.policyOf(companyId)).text);
      const queue = checks.map((check, i) => ({ check, state: view.checks[i] as AuditCheckView }));
      const worker = async () => {
        for (let next = queue.shift(); next && !abort.signal.aborted; next = queue.shift()) {
          const { check, state } = next;
          state.status = "running";
          show();
          const started = Date.now();
          const result = await this.runCheck(
            company.name,
            practice,
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
        import: false,
        escalate: false,
        trace: new TraceBuilder(),
        bankRowReads: 0,
        reads: 0,
      });
    });
  }

  /** One audit check: the model reads 1C until it reports what it found. */
  private async runCheck(
    companyName: string,
    practice: string,
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
          { company: companyName, tools: AUDIT_TOOLS, ...(practice ? { policy: practice } : {}), messages },
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

  /**
   * A tool never ends the question by failing: whatever it throws becomes its result, so the model is told and the
   * conversation stays valid (every call has a result).
   */
  private async runToolSafely(
    chat: StoredChat,
    use: AiToolUse,
    emit: Emit,
    signal: AbortSignal,
    run: Run,
  ): Promise<ToolResult> {
    if (signal.aborted) return { ok: false, code: "STOPPED", message: "Stopped by the user" };
    try {
      return await this.runTool(chat, use, emit, signal, run);
    } catch (e) {
      if (signal.aborted) return { ok: false, code: "STOPPED", message: "Stopped by the user" };
      console.error(`The tool ${use.name} failed:`, e);
      return {
        ok: false,
        code: "TOOL_FAILED",
        message: `${use.name} failed inside the app (${e instanceof Error ? e.message : "unknown error"}); try another way or say what is missing`,
      };
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
    // The cost stop: a question that keeps reading 1C without writing is exploring. Past the budget the model is told
    // to answer with what it has or ask, so that no question can run for an hour and use the day's limit.
    if (use.name === "run_query" || use.name === "describe_objects" || use.name === "get_object") {
      run.reads += 1;
      if (run.reads > READ_BUDGET) {
        return {
          ok: false,
          code: "READ_BUDGET",
          message:
            `${READ_BUDGET} reads of 1C were made for this question: stop reading. Answer with what you have, saying what ` +
            "is missing, or ask the accountant one short question. A big job is split by period or by kind and done in parts.",
        };
      }
    }
    if (use.name === "report_findings") {
      return { ok: false, code: "UNKNOWN_TOOL", message: "report_findings is only for audit checks" };
    }
    emit({ type: "tool", name: use.name, detail: describe(use.name, input.data) });
    if (use.name === "read_attachment") {
      const read = input.data as ReadAttachmentInput;
      // A bank statement is read by the program. Reading its rows over and over is what burned a whole day's
      // budget on one import: after a few reads the model is sent back to the tool that does the work.
      const isStatement = (chat.bank ?? []).some((s) => s.fileName.toLowerCase() === read.file.toLowerCase());
      if (isStatement && !read.group_by && !read.sum) {
        run.bankRowReads += 1;
        if (run.bankRowReads > BANK_ROW_READS) {
          return {
            ok: false,
            code: "USE_BANK_TOOL",
            message:
              `Stop reading the rows of ${read.file} by hand (${BANK_ROW_READS} reads already): the program has read this bank statement. ` +
              "Call propose_bank_payments (title, from, to): it takes the period, the bank fees and the payments itself, and what it " +
              "cannot settle comes back with each row's date, amount, name and purpose. Use read_attachment only with group_by or sum.",
          };
        }
      }
      return readTable(chat.tables ?? [], read);
    }
    if (use.name === "fetch_didox_documents") {
      // Entering what Didox holds is transcription, not open thinking: the next steps run at the import effort.
      run.import = true;
      return this.fetchDidox(chat, input.data as FetchDidoxInput, signal);
    }
    if (use.name === "learn_accounting_policy") {
      return this.learnAccountingPolicy(chat);
    }
    if (use.name === "accounting_knowledge") {
      return this.accountingKnowledge(chat, input.data as AccountingKnowledgeInput);
    }
    if (use.name === "company_rules") {
      const ask = input.data as CompanyRulesInput;
      let rules: string[];
      if (ask.action === "add") {
        if (!ask.rule) return { ok: false, code: "BAD_INPUT", message: "add needs the rule as one sentence" };
        rules = this.deps.store.addRule(chat.companyId, ask.rule);
      } else if (ask.action === "remove") {
        if (ask.which === undefined)
          return { ok: false, code: "BAD_INPUT", message: "remove needs the rule's number or words in it" };
        rules = this.deps.store.removeRule(chat.companyId, ask.which);
      } else {
        rules = this.deps.store.rules(chat.companyId);
      }
      return { ok: true, data: { rules: rules.map((r, i) => `${i + 1}. ${r}`) } };
    }
    if (use.name === "accounting_calc") {
      const checked = AccountingCalcInput.safeParse(input.data);
      if (!checked.success) {
        return {
          ok: false,
          code: "BAD_CALC_INPUT",
          message: `Fix the inputs of ${(input.data as { op?: string }).op ?? "the calculation"}: ${checked.error.issues
            .slice(0, 6)
            .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
            .join("; ")}`,
        };
      }
      return { ok: true, data: accountingCalc(checked.data) };
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
    origins?: DidoxOrigin[],
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
    if (tool === "propose_didox_invoices") {
      return this.proposeDidox(chat, input as DidoxInvoicesInput, emit, signal);
    }
    if (tool === "propose_bank_payments") {
      return this.proposeBank(chat, input as BankPaymentsInput, emit, signal);
    }
    if (tool === "propose_post_created") {
      return this.proposePostCreated(chat, input as PostCreatedInput, emit, signal);
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
      const prepared = await this.prepareBatch(
        chat.companyId,
        chat.id,
        tool,
        input,
        connection,
        signal,
        origins,
      );
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
        entries.forEach((entry, i) => {
          const done = results[i];
          if (entry.change?.action === "create" && done?.ok) this.noteCreated(chat, done.state);
        });
        return { ok: true, data: results };
      };
    } else if (tool === "propose_delete_marked") {
      emit({ type: "tool", name: tool, detail: describe(tool, input) });
      const preview = await this.deps.connector.tool(connection, "previewDeleteMarked", input);
      if (!preview.ok) return preview;
      const found = preview.data as DeleteMarkedPreview;
      // Nothing is marked: nothing to confirm.
      if (found.total === 0) return { ok: true, data: { status: "nothing_marked" } };
      proposal = { kind: "delete_marked", preview: found };
      create = () => this.deps.connector.tool(connection, "deleteMarked", input);
    } else if (tool === "propose_change") {
      const change = this.unpostedIfImport(companyId, input as ChangeInput);
      emit({ type: "tool", name: tool, detail: describe(tool, change) });
      const preview = await this.deps.connector.tool(connection, "previewChange", change);
      if (!preview.ok) return preview;
      const shown = preview.data as ChangePreview;
      const unfixed = this.fillCheck(chat.id, [{ n: 1, change, warnings: shown.warnings }]);
      if (unfixed) return unfixed;
      proposal = { kind: "change", preview: shown };
      // The version seen on the card: if someone changes the object meanwhile, 1C refuses.
      create = async () => {
        const applied = await this.deps.connector.tool(connection, "applyChange", {
          ...change,
          version: shown.version,
        });
        if (applied.ok && change.action === "create") this.noteCreated(chat, applied.data as ObjectState);
        return applied;
      };
    } else if (tool === "propose_didox_reconciliation") {
      emit({ type: "tool", name: tool, detail: describe(tool, input) });
      const prepared = await this.prepareDidoxReconciliation(chat, input as DidoxReconciliationInput);
      if ("early" in prepared) return prepared.early;
      proposal = prepared.proposal;
      create = prepared.create;
    } else if (tool === "propose_didox_delete_draft") {
      emit({ type: "tool", name: tool, detail: describe(tool, input) });
      const prepared = await this.prepareDidoxDelete(chat, input as DidoxDeleteDraftInput);
      if ("early" in prepared) return prepared.early;
      proposal = prepared.proposal;
      create = prepared.create;
    } else if (tool === "propose_didox_document") {
      emit({ type: "tool", name: tool, detail: describe(tool, input) });
      const prepared = await this.prepareDidoxDocument(chat, input as DidoxDocumentInput);
      if ("early" in prepared) return prepared.early;
      proposal = prepared.proposal;
      create = prepared.create;
    } else if (tool === "propose_didox_draft") {
      emit({ type: "tool", name: tool, detail: describe(tool, input) });
      const prepared = await this.prepareDidoxDraft(chat, input as DidoxDraftInput);
      if ("early" in prepared) return prepared.early;
      proposal = prepared.proposal;
      create = prepared.create;
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
    // Documents the plan counts (invoices, and the rows of a batch): reserved before anything is written.
    const documents =
      proposal.kind === "invoice_received" || proposal.kind === "invoice_issued"
        ? 1
        : proposal.kind === "batch"
          ? // Posting or correcting documents that already exist is not a new document.
            proposal.items.filter(
              (item) => !item.error && item.action === "create" && item.object.startsWith("Документ."),
            ).length
          : 0;
    if (documents > 0 && this.deps.billing) {
      const counted = await this.deps.billing.countImport(documents, this.deps.store.company(companyId).inn);
      if (!counted.ok) {
        decided({ status: "failed", code: counted.code, message: counted.message });
        return counted;
      }
    }
    // The books are about to change: answers kept before now are no longer valid.
    this.engine.noteWrite(companyId);
    const result = await create();
    if (!result.ok) {
      decided({ status: "failed", code: result.code, message: result.message });
      return result;
    }
    if (proposal.kind === "delete_marked") {
      const removed = result.data as DeleteMarkedResult;
      decided({ status: "removed", result: removed });
      return { ok: true, data: { status: "done", ...removed } };
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
    if (proposal.kind === "didox_delete") {
      decided({ status: "didox_deleted", id: proposal.draft.id });
      return {
        ok: true,
        data: { status: "draft_deleted", draftId: proposal.draft.id, note: "The draft is deleted in Didox." },
      };
    }
    if (
      proposal.kind === "didox_draft" ||
      proposal.kind === "didox_document" ||
      proposal.kind === "didox_reconciliation"
    ) {
      const { id } = result.data as { id: string };
      decided({ status: "didox_draft", id });
      return {
        ok: true,
        data: {
          status: "draft_created",
          draftId: id,
          note: "A DRAFT only: it is not signed and not sent. The accountant checks and signs it in Didox.",
        },
      };
    }
    const document = result.data as CreateInvoiceResult;
    decided({ status: "created", document });
    return { ok: true, data: { status: document.duplicate ? "already_exists" : "created", document } };
  }

  /** The company's Didox client (one per saved address and key, so the key's password is asked once). */
  private readonly didoxClients = new Map<string, { key: string; client: DidoxClient }>();

  private didoxClient(companyId: string): DidoxClient | null {
    const settings = this.deps.store.company(companyId).didox;
    if (!settings) return null;
    const key = `${settings.baseUrl}|${settings.serialNumber}`;
    const cached = this.didoxClients.get(companyId);
    if (cached?.key === key) return cached.client;
    const client = new DidoxClient(
      { baseUrl: settings.baseUrl, ...(this.deps.didox?.fetch ? { fetch: this.deps.didox.fetch } : {}) },
      new EImzoSigner(this.deps.didox?.eimzo ?? new EImzoClient(), { serialNumber: settings.serialNumber }),
    );
    this.didoxClients.set(companyId, { key, client });
    return client;
  }

  /** What 1C says about how the company works: bank accounts and their use, transfer kinds, the policy register. */
  /**
   * The engine's own accounting knowledge for a question, with the account groups it names checked against this
   * base's chart: what the base lacks is said, so that the model does not book to an account that is not there.
   */
  private async accountingKnowledge(chat: StoredChat, ask: AccountingKnowledgeInput): Promise<ToolResult> {
    const found = searchKnowledge(ask.query, ask.limit ?? 3);
    if (found.length === 0) {
      return {
        ok: true,
        data: {
          found: 0,
          note: "Nothing in the knowledge base fits. Reason from the company's own practice (given above) and its earlier documents, and say what you assumed.",
        },
      };
    }
    const codes = [...new Set(found.flatMap((e) => e.accounts ?? []))];
    let absent: string[] | null = null;
    if (codes.length > 0) {
      const connection = this.deps.store.connection(chat.companyId);
      const rows = await lookup(
        {
          query: (query: RunQueryInput) => this.deps.connector.tool(connection, "run_query", query),
          describe: () => Promise.resolve({ ok: false as const, code: "NOT_USED", message: "" }),
        },
        (ph) =>
          `ВЫБРАТЬ РАЗЛИЧНЫЕ ПОДСТРОКА(Т.Код, 1, 4) КАК Код ИЗ ПланСчетов.Хозрасчетный КАК Т ГДЕ ПОДСТРОКА(Т.Код, 1, 4) В (${ph})`,
        codes,
      ).catch(() => null);
      if (rows && rows.length > 0) {
        const have = new Set(rows.map((r) => String(r.cells[0])));
        absent = codes.filter((c) => !have.has(c));
      }
    }
    return {
      ok: true,
      data: {
        found: found.length,
        entries: found.map((e) => ({
          id: e.id,
          kind: e.kind,
          title: e.title,
          lines: e.lines,
          ...(e.calc ? { calc: `accounting_calc op ${e.calc}` } : {}),
          ...(e.confirm ? { confirm: e.confirm } : {}),
          ...(absent
            ? {
                accountsNotInThisBase: (e.accounts ?? []).filter((c) => absent.includes(c)),
              }
            : {}),
        })),
        note: "General НСБУ practice: the company's own postings (the practice above) come first; confirm what an entry says to confirm.",
      },
    };
  }

  /** What the model is told about this company: the accountant's standing rules first, then what was learned from 1C. */
  private practiceOf(companyId: string, learned: string): string {
    const kept = this.deps.store.rules(companyId);
    // The newest rules that fit; they are the accountant's decisions, so they are never the part that is cut.
    const lines: string[] = [];
    let size = 0;
    for (let i = kept.length - 1; i >= 0; i--) {
      const line = `${i + 1}. ${kept[i]}`;
      if (size + line.length > 3500) break;
      lines.unshift(line);
      size += line.length + 1;
    }
    const rules = lines.length
      ? `Standing rules the accountant gave for this company (follow them, do not ask again, and do not contradict them):\n${lines.join("\n")}`
      : "";
    return [rules, learned].filter(Boolean).join("\n\n").slice(0, 12_000);
  }

  private policyOf(companyId: string, force = false) {
    if (this.deps.learnPolicy === false) return Promise.resolve({ policy: null, text: "" });
    const connection = this.deps.store.connection(companyId);
    const inn = this.deps.store.company(companyId).inn;
    return this.policies.get(
      companyId,
      () =>
        learnPolicy(
          {
            query: (query: RunQueryInput) => this.deps.connector.tool(connection, "run_query", query),
            describe: (objects: string[]) =>
              this.deps.connector.tool(connection, "describe_objects", { objects }),
          },
          inn,
        ),
      force,
    );
  }

  private async learnAccountingPolicy(chat: StoredChat): Promise<ToolResult> {
    const learned = await this.policyOf(chat.companyId, true);
    return learned.text
      ? { ok: true, data: { policy: learned.text } }
      : {
          ok: false,
          code: "POLICY_NOT_READ",
          message: "1C did not answer: the company's practice could not be read now",
        };
  }

  /**
   * Reads documents from Didox's API. The incoming ones (the company is the buyer) join the chat's Didox
   * documents, as attached files do; the outgoing ones are listed for comparing with 1C. Nothing is changed.
   */
  private async fetchDidox(
    chat: StoredChat,
    input: FetchDidoxInput,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const client = this.didoxClient(chat.companyId);
    if (!client) {
      return {
        ok: false,
        code: "NO_DIDOX_CONNECTION",
        message:
          "Didox is not connected for this company. Ask the accountant to open Companies, press the Didox " +
          "test button, run the test, choose the signature key and press Save for this company.",
      };
    }
    const own = this.deps.store.company(chat.companyId).inn;
    const today = new Date().toISOString().slice(0, 10);
    const from = input.from ?? `${today.slice(0, 4)}-01-01`;
    const to = input.to ?? today;
    let read: Awaited<ReturnType<typeof fetchDidoxDocuments>>;
    try {
      read = await fetchDidoxDocuments(
        client,
        { from, to, direction: input.direction ?? "incoming", limit: input.limit ?? 100 },
        signal,
      );
    } catch (e) {
      if (e instanceof DidoxError || e instanceof EImzoError)
        return { ok: false, code: e.code, message: e.message };
      return { ok: false, code: "DIDOX_FAILED", message: e instanceof Error ? e.message : String(e) };
    }
    if (signal.aborted) return { ok: false, code: "STOPPED", message: "Stopped by the user" };
    const incoming = read.documents.filter((d) => d.buyer.tin === own);
    const outgoing = read.documents.filter((d) => d.seller.tin === own);
    const other = read.documents.length - incoming.length - outgoing.length;
    if (incoming.length > 0) {
      chat.didox = mergeDidox(chat.didox ?? [], incoming);
      this.save(chat);
    }
    // What entering the issued ones as sales needs from 1C, read here in one go, not by the model step by step.
    let saleKit = "";
    if (outgoing.length > 0 && outgoing.length <= 20) {
      const connection = this.deps.store.connection(chat.companyId);
      saleKit = await readSaleKit(
        {
          query: (query: RunQueryInput) => this.deps.connector.tool(connection, "run_query", query),
          describe: (objects: string[]) =>
            this.deps.connector.tool(connection, "describe_objects", { objects }),
        },
        outgoing,
      ).catch(() => "");
    }
    return {
      ok: true,
      data: {
        period: { from, to },
        read: read.documents.length,
        incomingCount: incoming.length,
        outgoingCount: outgoing.length,
        ...(other > 0 ? { otherCompanies: other } : {}),
        skipped: read.skipped,
        ...(read.failed.length > 0 ? { failed: read.failed.slice(0, 10) } : {}),
        ...(read.truncated
          ? {
              truncated:
                "There are more documents in this period: ask for a shorter period, one month at a time.",
            }
          : {}),
        ...(incoming.length > 0
          ? {
              incomingSummary: describeBatch(batchOf(incoming)),
              next: "These incoming documents are now in the chat: enter them with propose_didox_invoices (title only).",
            }
          : {}),
        ...(outgoing.length > 0
          ? {
              outgoingList: outgoing.map(
                (d) =>
                  `${d.number}|${d.date}|${d.buyer.name} (INN ${d.buyer.tin})|total ${money(d.totals.total)}|${d.kind}`,
              ),
              outgoingSummary: describeOutgoing(outgoing),
              ...(saleKit ? { saleKit } : {}),
              outgoingNote:
                "Issued by this company: compare with 1C (number, date, counterparty INN, amount) and report the differences. " +
                "The summary has their lines (name, unit, quantity, price, VAT): when the accountant asks to enter them into 1C, " +
                "make the sale and then the issued invoice from those lines. Never say Didox gives no lines.",
            }
          : {}),
      },
    };
  }

  /**
   * The 1C document a Didox document is made from: it must exist, not be marked for deletion, and carry the
   * number and date the Didox document has (and, when posting matters, be posted). What is wrong comes back as
   * problems the model must settle first: apply the document in 1C, then go to Didox. `required` false: no source
   * is needed (a letter), but one that is given is still checked.
   */
  private async checkOnecSource(
    companyId: string,
    source: { object: string; ref: string } | undefined,
    need: { number: string; date: string; posted: boolean; what: string; text?: string },
    required = true,
  ): Promise<{ problems: { code: string; message: string }[] } | { error: ToolResult }> {
    if (!source) {
      return {
        problems: required
          ? [
              {
                code: "NO_1C_DOCUMENT",
                message: `First apply the document in 1C (propose_changes, then its card), and pass onec: {object, ref} of ${need.what}. Read its number and date from 1C and give them here as they are.`,
              },
            ]
          : [],
      };
    }
    const read = await this.deps.connector.tool(this.deps.store.connection(companyId), "get_object", source);
    if (!read.ok) return { error: read };
    const snapshot = read.data as ObjectSnapshot;
    const problems: { code: string; message: string }[] = [];
    const text = (value: unknown) =>
      typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
    const number = text(snapshot.fields.Номер ?? snapshot.fields.Number);
    const date = text(snapshot.fields.Дата ?? snapshot.fields.Date).slice(0, 10);
    if (snapshot.deletionMark)
      problems.push({
        code: "ONEC_DELETED",
        message: `${snapshot.presentation} is marked for deletion in 1C.`,
      });
    if (number && number !== need.number.trim())
      problems.push({
        code: "ONEC_NUMBER",
        message: `The number in 1C is ${number}, not ${need.number}: use the number from 1C.`,
      });
    if (date && date !== need.date)
      problems.push({
        code: "ONEC_DATE",
        message: `The date in 1C is ${date}, not ${need.date}: use the date from 1C.`,
      });
    if (need.posted && !snapshot.posted)
      problems.push({
        code: "ONEC_NOT_POSTED",
        message: `${snapshot.presentation} is not posted in 1C: post it first.`,
      });
    if (need.text !== undefined) {
      const shown = need.date.split("-").reverse().join(".");
      if (!need.text.includes(need.number.trim()) || !need.text.includes(shown))
        problems.push({
          code: "TEXT_NUMBER",
          message: `The text must name the document's number ${need.number} and date ${shown} as in 1C.`,
        });
    }
    return { problems };
  }

  /** A failure of Didox or E-IMZO as a tool result. */
  private didoxFailure(e: unknown): ToolResult {
    if (e instanceof DidoxError || e instanceof EImzoError)
      return { ok: false, code: e.code, message: e.message };
    return { ok: false, code: "DIDOX_FAILED", message: e instanceof Error ? e.message : String(e) };
  }

  private noDidox(): ToolResult {
    return {
      ok: false,
      code: "NO_DIDOX_CONNECTION",
      message:
        "Didox is not connected for this company. Ask the accountant to open Companies, press the Didox " +
        "test button, run the test, choose the signature key and press Save for this company.",
    };
  }

  /**
   * A reconciliation act from the saved act in 1C: the app reads its rows, contract and period and works every
   * balance out; the card shows the table and the balances; a confirmation makes a DRAFT in Didox (type 052).
   */
  private async prepareDidoxReconciliation(
    chat: StoredChat,
    input: DidoxReconciliationInput,
  ): Promise<{ early: ToolResult } | { proposal: Proposal; create: () => Promise<ToolResult> }> {
    const client = this.didoxClient(chat.companyId);
    if (!client) return { early: this.noDidox() };
    const read = await this.deps.connector.tool(
      this.deps.store.connection(chat.companyId),
      "get_object",
      input.onec,
    );
    if (!read.ok) return { early: read };
    const snapshot = read.data as ObjectSnapshot;
    const attention = (problems: { code: string; message: string }[]): { early: ToolResult } => ({
      early: { ok: true, data: { status: "needs_attention", problems } },
    });
    if (snapshot.deletionMark)
      return attention([
        { code: "ONEC_DELETED", message: `${snapshot.presentation} is marked for deletion in 1C.` },
      ]);
    const act = readReconciliationAct(snapshot);
    if (!act.ok) return attention(act.problems);
    const key = ["rec", act.act.number, act.act.date, input.buyerInn].join("|");
    const known = chat.didoxDrafts?.find((d) => d.key === key);
    if (known) return { early: { ok: true, data: { status: "already_exists", draftId: known.id } } };
    let prepared: Awaited<ReturnType<typeof prepareReconciliationDraft>>;
    try {
      prepared = await prepareReconciliationDraft(
        client,
        act.act,
        input.buyerInn,
        this.deps.store.company(chat.companyId).inn,
        input.openings ?? [],
        input.text,
      );
    } catch (e) {
      return { early: this.didoxFailure(e) };
    }
    if (!prepared.ok) return attention(prepared.problems);
    const { body, preview } = prepared;
    return {
      proposal: { kind: "didox_reconciliation", act: preview },
      create: async () => {
        try {
          const id = await createDraft(client, body, RECONCILIATION_DOCTYPE);
          chat.didoxDrafts = [...(chat.didoxDrafts ?? []), { key, id }];
          this.save(chat);
          return { ok: true, data: { id } };
        } catch (e) {
          return this.didoxFailure(e);
        }
      },
    };
  }

  /**
   * A wrong draft in Didox to delete: the card says which document it is (as far as Didox tells), and only the
   * confirmation deletes it. Didox deletes drafts only, so a signed or sent document cannot be removed this way.
   */
  private async prepareDidoxDelete(
    chat: StoredChat,
    input: DidoxDeleteDraftInput,
  ): Promise<{ early: ToolResult } | { proposal: Proposal; create: () => Promise<ToolResult> }> {
    const client = this.didoxClient(chat.companyId);
    if (!client) return { early: this.noDidox() };
    let details: unknown;
    try {
      details = await client.documentInfo(input.id);
    } catch (e) {
      if (e instanceof DidoxError && e.status === 404)
        return { early: { ok: false, code: "NOT_FOUND", message: `Didox has no document ${input.id}.` } };
      return { early: this.didoxFailure(e) };
    }
    const json = documentJson(details);
    const parsed = json === null ? null : parseDidoxDocument(json);
    const raw = (details && typeof details === "object" ? details : {}) as Record<string, unknown>;
    const draft = {
      id: input.id,
      number: parsed?.number ?? (typeof raw.name === "string" ? raw.name : ""),
      date: parsed?.date ?? "",
      recipient: parsed?.buyer.name ?? "",
    };
    return {
      proposal: { kind: "didox_delete", draft },
      create: async () => {
        try {
          await client.deleteDraft(input.id);
          chat.didoxDrafts = (chat.didoxDrafts ?? []).filter((d) => d.id !== input.id);
          this.save(chat);
          return { ok: true, data: { id: input.id } };
        } catch (e) {
          return this.didoxFailure(e);
        }
      },
    };
  }

  /**
   * A letter or another free-form document for Didox: the parties are read from Didox, the text becomes a PDF,
   * the card shows what will go, and a confirmation makes a DRAFT there (not signed, not sent).
   */
  private async prepareDidoxDocument(
    chat: StoredChat,
    input: DidoxDocumentInput,
  ): Promise<{ early: ToolResult } | { proposal: Proposal; create: () => Promise<ToolResult> }> {
    const client = this.didoxClient(chat.companyId);
    if (!client) {
      return {
        early: {
          ok: false,
          code: "NO_DIDOX_CONNECTION",
          message:
            "Didox is not connected for this company. Ask the accountant to open Companies, press the Didox " +
            "test button, run the test, choose the signature key and press Save for this company.",
        },
      };
    }
    if (!this.deps.renderPdf) {
      return { early: { ok: false, code: "NO_PDF", message: "This app cannot make a PDF here." } };
    }
    const key = ["doc", input.type, input.number, input.date, input.buyerInn].join("|");
    const known = chat.didoxDrafts?.find((d) => d.key === key);
    if (known) return { early: { ok: true, data: { status: "already_exists", draftId: known.id } } };
    const failure = (e: unknown): ToolResult => {
      if (e instanceof DidoxError || e instanceof EImzoError)
        return { ok: false, code: e.code, message: e.message };
      return { ok: false, code: "DIDOX_FAILED", message: e instanceof Error ? e.message : String(e) };
    };
    // Acts, contracts, invoices for payment ... exist in 1C first; the Didox document is made from that one.
    const fromOnec = input.type !== "letter" && input.type !== "other";
    const checked = await this.checkOnecSource(
      chat.companyId,
      input.onec,
      {
        number: input.number,
        date: input.date,
        posted: false,
        what: "the saved document in 1C this is made from",
        text: input.text,
      },
      fromOnec,
    );
    if ("error" in checked) return { early: checked.error };
    if (checked.problems.length > 0)
      return { early: { ok: true, data: { status: "needs_attention", problems: checked.problems } } };
    let prepared: Awaited<ReturnType<typeof prepareDocumentDraft>>;
    try {
      prepared = await prepareDocumentDraft(
        client,
        {
          type: input.type,
          number: input.number,
          date: input.date,
          buyerTin: input.buyerInn,
          contract: input.contract,
          subject: input.subject,
          text: input.text,
          signer: input.signer,
        },
        this.deps.store.company(chat.companyId).inn,
        this.deps.renderPdf,
      );
    } catch (e) {
      return { early: failure(e) };
    }
    if (!prepared.ok)
      return { early: { ok: true, data: { status: "needs_attention", problems: prepared.problems } } };
    const { body, preview } = prepared;
    return {
      proposal: { kind: "didox_document", document: preview },
      create: async () => {
        try {
          const id = await createDraft(client, body, DOCUMENT_DOCTYPE);
          chat.didoxDrafts = [...(chat.didoxDrafts ?? []), { key, id }];
          this.save(chat);
          return { ok: true, data: { id } };
        } catch (e) {
          return failure(e);
        }
      },
    };
  }

  /**
   * An invoice for Didox: the parties and units are read from Didox (E-IMZO may ask for the key's password
   * the first time), the card shows the sums the app worked out, and a confirmation makes a DRAFT there.
   */
  private async prepareDidoxDraft(
    chat: StoredChat,
    input: DidoxDraftInput,
  ): Promise<{ early: ToolResult } | { proposal: Proposal; create: () => Promise<ToolResult> }> {
    const client = this.didoxClient(chat.companyId);
    if (!client) {
      return {
        early: {
          ok: false,
          code: "NO_DIDOX_CONNECTION",
          message:
            "Didox is not connected for this company. Ask the accountant to open Companies, press the Didox " +
            "test button, run the test, choose the signature key and press Save for this company.",
        },
      };
    }
    const key = [input.number, input.date, input.buyerInn].join("|");
    const known = chat.didoxDrafts?.find((d) => d.key === key);
    if (known) return { early: { ok: true, data: { status: "already_exists", draftId: known.id } } };
    const failure = (e: unknown): ToolResult => {
      if (e instanceof DidoxError || e instanceof EImzoError)
        return { ok: false, code: e.code, message: e.message };
      return { ok: false, code: "DIDOX_FAILED", message: e instanceof Error ? e.message : String(e) };
    };
    // The invoice is applied (and posted) in 1C first; the draft is made from that document.
    const checked = await this.checkOnecSource(chat.companyId, input.onec, {
      number: input.number,
      date: input.date,
      posted: true,
      what: "the posted issued invoice (Документ.СчетФактураВыданный)",
    });
    if ("error" in checked) return { early: checked.error };
    if (checked.problems.length > 0)
      return { early: { ok: true, data: { status: "needs_attention", problems: checked.problems } } };
    let prepared: Awaited<ReturnType<typeof prepareDraft>>;
    try {
      prepared = await prepareDraft(
        client,
        {
          number: input.number,
          date: input.date,
          buyerTin: input.buyerInn,
          contract: input.contract,
          lines: input.lines,
        },
        this.deps.store.company(chat.companyId).inn,
      );
    } catch (e) {
      return { early: failure(e) };
    }
    if (!prepared.ok)
      return { early: { ok: true, data: { status: "needs_attention", problems: prepared.problems } } };
    const { body, preview } = prepared;
    return {
      proposal: { kind: "didox_draft", draft: preview },
      create: async () => {
        try {
          const id = await createDraft(client, body);
          chat.didoxDrafts = [...(chat.didoxDrafts ?? []), { key, id }];
          this.save(chat);
          return { ok: true, data: { id } };
        } catch (e) {
          return failure(e);
        }
      },
    };
  }

  /**
   * The items of a batch card, each checked by 1C first (the ones it refuses are shown and left
   * out), with how to write each once the accountant confirms: documents and directory items,
   * issued invoices for many sales, or many suppliers' invoices.
   */
  private async prepareBatch(
    chatCompanyId: string,
    chatId: string,
    tool: "propose_changes" | "propose_invoices_issued" | "propose_invoices_received",
    input: unknown,
    connection: ReturnType<LocalStore["connection"]>,
    signal: AbortSignal,
    origins?: DidoxOrigin[],
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
        const change = this.unpostedIfImport(chatCompanyId, item.change);
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
      for (const [index, invoice] of (input as InvoicesReceivedInput).invoices.entries()) {
        const object = "Документ.ПоступлениеТоваровУслуг";
        const total = invoice.lines.reduce((sum, line) => sum + line.total, 0);
        // One id per invoice of a confirmed card, as for a single one. A Didox document keeps its own
        // id, so that the same document entered again is found by 1C and not made twice.
        const origin = origins?.[index];
        const externalId = origin?.externalId ?? `chat-${randomUUID()}`;
        entries.push({
          item: {
            action: "create",
            object,
            preview: draftPreview(object, `${invoice.number} · ${invoice.date}`, [
              ["Номер", invoice.number],
              [
                "Контрагент",
                origin?.counterparty ?? invoice.counterparty.inn ?? invoice.counterparty.ref ?? null,
              ],
              ["Сумма", Math.round(total * 100) / 100],
            ]),
            error: null,
          },
          apply: async () =>
            createdState(
              object,
              await this.deps.connector.tool(connection, "createInvoiceReceived", {
                ...invoice,
                source: origin ? "didox" : "manual",
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

  /**
   * Invoices from the Didox documents read from the attached files. The program looks the
   * counterparties, contracts and items up in 1C; what is certain goes on one card, and the model
   * is told only what it must settle, with candidates: it answers with references and calls again.
   */
  /**
   * How the lines are written: what the accountant decided before (kept for the company) with what they decided in this
   * call on top. A decision made here is kept at once, so the next job applies it without being told.
   */
  private lineRules(companyId: string, input: DidoxInvoicesInput) {
    const fresh = {
      ...(input.vatRateMap?.length ? { vatRateMap: input.vatRateMap } : {}),
      ...(input.accounts ? { accounts: input.accounts } : {}),
      ...(input.accountRules?.length ? { accountRules: input.accountRules } : {}),
    };
    if (Object.keys(fresh).length > 0) {
      this.deps.store.mergeBookkeeping(companyId, fresh);
      for (const m of input.vatRateMap ?? [])
        this.deps.store.addRule(
          companyId,
          `Didox lines of ${m.from}% VAT are written under the base's ${m.to}% rate`,
        );
      if (input.accounts?.goods)
        this.deps.store.addRule(companyId, `Goods received are booked to account ${input.accounts.goods}`);
      if (input.accounts?.service)
        this.deps.store.addRule(
          companyId,
          `Services received are booked to account ${input.accounts.service}`,
        );
      for (const r of input.accountRules ?? [])
        this.deps.store.addRule(
          companyId,
          `Lines named like «${r.match}» are booked to account ${r.account}`,
        );
    }
    const held = this.deps.store.bookkeeping(companyId);
    return {
      ...(held.vatRateMap?.length
        ? { vatRateMap: Object.fromEntries(held.vatRateMap.map((m) => [m.from, m.to])) }
        : {}),
      ...(held.accounts ? { accounts: held.accounts } : {}),
      ...(held.accountRules?.length ? { accountRules: held.accountRules } : {}),
    };
  }

  private async proposeDidox(
    chat: StoredChat,
    input: DidoxInvoicesInput,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    // A period: the documents are read from Didox here, in the same step, instead of by a step of the model first.
    if (input.from || input.to) {
      emit({
        type: "tool",
        name: "fetch_didox_documents",
        detail: `${input.from ?? "…"} – ${input.to ?? "…"}`,
      });
      const got = await this.fetchDidox(
        chat,
        {
          ...(input.from ? { from: input.from } : {}),
          ...(input.to ? { to: input.to } : {}),
          direction: "incoming",
          limit: 300,
        },
        signal,
      );
      if (!got.ok) return got;
    }
    const read = chat.didox ?? [];
    if (read.length === 0) {
      return {
        ok: false,
        code: "NO_DIDOX",
        message:
          "No Didox documents were read from the files attached to this chat. Attach the Didox archive (or its JSON files), or enter the invoices with propose_invoices_received.",
      };
    }
    emit({ type: "tool", name: "propose_didox_invoices", detail: describe("propose_didox_invoices", input) });
    const done = new Set(chat.didoxDone ?? []);
    const wanted = input.documents ? new Set(input.documents) : null;
    const all = batchOf(read).postable;
    // An invoice becomes a receipt and its received invoice; an act without an invoice, a receipt of services only.
    const postable = all.filter((d) => d.kind === "invoice" || d.kind === "act");
    const unknown = (input.documents ?? []).filter((key) => !postable.some((d) => didoxKey(d) === key));
    const docs = postable.filter(
      (d) =>
        (!wanted || wanted.has(didoxKey(d))) &&
        !done.has(didoxKey(d)) &&
        (!input.from || d.date >= input.from) &&
        (!input.to || d.date <= input.to),
    );
    if (docs.length === 0) {
      return {
        ok: true,
        data: {
          status: done.size > 0 ? "all_entered" : "nothing_to_enter",
          alreadyEntered: [...done],
          ...(unknown.length > 0 ? { unknownDocuments: unknown } : {}),
        },
      };
    }

    const connection = this.deps.store.connection(chat.companyId);
    const cache = this.resolverCache.get(chat.companyId) ?? {};
    this.resolverCache.set(chat.companyId, cache);
    const resolved = await resolveDocuments(
      docs,
      {
        companyInn: this.deps.store.company(chat.companyId).inn,
        cache,
        overrides: {
          items: input.items,
          counterparties: input.counterparties,
          contracts: input.contracts,
        },
        rules: this.lineRules(chat.companyId, input),
      },
      {
        query: (query) => this.deps.connector.tool(connection, "run_query", query),
        describe: (objects) => this.deps.connector.tool(connection, "describe_objects", { objects }),
      },
    );
    if (signal.aborted) return { ok: false, code: "STOPPED", message: "Stopped by the user" };

    const attention = {
      needsAttention: summarizeProblems(resolved.problems),
      ...(unknown.length > 0 ? { unknownDocuments: unknown } : {}),
    };
    if (resolved.ready.length === 0) {
      return {
        ok: true,
        data: { status: "needs_attention", ...attention, next: DIDOX_NEXT },
      };
    }
    const result = await this.propose(
      chat,
      "propose_invoices_received",
      { title: input.title, invoices: resolved.ready.map((r) => r.draft) },
      emit,
      signal,
      resolved.ready.map(({ doc }) => ({
        externalId: doc.id || `${didoxKey(doc)}/${doc.date}`,
        counterparty: doc.seller.name,
      })),
    );
    if (!result.ok) return result;
    const data = result.data as { status?: string; applied?: { n: number }[] } | null;
    if (data?.status === "done" || data?.status === "already_exists") {
      const entered = new Set(chat.didoxDone ?? []);
      for (const { n } of data.applied ?? []) {
        const doc = resolved.ready[n - 1]?.doc;
        if (doc) entered.add(didoxKey(doc));
      }
      chat.didoxDone = [...entered];
      this.save(chat);
    }
    const hasAttention = resolved.problems.length > 0 || unknown.length > 0;
    return {
      ok: true,
      data: { ...(data ?? {}), ...(hasAttention ? { ...attention, next: DIDOX_NEXT } : {}) },
    };
  }

  /**
   * Payments of a bank statement read from the attached file. The program finds the bank account
   * and the counterparties and copies each counterparty's newest payment with this payment's date,
   * amount, number and purpose; what is certain goes on one card, and the model is told only what
   * it must settle.
   */
  private async proposeBank(
    chat: StoredChat,
    input: BankPaymentsInput,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const statements = chat.bank ?? [];
    const named = input.file
      ? statements.find((s) => s.fileName.toLowerCase() === input.file?.toLowerCase())
      : undefined;
    if (statements.length === 0 || (input.file && !named)) {
      return {
        ok: false,
        code: "NO_BANK_STATEMENT",
        message:
          statements.length === 0
            ? "No bank statement was read from the files attached to this chat. Attach the statement (Excel or CSV), or enter the payments with propose_changes."
            : `No statement "${input.file}". Read: ${statements.map((s) => s.fileName).join(", ")}`,
      };
    }
    // One statement by name, or every attached one in one run.
    const chosen = named ? [named] : statements;
    emit({ type: "tool", name: "propose_bank_payments", detail: describe("propose_bank_payments", input) });
    const done = new Set(chat.bankDone ?? []);
    const doneKey = (file: string, row: number) => `${file}#${row}`;
    const ownInn = this.deps.store.company(chat.companyId).inn;
    const ledgerOptions = { from: input.from, to: input.to, ownInn };
    // The accounts read together: what money only passes through, the bank's fees and the transfers between the
    // company's own accounts are the program's to sort out; the rest are payments.
    const plan = planLedger(statements, ledgerOptions);
    const tasks = chosen.flatMap((statement) => {
      const wanted = input.rows && named ? new Set(input.rows) : null;
      const rows = (plan.rows.get(statement.fileName) ?? []).filter(
        (row) => (!wanted || wanted.has(row)) && !done.has(doneKey(statement.fileName, row)),
      );
      if (rows.length === 0) return [];
      const fees = plan.fees.get(statement.fileName) ?? new Set<number>();
      // The bank's fee has no counterparty: the row is cleared of the company's own name and INN.
      const prepared: BankStatement =
        fees.size === 0
          ? statement
          : {
              ...statement,
              payments: statement.payments.map((p) => {
                if (!fees.has(p.row)) return p;
                // The bank wrote no INN for a fee: the zero-INN flag goes too, or it would be looked up by name.
                const rest: BankPayment = { ...p, inn: "", counterparty: "Bank fee" };
                delete rest.innZero;
                return rest;
              }),
            };
      return [{ statement, prepared, rows }];
    });
    const ledger = describeLedger(plan, ledgerOptions);
    // The accounts and the transfers set against how this company's 1C works (the policy is in the model's context).
    const learned = await this.policyOf(chat.companyId);
    const reflections = learned.policy ? reflectOnImport(learned.policy, plan) : [];

    const connection = this.deps.store.connection(chat.companyId);
    const run = (name: "run_query" | "describe_objects" | "get_object", args: unknown) =>
      this.deps.connector.tool(connection, name, args);
    const bankDeps = {
      query: (query: RunQueryInput) => run("run_query", query),
      describe: (objects: string[]) => run("describe_objects", { objects }),
      getObject: (object: string, ref: string) => run("get_object", { object, ref }),
    };
    const cache: BankCache = { lists: new Map(), snapshots: new Map() };
    // Money moved between the company's own accounts: a pair of documents copied from the company's own earlier ones.
    const moved = await resolveTransfers(
      plan.transfers,
      statements,
      { ownInn, cache, files: new Set(chosen.map((s) => s.fileName)), done },
      bankDeps,
    );
    if (signal.aborted) return { ok: false, code: "STOPPED", message: "Stopped by the user" };
    const notEntered = {
      ...notEnteredOf(plan, chosen, moved),
      ...(reflections.length > 0 ? { reflections } : {}),
    };
    if (tasks.length === 0 && moved.ready.length === 0) {
      return {
        ok: true,
        data: {
          status: done.size > 0 ? "all_entered" : "nothing_to_enter",
          ledger,
          ...notEntered,
          ...(moved.alreadyIn1c.length > 0 ? { transfersAlreadyIn1c: moved.alreadyIn1c.length } : {}),
        },
      };
    }
    const label = (s: BankStatement) => s.account || s.fileName;
    const several = tasks.length > 1;

    const fresh = new Set<string>();
    const madeNow: string[] = [];
    // What the model answered for a statement: its own file's, or any when it is the only one.
    const mine = <T extends { file?: string | undefined }>(statement: BankStatement, list: T[] | undefined) =>
      list?.filter((o) =>
        o.file ? o.file.toLowerCase() === statement.fileName.toLowerCase() : tasks.length === 1,
      );
    let results: { task: (typeof tasks)[number]; resolved: BankResolved }[];
    // A counterparty the statements name and 1C lacks is created first (one card), then its contract (one card),
    // then the payments: each round is looked up again, with no step of the model between.
    for (let round = 0; ; round++) {
      results = [];
      for (const task of tasks) {
        const counterparties = mine(task.statement, input.counterparties)?.map(({ row, ref }) => ({
          row,
          ref,
        }));
        const templates = mine(task.statement, input.templates)?.map(({ row, ref }) => ({ row, ref }));
        const resolved = await resolvePayments(
          task.prepared,
          {
            companyInn: ownInn,
            only: task.rows,
            cache,
            createMissing: true,
            fresh,
            ...(input.splitCommission === undefined ? {} : { splitCommission: input.splitCommission }),
            overrides: {
              ...(input.ownAccount && tasks.length === 1 ? { ownAccount: input.ownAccount } : {}),
              ...(counterparties?.length ? { counterparties } : {}),
              ...(templates?.length ? { templates } : {}),
            },
          },
          bankDeps,
        );
        if (signal.aborted) return { ok: false, code: "STOPPED", message: "Stopped by the user" };
        results.push({ task, resolved });
      }
      if (round >= 3) break;
      const missing = [
        ...new Map(results.flatMap((r) => r.resolved.missing).map((m) => [m.key, m])).values(),
      ];
      if (missing.length > 0) {
        const made = await this.proposeBatch(
          chat,
          {
            title: `${input.title}: ${missing.length} ta yangi kontragent`,
            changes: missing.map((m) => ({
              action: "create" as const,
              object: "Справочник.Контрагенты",
              fields: { ИНН: m.inn, Наименование: m.name, НаименованиеПолное: m.name },
            })),
          },
          emit,
          signal,
        );
        if (!made.ok) return made;
        const data = made.data as { status?: string; applied?: { n: number }[] } | null;
        if (data?.status !== "done") return made;
        const applied = (data.applied ?? []).flatMap(({ n }) => (missing[n - 1] ? [missing[n - 1]] : []));
        for (const m of applied) {
          if (m) {
            fresh.add(m.key);
            madeNow.push(
              m.key.startsWith("name:") ? `${m.name} (no INN in the statement)` : `${m.name} (INN ${m.inn})`,
            );
          }
        }
        if (applied.length === 0) break;
        continue;
      }
      const pending = [
        ...new Map(results.flatMap((r) => r.resolved.contractsToCreate).map((c) => [c.label, c])).values(),
      ];
      if (pending.length > 0) {
        const made = await this.proposeBatch(
          chat,
          {
            title: `${input.title}: ${pending.length} ta yangi shartnoma`,
            changes: pending.map((c) => ({
              action: "create" as const,
              object: "Справочник.ДоговорыКонтрагентов",
              fields: c.change.fields ?? {},
            })),
          },
          emit,
          signal,
        );
        if (!made.ok) return made;
        const data = made.data as { status?: string; applied?: { n: number }[] } | null;
        if (data?.status !== "done") return made;
        for (const { n } of data.applied ?? []) {
          const c = pending[n - 1];
          if (c) madeNow.push(`contract ${c.label}`);
        }
        if ((data.applied ?? []).length === 0) break;
        continue;
      }
      break;
    }
    if (signal.aborted) return { ok: false, code: "STOPPED", message: "Stopped by the user" };

    const where = (task: (typeof tasks)[number]) => (several ? ` [${label(task.statement)}]` : "");
    const ready = results.flatMap(({ task, resolved }) =>
      resolved.ready.map((item) => ({ ...item, file: task.statement.fileName })),
    );
    const problems = results.flatMap(({ task, resolved }) =>
      resolved.problems.map((p) => ({ ...p, file: task.statement.fileName, statement: task.statement })),
    );
    const notes = results.flatMap(({ task, resolved }) =>
      resolved.notes.map((n) => ({ rows: n.rows, message: `${n.message}${where(task)}` })),
    );
    const notCreated = results.flatMap(({ task, resolved }) => [
      ...resolved.missing.map(
        (m) =>
          `counterparty ${m.name} (${m.key.startsWith("name:") ? "no INN in the statement" : `INN ${m.inn}`}), rows ${m.rows.join(", ")}${where(task)}`,
      ),
      ...resolved.contractsToCreate.map(
        (c) => `contract ${c.label}, rows ${c.rows.join(", ")}${where(task)}`,
      ),
    ]);
    const alreadyIn1c = results.flatMap(({ resolved }) => resolved.alreadyIn1c);
    const attention = {
      ledger,
      ...notEntered,
      ...(madeNow.length > 0 ? { createdInThisRun: madeNow } : {}),
      ...(notCreated.length > 0 ? { notCreated } : {}),
      ...(problems.length > 0 ? { needsAttention: summarizeBankProblems(problems) } : {}),
      ...(notes.length > 0
        ? {
            notes: notes.slice(0, 20).map((n) => ({ rows: n.rows.slice(0, 20), message: n.message })),
            notesAbout:
              "Decided by the program, not blocking: mention these to the accountant in the final answer.",
          }
        : {}),
      ...(alreadyIn1c.length > 0
        ? { alreadyIn1c: { count: alreadyIn1c.length, rows: alreadyIn1c.slice(0, 50) } }
        : {}),
      ...(moved.ready.length > 0
        ? {
            transfersEntered: {
              documents: moved.ready.length,
              notes: moved.notes,
              about:
                "Each move between the company's own accounts is a document on each account's side, copied from the company's own earlier one: mention it to the accountant.",
            },
          }
        : {}),
      ...(moved.alreadyIn1c.length > 0 ? { transfersAlreadyIn1c: moved.alreadyIn1c.length } : {}),
    };
    if (ready.length === 0 && moved.ready.length === 0) {
      return { ok: true, data: { status: "needs_attention", ...attention, next: BANK_NEXT } };
    }
    // The payments, then the two legs of each move between the company's own accounts, on one card.
    const items = [
      ...ready.map((r) => ({ file: r.file, row: r.payment.row, change: r.change })),
      ...moved.ready.map((r) => ({ file: r.file, row: r.row, change: r.change })),
    ];
    const proposal = {
      title: input.title,
      changes: items.map(({ change }) => change),
    };
    const result = await this.proposeBatch(chat, proposal, emit, signal);
    if (!result.ok) return result;
    const data = result.data as { status?: string; applied?: { n: number }[] } | null;
    if (data?.status === "done") {
      const entered = new Set(chat.bankDone ?? []);
      for (const { n } of data.applied ?? []) {
        const item = items[n - 1];
        if (item) entered.add(doneKey(item.file, item.row));
      }
      chat.bankDone = [...entered];
      this.save(chat);
    }
    const hasAttention = problems.length > 0 || moved.problems.length > 0;
    return {
      ok: true,
      data: { ...(data ?? {}), ...attention, ...(hasAttention ? { next: BANK_NEXT } : {}) },
    };
  }

  /**
   * A batch of changes on one card that the app made itself. 1C's filling check is for the accountant to
   * see on the card, not for the model to chase: the first FILL_CHECK refusal is shown the second time.
   */
  private async proposeBatch(
    chat: StoredChat,
    proposal: ChangeBatchInput,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const first = await this.propose(chat, "propose_changes", proposal, emit, signal);
    if (!first.ok && first.code === "FILL_CHECK") {
      return this.propose(chat, "propose_changes", proposal, emit, signal);
    }
    return first;
  }

  /** A document this chat created and left unposted, so that "post them" needs no list from the model. */
  private noteCreated(chat: StoredChat, state: ObjectState): void {
    if (state.posted || !state.ref) return;
    const list = (chat.created ?? []).filter((d) => d.ref !== state.ref);
    list.push({ object: state.object, ref: state.ref, presentation: state.presentation });
    chat.created = list.slice(-1000);
  }

  /**
   * Posts what this chat created: one card with an update (post) per document, built here, not by
   * the model. 1C says which it cannot post (a closed period, a missing field) on the card.
   */
  private async proposePostCreated(
    chat: StoredChat,
    input: PostCreatedInput,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const kinds = input.objects ? new Set(input.objects.map((o) => o.toLowerCase())) : null;
    const list = (chat.created ?? []).filter((d) => !kinds || kinds.has(d.object.toLowerCase()));
    emit({ type: "tool", name: "propose_post_created", detail: describe("propose_post_created", input) });
    if (list.length === 0) {
      return {
        ok: true,
        data: {
          status: "nothing_to_post",
          note: "This chat has created no unposted documents. A document made in another chat is posted with propose_changes (update, post: true).",
        },
      };
    }
    const proposal = {
      title: input.title,
      changes: list.map((d) => ({ action: "update" as const, object: d.object, ref: d.ref, post: true })),
    };
    const result = await this.proposeBatch(chat, proposal, emit, signal);
    if (!result.ok) return result;
    const data = result.data as { status?: string; applied?: { n: number; object: ObjectState }[] } | null;
    if (data?.status === "done") {
      const posted = new Set(
        (data.applied ?? []).filter((a) => a.object.posted).map((a) => list[a.n - 1]?.ref),
      );
      chat.created = (chat.created ?? []).filter((d) => !posted.has(d.ref));
      this.save(chat);
    }
    return { ok: true, data: { ...(data ?? {}), notPostedYet: (chat.created ?? []).length } };
  }

  /** A document created from files is saved unposted (the accountant posts it after checking), not as the model asked. */
  private unpostedIfImport(companyId: string, change: ChangeInput): ChangeInput {
    if (!this.unposted.has(companyId) || change.action !== "create" || !change.post) return change;
    return { ...change, post: false };
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

/** The ids of the tool calls in the last message when it is the model's and nobody answered them. */
function unansweredCalls(messages: AiMessage[]): string[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || !Array.isArray(last.content)) return [];
  return last.content.flatMap((block) => {
    const use = AiToolUse.safeParse(block);
    return use.success ? [use.data.id] : [];
  });
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
  if (name === "propose_didox_invoices") {
    const batch = input as { title: string; documents?: string[] };
    return `${batch.documents ? `${batch.documents.length} · ` : ""}${batch.title}`;
  }
  if (name === "accounting_calc") return String((input as { op?: string }).op ?? "");
  if (name === "company_rules") return String((input as { action?: string }).action ?? "");
  if (name === "accounting_knowledge") return String((input as { query?: string }).query ?? "");
  if (name === "fetch_didox_documents") {
    const read = input as FetchDidoxInput;
    return `${read.from ?? "…"} – ${read.to ?? "…"}${read.direction ? ` · ${read.direction}` : ""}`;
  }
  if (name === "propose_didox_reconciliation") {
    const rec = input as { title: string };
    return rec.title;
  }
  if (name === "propose_didox_delete_draft") return String((input as { id: string }).id);
  if (name === "propose_didox_document") {
    const doc = input as { type: string; number: string; title: string };
    return `${doc.type} ${doc.number} · ${doc.title}`;
  }
  if (name === "propose_didox_draft") {
    const draft = input as { number: string; title: string };
    return `${draft.number} · ${draft.title}`;
  }
  if (name === "propose_post_created") {
    const batch = input as { title: string };
    return batch.title;
  }
  if (name === "propose_bank_payments") {
    const batch = input as { title: string; rows?: number[] };
    return `${batch.rows ? `${batch.rows.length} · ` : ""}${batch.title}`;
  }
  if (name === "propose_delete_marked") {
    const types = (input as { types?: string[] }).types;
    return types && types.length > 0 ? types.join(", ") : "*";
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
/** Where a received invoice of a card comes from, when it is a Didox document. */
interface DidoxOrigin {
  externalId: string;
  /** The supplier's name, for the card. */
  counterparty: string;
}

const DIDOX_NEXT =
  "Settle these (pick from the candidates, create what is missing with propose_changes, or ask the accountant) and call propose_didox_invoices again with items / counterparties / contracts (references only); documents already entered are not offered again.";

/** Reads of rows of a bank statement by hand that one question may make before it is sent to propose_bank_payments. */
const BANK_ROW_READS = 4;

const BANK_NEXT =
  "Settle these (find the counterparty in 1C by name, create what is missing with propose_changes, or ask the accountant) and call propose_bank_payments again with counterparties / templates / ownAccount (references and sheet rows only); payments already entered are not offered again.";

/** What the program did not enter, and why: the transfers it could not make, other currencies, the period. */
function notEnteredOf(plan: LedgerPlan, chosen: BankStatement[], moved: TransfersResolved) {
  const files = new Set(chosen.map((s) => s.fileName));
  const handled = new Set(moved.ready.map((r) => r.transfer));
  const settledLegs = new Set([...moved.ready, ...moved.alreadyIn1c].map((l) => `${l.file}#${l.row}`));
  const transfers = plan.transfers.filter(
    (t) =>
      [t.out, t.in].some((leg) => leg && files.has(leg.file)) &&
      !handled.has(t) &&
      ![t.out, t.in].some((leg) => leg && settledLegs.has(`${leg.file}#${leg.row}`)),
  );
  const foreign = plan.accounts.filter(
    (a) => a.role === "foreign_currency" && files.has(a.file) && a.inPeriod > 0,
  );
  const total = transfers.reduce((n, t) => n + t.amount, 0);
  const text = (tiyin: number) => (tiyin / 100).toFixed(2);
  return {
    ...(transfers.length > 0
      ? {
          transfersBetweenOwnAccounts: {
            count: transfers.length,
            total: text(total),
            conversion: transfers.filter((t) => t.kind === "conversion").length,
            withoutOtherLeg: transfers.filter((t) => !t.out || !t.in).length,
            examples: transfers.slice(0, 8).map((t) => ({
              date: t.date,
              amount: text(t.amount),
              from: t.fromAccount,
              to: t.toAccount,
              purpose: t.purpose.replace(/\s+/g, " ").slice(0, 80),
            })),
            why: [...new Set(moved.problems.map((p) => p.message))].slice(0, 5),
            note: "Not entered: the program could not make these documents (see why). Tell the accountant; they decide how these are booked.",
          },
        }
      : {}),
    ...(foreign.length > 0
      ? {
          foreignCurrencyAccounts: foreign.map((a) => ({
            account: a.account,
            currency: a.currency,
            paymentsInPeriod: a.inPeriod,
          })),
        }
      : {}),
    ...(plan.inPassThrough > 0 ? { passThroughRowsLeftOut: plan.inPassThrough } : {}),
    ...(plan.outsidePeriod > 0 ? { outsideThePeriod: plan.outsidePeriod } : {}),
  };
}

/** What the model is told of the bank problems: grouped by counterparty, the rows and candidates few. */
function summarizeBankProblems(problems: (BankProblem & { file?: string; statement?: BankStatement })[]) {
  const limit = 40;
  return {
    count: problems.length,
    problems: problems.slice(0, limit).map((p) => {
      // The rows as they stand in the statement, so that nothing has to be read to settle them.
      const shown = p.rows.slice(0, 6).flatMap((row) => {
        const payment = p.statement?.payments.find((x) => x.row === row);
        return payment
          ? [
              {
                row,
                date: payment.date,
                amount: (payment.amount / 100).toFixed(2),
                direction: payment.direction,
                name: payment.counterparty.slice(0, 60),
                ...(payment.inn ? { inn: payment.inn } : {}),
                purpose: payment.purpose.replace(/\s+/g, " ").slice(0, 110),
              },
            ]
          : [];
      });
      return {
        ...(p.file ? { file: p.file } : {}),
        rows: p.rows.slice(0, 20),
        ...(p.rows.length > 20 ? { moreRows: p.rows.length - 20 } : {}),
        code: p.code,
        ...(p.counterparty ? { counterparty: p.counterparty } : {}),
        message: p.message,
        ...(shown.length > 0 ? { examples: shown } : {}),
        ...(p.candidates ? { candidates: p.candidates.slice(0, 5) as BankCandidate[] } : {}),
      };
    }),
    ...(problems.length > limit ? { more: problems.length - limit } : {}),
  };
}

/** What the model is told of the problems: grouped by document, the candidates few, the list capped. */
function summarizeProblems(problems: Problem[]) {
  const limit = 40;
  return {
    count: problems.length,
    problems: problems.slice(0, limit).map((p) => ({
      document: p.document,
      ...(p.line ? { line: p.line } : {}),
      code: p.code,
      message: p.message,
      ...(p.candidates ? { candidates: p.candidates.slice(0, 5) } : {}),
    })),
    ...(problems.length > limit ? { more: problems.length - limit } : {}),
  };
}

/** The documents read now replace those of the same key read before. */
function mergeBank(before: BankStatement[], added: BankStatement[]): BankStatement[] {
  const map = new Map(before.map((s) => [s.fileName.toLowerCase(), s]));
  for (const s of added) map.set(s.fileName.toLowerCase(), s);
  return [...map.values()];
}

function mergeDidox(before: DidoxDocument[], added: DidoxDocument[]): DidoxDocument[] {
  const key = (d: DidoxDocument) => `${d.kind}|${didoxKey(d)}`;
  const map = new Map(before.map((d) => [key(d), d]));
  for (const d of added) map.set(key(d), d);
  return [...map.values()];
}

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
      presentation:
        `${document.number} · ${document.date.slice(0, 10)}${document.duplicate ? " (already existed)" : ""}` +
        (document.invoice ? `; received invoice ${document.invoice.number} made, unposted` : "") +
        (document.invoiceError ? `; received invoice NOT made: ${document.invoiceError}` : ""),
      posted: false,
      deletionMark: false,
      version: "",
    },
  };
}
