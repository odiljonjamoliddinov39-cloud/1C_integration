/**
 * The AI assistant's loop (TD §7). Each model turn goes through the control system's AI proxy; the
 * tools it asks for run here, against the company's 1C, and only their results go back. The
 * conversation lives in memory and is sent back unchanged every turn (thinking blocks included, as
 * the API requires).
 *
 * Reads run at once. A document the assistant prepares (propose_* tools) is shown to the user as a
 * card and the loop waits: only the user's click writes it to 1C, unposted, and the model is told
 * what happened. Nothing is written while the license is read-only.
 */
import { randomUUID } from "node:crypto";

import {
  AI_TOOLS,
  type AiContentBlock,
  type AiMessage,
  type AiProposalTool,
  AiToolUse,
  type ChangeInput,
  type ChangePreview,
  type CreateInvoiceResult,
  type InvoiceIssuedPreview,
  type InvoiceReceivedDraft,
  type ObjectState,
  isAiToolName,
  isProposalTool,
} from "@platform/shared";

import type { AssistantEvent, AssistantInput, Proposal, ProposalOutcome, Result } from "../shared/ipc.js";
import type { ConnectorRunner } from "./connector.js";
import { ControlError } from "./control-client.js";
import type { ToolResult } from "./onec-jobs.js";
import type { SessionService } from "./session.js";
import type { LocalStore } from "./store.js";

/** Model turns per question: enough to look up metadata, fix a query and answer. */
const MAX_TURNS = 10;
/** Tool results are cut to this many characters before they go to the model. */
const MAX_RESULT_CHARS = 40_000;

export interface AssistantDeps {
  store: LocalStore;
  session: SessionService;
  connector: ConnectorRunner;
  emit: (event: AssistantEvent) => void;
}

type Emit = (event: DistributiveOmit<AssistantEvent, "companyId">) => void;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class AssistantService {
  private readonly conversations = new Map<string, AiMessage[]>();
  private readonly running = new Map<string, AbortController>();
  /** Per company: the card waiting for the user's answer. */
  private readonly waiting = new Map<string, { id: string; answer: (approve: boolean) => void }>();

  constructor(private readonly deps: AssistantDeps) {}

  async send({ companyId, text }: AssistantInput): Promise<Result<null>> {
    const emit: Emit = (event) => this.deps.emit({ companyId, ...event } as AssistantEvent);
    const company = this.deps.store.company(companyId);
    if (!company.aiEnabled)
      return this.fail(emit, "AI_DISABLED", "Turn the assistant on for this company first");
    if (this.running.has(companyId)) return this.fail(emit, "BUSY", "The assistant is still answering");

    const abort = new AbortController();
    this.running.set(companyId, abort);
    const history = this.conversations.get(companyId) ?? [];
    this.conversations.set(companyId, history);
    history.push({ role: "user", content: text });
    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const { client, accessToken } = await this.deps.session.authorized();
        const answer = await client.aiTurn(
          accessToken,
          { company: company.name, tools: Object.keys(AI_TOOLS), messages: history },
          (delta) => emit({ type: "text", text: delta }),
          abort.signal,
        );
        history.push({ role: "assistant", content: answer.content });

        const toolUses = answer.content.flatMap((block) => {
          const use = AiToolUse.safeParse(block);
          return use.success ? [use.data] : [];
        });
        if (answer.stopReason !== "tool_use" || toolUses.length === 0) {
          // A turn cut off by max_tokens or a refusal may hold a tool call that must not run (its
          // input can be incomplete); it still needs a result, or the next question is rejected.
          if (toolUses.length > 0) {
            const notRun = { ok: false, code: "NOT_RUN", message: "The turn was cut off" } as const;
            history.push({ role: "user", content: toolUses.map((use) => toToolResult(use.id, notRun)) });
          }
          if (answer.stopReason === "refusal") {
            return this.fail(emit, "AI_REFUSED", "The assistant declined to answer this question");
          }
          if (answer.stopReason === "max_tokens") {
            return this.fail(emit, "AI_TRUNCATED", "The answer was too long and was cut off");
          }
          emit({ type: "done" });
          return { ok: true, data: null };
        }
        // Every tool_use gets a tool_result, even when stopped, so the conversation stays valid.
        const results: AiContentBlock[] = [];
        for (const use of toolUses) {
          const result = abort.signal.aborted
            ? ({ ok: false, code: "STOPPED", message: "Stopped by the user" } as const)
            : await this.runTool(companyId, use, emit, abort.signal);
          results.push(toToolResult(use.id, result));
        }
        history.push({ role: "user", content: results });
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
      this.running.delete(companyId);
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

  reset(companyId: string): void {
    this.stop(companyId);
    this.conversations.delete(companyId);
  }

  private async runTool(
    companyId: string,
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
    if (isProposalTool(use.name)) return this.propose(companyId, use.name, input.data, emit, signal);
    emit({ type: "tool", name: use.name, detail: describe(use.name, input.data) });
    return this.deps.connector.tool(this.deps.store.connection(companyId), use.name, input.data);
  }

  /**
   * Shows the prepared document and waits for the user. Approved: written to 1C, unposted. The
   * result tells the model what the user decided, so it never claims a document it did not create.
   */
  private async propose(
    companyId: string,
    tool: AiProposalTool,
    input: unknown,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<ToolResult> {
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
    if (tool === "propose_change") {
      const change = input as ChangeInput;
      emit({ type: "tool", name: tool, detail: describe(tool, change) });
      const preview = await this.deps.connector.tool(connection, "previewChange", change);
      if (!preview.ok) return preview;
      const shown = preview.data as ChangePreview;
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
    if (proposal.kind === "change") {
      const state = result.data as ObjectState;
      decided({ status: "applied", state });
      return { ok: true, data: { status: "done", action: proposal.preview.action, object: state } };
    }
    const document = result.data as CreateInvoiceResult;
    decided({ status: "created", document });
    return { ok: true, data: { status: document.duplicate ? "already_exists" : "created", document } };
  }

  private fail(emit: Emit, code: string, message: string): Result<null> {
    emit({ type: "error", code, message });
    return { ok: false, code, message };
  }
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
