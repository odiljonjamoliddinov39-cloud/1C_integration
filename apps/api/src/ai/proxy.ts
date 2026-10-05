/**
 * AI proxy (TD §8): checks the subscription and the token quota, adds the system prompt and the
 * tools, calls Claude with our key, streams the answer back and records the tokens per account.
 * The API key never reaches the desktop app.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import { AI_PROPOSAL_TOOLS, type AiChatInput, type AiEvent, LEGACY_AI_TOOLS } from "@platform/shared";
import { and, eq, gte, sql } from "drizzle-orm";

import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { aiUsage } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { type Service, effectiveStatus } from "../service.js";
import { type AiModel, usageOf } from "./model.js";
import { SYSTEM_PROMPT, TOOLS, contextBlock } from "./prompt.js";

const MAX_TOKENS = 16_000;

export class AiProxy {
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
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    if ((await this.tokensSince(accountId, startOfDay)) >= this.config.AI_DAILY_TOKENS) {
      throw new HttpError(
        429,
        "AI_DAILY_LIMIT",
        "Today's assistant limit is used up; it resets at midnight UTC",
      );
    }
    if ((await this.tokensSince(accountId, subscription.startsAt)) >= plan.aiTokenQuota) {
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
    const params: BetaMessageStreamParams = {
      model: this.config.AI_MODEL,
      max_tokens: MAX_TOKENS,
      // On a policy decline, the API retries on a fallback model it picks by refusal category.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        { type: "text", text: contextBlock(input.company, new Date().toISOString().slice(0, 10), canChange) },
      ],
      tools,
      // The desktop keeps the conversation and sends it back unchanged, thinking blocks included.
      messages: input.messages as BetaMessageParam[],
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
    };
    let message;
    try {
      message = await this.model.turn(params, (text) => send({ type: "text", text }), signal);
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

  private async tokensSince(accountId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({
        total: sql<string>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens} + ${aiUsage.cacheReadTokens} + ${aiUsage.cacheWriteTokens}), 0)`,
      })
      .from(aiUsage)
      .where(and(eq(aiUsage.accountId, accountId), gte(aiUsage.createdAt, since)));
    return Number(row?.total ?? 0);
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
