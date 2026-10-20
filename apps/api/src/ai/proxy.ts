/**
 * AI proxy (TD §8): checks the subscription and the token quota, adds the system prompt and the
 * tools, calls Claude with our key, streams the answer back and records the tokens per account.
 * The API key never reaches the desktop app.
 */
import { createHash } from "node:crypto";

import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import {
  AI_PROPOSAL_TOOLS,
  type AiChatInput,
  type AiEvent,
  type AiPolicy,
  LEGACY_AI_TOOLS,
} from "@platform/shared";

import type { Config } from "../config.js";
import { eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { appSettings } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import type { BillingService } from "../billing/service.js";
import type { Service } from "../service.js";
import { type Admission, checkBudget } from "./budget.js";
import { latestDigest } from "./digest.js";
import { loopGuard, loopNote } from "./loop.js";
import { type AiModel, type TurnTiming, usageOf } from "./model.js";
import { policyFor } from "./policy.js";
import { SYSTEM_PROMPT, TOOLS, contextBlock, digestBlock, policyBlock } from "./prompt.js";
import { routeModel, withoutThinking } from "./router.js";
import { type ModelChoice, aiChoiceFor } from "./settings.js";
import { AI_ALERT_KEY } from "./alert.js";
import { isFirstStep, logUsage, questionOf, questionStart } from "./usage.js";

/** A chat larger than this has its older 1C results cleared, keeping the latest few. */
const CLEAR_FROM_TOKENS = 40_000;
const KEEP_TOOL_USES = 6;
/** Clearing rewrites the cached prompt from that point, so only when it saves a good amount. */
const CLEAR_AT_LEAST_TOKENS = 10_000;
/**
 * A chat larger than policy.compactionThreshold is summarized by the API (the model's limit is 1M
 * tokens): the older part becomes a summary at the start of the answer, and later steps continue
 * from it. What an accountant cannot lose is kept word for word.
 */
const COMPACT_INSTRUCTIONS =
  "Summarize for an accounting assistant that will continue this work. Keep every number, amount, " +
  "date, period, document reference (type, number, date), account code, counterparty and " +
  "organization name exactly as written: never round, convert or paraphrase them. Keep what the " +
  "user asked, what was proposed and what the user approved or declined, what was created in 1C " +
  "(with its reference), and what is still open. Drop raw query output, tool chatter and reasoning.";
const CLEARING_BETA = "context-management-2025-06-27";
const COMPACTION_BETA = "compact-2026-01-12";

/** What the API says when a chat no longer fits the model. */
const TOO_LONG = /prompt is too long|too many (input )?tokens|context (window|length)/i;

/** The same for every step of one question: who, which company, and the question itself. */
function questionKey(userId: string, input: AiChatInput): string {
  const start = questionStart(input.messages);
  return createHash("sha256")
    .update(`${userId}|${input.company}|${start}|${questionOf(input.messages) ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

export class AiProxy {
  /** Each is off after the API refused it once, until the server restarts. */
  private clearing = true;
  private compaction = true;
  constructor(
    private readonly db: Db,
    private readonly service: Service,
    private readonly billingService: BillingService,
    private readonly config: Config,
    private readonly model: AiModel | null,
    private readonly log: { error: (obj: unknown, msg?: string) => void },
  ) {}

  /**
   * Throws when this account may not use the AI now; otherwise the policy it runs under and the
   * warnings to show (the budget is close).
   */
  async ensureAllowed(accountId: string, userId: string, input?: AiChatInput): Promise<Admission> {
    if (!this.model)
      throw new HttpError(503, "AI_NOT_CONFIGURED", "The AI assistant is not set up on the server");
    if (await this.service.isBlocked(accountId))
      throw new HttpError(403, "ACCOUNT_BLOCKED", "This account is blocked");
    const { subscription, effectivePlan } = await this.service.billing.get(accountId);
    // Only an admin can suspend an account; an unpaid one is on Free and keeps its free questions.
    if (subscription.status === "suspended" || subscription.status === "cancelled") {
      throw new HttpError(402, "SUBSCRIPTION_INACTIVE", "This subscription is suspended: contact support");
    }
    const policy = await policyFor(this.db, effectivePlan.id);
    const admission = await checkBudget(this.db, policy, { accountId, userId });
    if (this.config.PLAN_LIMITS === "off") return admission;
    // The plan's allowance is in questions: counted when a new one reaches the model (the first
    // step of an answer, not an audit), so the answer in progress is never cut.
    const audit = input?.tools?.includes("report_findings") ?? false;
    if (input && !audit && isFirstStep(input.messages)) {
      const warning = await this.billingService.takeAiQuestion(accountId, questionKey(userId, input));
      if (warning) admission.warnings.push(warning);
    }
    return admission;
  }

  /** Set while the provider is refusing us (its credit ran out): shown on the admin overview. */
  /** undefined: not known since start-up (an alert may be left from before), so the first success clears it. */
  private alert: string | null | undefined = undefined;

  private async raiseAlert(code: string, message: string): Promise<void> {
    // The customer sees a plain "unavailable"; this is for us, to be fixed at the provider.
    this.log.error({ code, message }, "The AI provider refused our requests: fix it at the provider");
    if (this.alert === code) return;
    this.alert = code;
    const value = { code, message: message.slice(0, 500), at: new Date().toISOString() };
    await this.db
      .insert(appSettings)
      .values({ key: AI_ALERT_KEY, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } })
      .catch(() => undefined);
  }

  private async clearAlert(): Promise<void> {
    this.alert = null;
    await this.db
      .delete(appSettings)
      .where(eq(appSettings.key, AI_ALERT_KEY))
      .catch(() => undefined);
  }

  /** One model turn, written to `send` as events. Never throws: failures become an error event. */
  async turn(
    who: { accountId: string; userId: string },
    input: AiChatInput,
    send: (event: AiEvent) => void,
    signal: AbortSignal,
    admission: Admission,
  ): Promise<void> {
    if (!this.model)
      return send({ type: "error", code: "AI_NOT_CONFIGURED", message: "No AI on the server" });
    const { policy } = admission;
    for (const warning of admission.warnings) send({ type: "warning", ...warning });
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
    const routed = routeModel(choice, policy, input, audit, this.config.AI_IMPORT_EFFORT);
    const loop = loopGuard(policy, input.messages, audit);
    const digest = await latestDigest(this.db, who.accountId, input.company).catch(() => null);
    const today = new Date().toISOString().slice(0, 10);
    const params: BetaMessageStreamParams = {
      model: routed.model,
      max_tokens: policy.maxOutputTokens,
      // Prompt order, most stable first so the cache holds: tools, instructions, the company's
      // structure (digest), today's context, then the chat.
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        ...(digest
          ? [
              {
                type: "text" as const,
                text: digestBlock(digest.digest),
                cache_control: { type: "ephemeral" as const },
              },
            ]
          : []),
        ...(input.policy
          ? [
              {
                type: "text" as const,
                text: policyBlock(input.policy),
                cache_control: { type: "ephemeral" as const },
              },
            ]
          : []),
        {
          type: "text",
          text:
            contextBlock(input.company, today, canChange, audit, input.kind === "import") +
            (loop.capped ? `\n\n${loopNote(loop.calls)}` : ""),
        },
      ],
      tools,
      // The desktop keeps the conversation and sends it back unchanged, thinking blocks included.
      messages: (routed.simple ? withoutThinking(input.messages) : input.messages) as BetaMessageParam[],
      ...(loop.capped ? { tool_choice: { type: "none" as const } } : {}),
      cache_control: { type: "ephemeral" },
      // The simple-task model takes neither effort nor adaptive thinking.
      ...(routed.simple
        ? { betas: [] }
        : {
            // On a policy decline, the API retries on a fallback model it picks by refusal category.
            // "updates": thinking blocks carry the model's short progress notes, which the app shows.
            betas: ["server-side-fallback-2026-07-01", "thinking-display-updates-2026-08-18"],
            fallbacks: "default" as const,
            thinking: { type: "adaptive" as const, display: "updates" as const },
            ...(routed.effort ? { output_config: { effort: routed.effort } } : {}),
          }),
    };
    let timing: TurnTiming | null = null;
    const handlers = {
      onText: (text: string) => send({ type: "text", text }),
      onProgress: (text: string) => send({ type: "progress", text }),
      onTiming: (t: TurnTiming) => {
        timing = t;
      },
    };
    let message;
    try {
      // Saving tokens must never cost an answer: a setting the API refuses is dropped, the turn
      // runs again without it, and later turns do too.
      for (;;) {
        try {
          message = await this.model.turn(
            this.withContextManagement(params, policy, routed.simple),
            handlers,
            signal,
          );
          break;
        } catch (error) {
          const refused = error instanceof Anthropic.BadRequestError ? error.message : "";
          if (!/compact|context.?management|clear_tool_uses/i.test(refused) || TOO_LONG.test(refused)) {
            throw error;
          }
          if (this.compaction && (/compact/i.test(refused) || !this.clearing)) {
            this.log.error(error, "Compaction refused; turning it off");
            this.compaction = false;
          } else if (this.clearing) {
            this.log.error(error, "Context editing refused; turning it off");
            this.clearing = false;
          } else {
            throw error;
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Anthropic.AnthropicError)) this.log.error(error, "AI turn failed");
      if (isProviderBilling(error)) await this.raiseAlert("AI_PROVIDER_BILLING", errorText(error));
      // A question that never got an answer is not charged: give back the one taken for it.
      if (!audit && isFirstStep(input.messages) && !(error instanceof Anthropic.APIUserAbortError)) {
        await this.billingService
          .refundAiQuestion(who.accountId, questionKey(who.userId, input))
          .catch((e: unknown) => this.log.error(e, "AI question was not refunded"));
      }
      return send(toErrorEvent(error));
    }
    if (this.alert !== null) await this.clearAlert();
    send({
      type: "message",
      content: message.content as unknown as Extract<AiEvent, { type: "message" }>["content"],
      stopReason: message.stop_reason,
    });
    await logUsage(
      this.db,
      {
        ...who,
        company: input.company,
        feature: audit ? "audit" : "chat",
        route: "model",
        toolCalls: message.content.filter((block) => block.type === "tool_use").length,
        firstStep: isFirstStep(input.messages),
        question: questionOf(input.messages),
        ...(timing
          ? {
              durationMs: (timing as TurnTiming).durationMs,
              firstTokenMs: (timing as TurnTiming).firstTokenMs,
              attempts: (timing as TurnTiming).attempts,
              rateLimited: (timing as TurnTiming).rateLimited,
            }
          : {}),
      },
      usageOf(message),
    ).catch((error: unknown) => this.log.error(error, "AI usage was not recorded"));
    // A heavy job is worth more than one question: charge what it has cost so far.
    if (!audit) {
      await this.billingService
        .chargeAiCost(who.accountId, questionKey(who.userId, input), usageOf(message).costUsd)
        .catch((error: unknown) => this.log.error(error, "AI question cost was not charged"));
    }
  }

  /**
   * A long chat would send every old 1C result again on every step, and could outgrow the model:
   * once it is large the API clears all but the latest results (the model reads 1C again if it
   * needs one; what was proposed and decided is kept), and past COMPACT_FROM_TOKENS it summarizes
   * the older part. The desktop sends the answer back unchanged, the summary included.
   */
  private withContextManagement(
    base: BetaMessageStreamParams,
    policy: AiPolicy,
    simple: boolean,
  ): BetaMessageStreamParams {
    if (simple) return base;
    const edits: NonNullable<BetaMessageStreamParams["context_management"]>["edits"] = [];
    const betas = [...(base.betas ?? [])];
    if (this.clearing) {
      edits.push({
        type: "clear_tool_uses_20250919",
        trigger: { type: "input_tokens", value: CLEAR_FROM_TOKENS },
        keep: { type: "tool_uses", value: KEEP_TOOL_USES },
        clear_at_least: { type: "input_tokens", value: CLEAR_AT_LEAST_TOKENS },
        exclude_tools: [...AI_PROPOSAL_TOOLS, "report_findings"],
      });
      betas.push(CLEARING_BETA);
    }
    if (this.compaction) {
      edits.push({
        type: "compact_20260112",
        trigger: { type: "input_tokens", value: policy.compactionThreshold },
        instructions: COMPACT_INSTRUCTIONS,
      });
      betas.push(COMPACTION_BETA);
    }
    return edits.length > 0 ? { ...base, betas, context_management: { edits } } : base;
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

/** The provider's own words when the account behind our key has no credit (or a spend limit is hit). */
const PROVIDER_BILLING = /credit balance|purchase credits|plans\s*&\s*billing|spend limit|billing/i;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProviderBilling(error: unknown): boolean {
  return (
    (error instanceof Anthropic.BadRequestError ||
      error instanceof Anthropic.PermissionDeniedError ||
      error instanceof Anthropic.AuthenticationError) &&
    PROVIDER_BILLING.test(error.message)
  );
}

function toErrorEvent(error: unknown): AiEvent {
  if (isProviderBilling(error)) {
    return {
      type: "error",
      code: "AI_OUT_OF_SERVICE",
      message: "The AI service is temporarily unavailable. We are fixing it; try again later.",
    };
  }
  if (error instanceof Anthropic.APIUserAbortError) {
    return { type: "error", code: "AI_ABORTED", message: "Stopped" };
  }
  if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError) {
    return { type: "error", code: "AI_BUSY", message: "The AI service is busy, try again in a minute" };
  }
  if (error instanceof Anthropic.BadRequestError && TOO_LONG.test(error.message)) {
    return {
      type: "error",
      code: "CHAT_TOO_LONG",
      message: "This chat is too long for the AI; start a new chat",
    };
  }
  if (error instanceof Anthropic.BadRequestError) {
    return { type: "error", code: "AI_BAD_REQUEST", message: error.message };
  }
  if (error instanceof Anthropic.APIError) {
    return { type: "error", code: "AI_UNAVAILABLE", message: "The AI service is not available right now" };
  }
  return { type: "error", code: "INTERNAL", message: "Unexpected server error" };
}
