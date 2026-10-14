/**
 * The one place that calls the Claude API. Tests replace it with a fake.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";

export interface TurnCallbacks {
  /** The answer text, as it is written. */
  onText: (text: string) => void;
  /** The model's short notes between tool calls ("checking September's payments…"), as written. */
  onProgress?: (text: string) => void;
  /** Called once with the turn's timing when it finished. */
  onTiming?: (timing: TurnTiming) => void;
}

/** What one turn cost in time: the whole call, the wait for its first word, and the API's retries. */
export interface TurnTiming {
  durationMs: number;
  firstTokenMs: number | null;
  /** Calls made to the API for this turn (more than 1: the SDK retried). */
  attempts: number;
  /** Of them, answered 429 (rate limited) and waited out. */
  rateLimited: number;
}

export interface AiModel {
  /** Streams one turn through the callbacks; the finished message is returned. */
  turn(params: BetaMessageStreamParams, callbacks: TurnCallbacks, signal: AbortSignal): Promise<BetaMessage>;
}

/** Counts what the SDK does behind one turn: its calls and the 429s it waited out. */
const calls = new AsyncLocalStorage<{ attempts: number; rateLimited: number }>();

export function claudeModel(apiKey: string): AiModel {
  const client = new Anthropic({
    apiKey,
    fetch: async (input, init) => {
      const store = calls.getStore();
      if (store) store.attempts += 1;
      const response = await fetch(input, init);
      if (store && response.status === 429) store.rateLimited += 1;
      return response;
    },
  });
  return {
    async turn(params, { onText, onProgress, onTiming }, signal) {
      const started = Date.now();
      const counts = { attempts: 0, rateLimited: 0 };
      let firstTokenMs: number | null = null;
      return calls.run(counts, async () => {
        const stream = client.beta.messages.stream(params, { signal });
        stream.on("text", (delta) => {
          firstTokenMs ??= Date.now() - started;
          onText(delta);
        });
        // With display "updates", thinking blocks carry only the model's progress notes; a new note
        // starts on a new line.
        if (onProgress) {
          let wrote = false;
          stream.on("streamEvent", (event) => {
            if (wrote && event.type === "content_block_start" && event.content_block.type === "thinking") {
              onProgress("\n");
            }
          });
          stream.on("thinking", (delta) => {
            if (delta) wrote = true;
            onProgress(delta);
          });
        }
        const message = await stream.finalMessage();
        onTiming?.({ durationMs: Date.now() - started, firstTokenMs, ...counts });
        return message;
      });
    },
  };
}

/** USD per million tokens (TD §8: cost per account vs revenue). Unknown models are priced as Sonnet. */
const SONNET = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const PRICES: Record<string, typeof SONNET> = {
  "claude-sonnet-5-5": SONNET,
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

export interface TurnUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export function usageOf(message: BetaMessage): TurnUsage {
  const u = message.usage;
  // A turn that summarized a long chat (compaction) reports that work as extra iterations, which
  // the top-level counts leave out; it is billed, so it is counted.
  type Iteration = {
    type: string;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  const extra = ((u as { iterations?: Iteration[] | null }).iterations ?? []).filter(
    (i) => i.type !== "message",
  );
  const sum = (pick: (i: Iteration) => number | null | undefined) =>
    extra.reduce((n, i) => n + (pick(i) ?? 0), 0);
  const usage = {
    model: message.model,
    inputTokens: u.input_tokens + sum((i) => i.input_tokens),
    outputTokens: u.output_tokens + sum((i) => i.output_tokens),
    cacheReadTokens: (u.cache_read_input_tokens ?? 0) + sum((i) => i.cache_read_input_tokens),
    cacheWriteTokens: (u.cache_creation_input_tokens ?? 0) + sum((i) => i.cache_creation_input_tokens),
  };
  const price = PRICES[message.model] ?? SONNET;
  const costUsd =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite) /
    1_000_000;
  return { ...usage, costUsd: Math.round(costUsd * 1e6) / 1e6 };
}
