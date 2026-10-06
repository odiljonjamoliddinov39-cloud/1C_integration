/**
 * AI proxy (TD §8): checks the subscription and the token quota, adds the system prompt and the
 * tools, calls Claude with our key, streams the answer back and records the tokens per account.
 * The API key never reaches the desktop app.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import { AI_PROPOSAL_TOOLS, type AiChatInput, type AiEvent, LEGACY_AI_TOOLS } from "@platform/shared";

import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { aiUsage } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { type Service, effectiveStatus } from "../service.js";
import { type AiModel, usageOf } from "./model.js";
import { SYSTEM_PROMPT, TOOLS, contextBlock } from "./prompt.js";
import { aiLimits } from "./quota.js";
import { type ModelChoice, aiChoiceFor } from "./settings.js";

// The model's own maximum: a card for a whole bank statement is one long tool call, and a turn is
// never cut short by us. (A turn that still reaches it is continued by the app.)
const MAX_TOKENS = 128_000;
/** A chat larger than this has its older 1C results cleared, keeping the latest few. */
const CLEAR_FROM_TOKENS = 40_000;
const KEEP_TOOL_USES = 6;
/** Clearing rewrites the cached prompt from that point, so only when it saves a good amount. */
const CLEAR_AT_LEAST_TOKENS = 10_000;

export class AiProxy {
  /** Off after the API refused it once, until the server restarts. */
  private contextEditing = true;
  constructor(
    private readonly db: Db,
    private readonly service: Service,
    private readonly config: Config,
    private readonly model: AiModel | null,
    private readonly log: { error: (obj: unknown, msg?: string) => void },
  ) {}

  /** Throws when this account may not use the AI now. */
  async ensureAllowed(accountId: string): Promise<void> {
    if (!this.model)
      throw new HttpError(503, "AI_NOT_CONFIGURED", "The AI assistant is not set up on the server");
    if (await this.service.isBlocked(accountId))
      throw new HttpError(403, "ACCOUNT_BLOCKED", "This account is blocked");
    const { subscription, plan } = await this.service.currentSubscription(accountId);
    const status = effectiveStatus(subscription.status, subscription.endsAt);
    if (status === "suspended" || status === "cancelled") {
      throw new HttpError(402, "SUBSCRIPTION_INACTIVE", "Renew the subscription to use the assistant");
    }
    if (this.config.PLAN_LIMITS === "off") return;
    const limits = await aiLimits(
      this.db,
      accountId,
      { startsAt: subscription.startsAt, planQuota: plan.aiTokenQuota },
      this.config.AI_DAILY_TOKENS,
    );
    if (limits.usedToday >= limits.dailyLimit) {
      throw new HttpError(
        429,
        "AI_DAILY_LIMIT",
        "Today's assistant limit is used up; it resets at midnight UTC",
      );
    }
    if (limits.used >= limits.quota) {
      throw new HttpError(429, "AI_QUOTA_EXCEEDED", "The plan's assistant quota is used up");
    }
  }

  /** One model turn, written to `send` as events. Never throws: failures become an error event. */
  async turn(
    who: { accountId: string; userId: string },
    input: AiChatInput,
    send: (event: AiEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.model)
      return send({ type: "error", code: "AI_NOT_CONFIGURED", message: "No AI on the server" });
    // Only the tools this app version can run: an older app gets the read tools and is told to update.
    const offered = new Set<string>(input.tools ?? LEGACY_AI_TOOLS);
    const tools = TOOLS.filter((tool) => offered.has(tool.name));
    const canChange = AI_PROPOSAL_TOOLS.some((name) => offered.has(name));
    const audit = offered.has("report_findings");
    // The account's own model and effort, else the dashboard's, else the server's default.
    const choice: ModelChoice = await aiChoiceFor(this.db, this.config, who.accountId).catch(() => ({
      model: this.config.AI_MODEL,
      effort: this.config.AI_EFFORT,
    }));
    const params: BetaMessageStreamParams = {
      model: choice.model,
      max_tokens: MAX_TOKENS,
      // On a policy decline, the API retries on a fallback model it picks by refusal category.
      // "updates": thinking blocks carry the model's short progress notes, which the app shows.
      betas: [
        "server-side-fallback-2026-07-01",
        "thinking-display-updates-2026-08-18",
        "context-management-2025-06-27",
      ],
      fallbacks: "default",
      thinking: { type: "adaptive", display: "updates" },
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        {
          type: "text",
          text: contextBlock(input.company, new Date().toISOString().slice(0, 10), canChange, audit),
        },
      ],
      tools,
      // The desktop keeps the conversation and sends it back unchanged, thinking blocks included.
      messages: input.messages as BetaMessageParam[],
      output_config: { effort: choice.effort },
      // A long chat would send every old 1C result again on every step. Once the chat is large,
      // the API clears all but the latest results (the model reads 1C again if it needs one);
      // what was proposed and decided is kept.
      context_management: {
        edits: [
          {
            type: "clear_tool_uses_20250919",
            trigger: { type: "input_tokens", value: CLEAR_FROM_TOKENS },
            keep: { type: "tool_uses", value: KEEP_TOOL_USES },
            clear_at_least: { type: "input_tokens", value: CLEAR_AT_LEAST_TOKENS },
            exclude_tools: [...AI_PROPOSAL_TOOLS, "report_findings"],
          },
        ],
      },
      cache_control: { type: "ephemeral" },
    };
    const handlers = {
      onText: (text: string) => send({ type: "text", text }),
      onProgress: (text: string) => send({ type: "progress", text }),
    };
    if (!this.contextEditing) {
      delete params.context_management;
      params.betas = params.betas?.filter((beta) => beta !== "context-management-2025-06-27");
    }
    let message;
    try {
      try {
        message = await this.model.turn(params, handlers, signal);
      } catch (error) {
        // Clearing old results saves tokens but must never cost an answer: if the API refuses
        // it, the turn runs without it, and later turns do too.
        if (
          !(error instanceof Anthropic.BadRequestError) ||
          !/context.?management|clear_tool_uses/i.test(error.message) ||
          !params.context_management
        ) {
          throw error;
        }
        this.log.error(error, "Context editing refused; turning it off");
        this.contextEditing = false;
        delete params.context_management;
        params.betas = params.betas?.filter((beta) => beta !== "context-management-2025-06-27");
        message = await this.model.turn(params, handlers, signal);
      }
    } catch (error) {
      if (!(error instanceof Anthropic.AnthropicError)) this.log.error(error, "AI turn failed");
      return send(toErrorEvent(error));
    }
    send({
      type: "message",
      content: message.content as unknown as Extract<AiEvent, { type: "message" }>["content"],
      stopReason: message.stop_reason,
    });
    await this.record(who, usageOf(message)).catch((error: unknown) =>
      this.log.error(error, "AI usage was not recorded"),
    );
  }

  private async record(who: { accountId: string; userId: string }, usage: ReturnType<typeof usageOf>) {
    await this.db.insert(aiUsage).values({ accountId: who.accountId, userId: who.userId, ...usage });
  }
}

/**
 * Files come inline, as base64 or text, from the user's PC. A file id or a URL would let a request
 * reach files or addresses that are not this account's, so they are refused.
 */
export function assertInlineFiles(input: AiChatInput): void {
  const check = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks as { source?: { type?: unknown }; content?: unknown }[]) {
      if (block.source !== undefined && block.source.type !== "base64" && block.source.type !== "text") {
        throw new HttpError(400, "VALIDATION", "Files must be sent inline");
      }
      check(block.content); // tool results can hold blocks too
    }
  };
  for (const message of input.messages) check(message.content);
}

function toErrorEvent(error: unknown): AiEvent {
  if (error instanceof Anthropic.APIUserAbortError) {
    return { type: "error", code: "AI_ABORTED", message: "Stopped" };
  }
  if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError) {
    return { type: "error", code: "AI_BUSY", message: "The AI service is busy, try again in a minute" };
  }
  if (error instanceof Anthropic.BadRequestError) {
    return { type: "error", code: "AI_BAD_REQUEST", message: error.message };
  }
  if (error instanceof Anthropic.APIError) {
    return { type: "error", code: "AI_UNAVAILABLE", message: "The AI service is not available right now" };
  }
  return { type: "error", code: "INTERNAL", message: "Unexpected server error" };
}
