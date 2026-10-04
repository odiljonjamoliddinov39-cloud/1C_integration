/**
 * The AI assistant's loop (TD §7, phase 1, read-only). Each model turn goes through the control
 * system's AI proxy; the tools it asks for run here, against the company's 1C, and only their
 * results go back. The conversation lives in memory and is sent back unchanged every turn
 * (thinking blocks included, as the API requires).
 */
import { AI_TOOLS, type AiContentBlock, type AiMessage, AiToolUse, isAiToolName } from "@platform/shared";

import type { AssistantEvent, AssistantInput, Result } from "../shared/ipc.js";
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
          { company: company.name, messages: history },
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
            : await this.runTool(companyId, use, emit);
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

  reset(companyId: string): void {
    this.stop(companyId);
    this.conversations.delete(companyId);
  }

  private async runTool(companyId: string, use: AiToolUse, emit: Emit): Promise<ToolResult> {
    if (!isAiToolName(use.name)) return { ok: false, code: "UNKNOWN_TOOL", message: `No tool ${use.name}` };
    const input = AI_TOOLS[use.name].safeParse(use.input);
    if (!input.success) {
      return { ok: false, code: "VALIDATION", message: input.error.issues.map((i) => i.message).join("; ") };
    }
    emit({ type: "tool", name: use.name, detail: describe(use.name, input.data) });
    return this.deps.connector.tool(this.deps.store.connection(companyId), use.name, input.data);
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
  return "";
}
