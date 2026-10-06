/**
 * The one place that calls the Claude API. Tests replace it with a fake.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";

export interface TurnCallbacks {
  /** The answer text, as it is written. */
  onText: (text: string) => void;
  /** The model's short notes between tool calls ("checking September's payments…"), as written. */
  onProgress?: (text: string) => void;
}

export interface AiModel {
  /** Streams one turn through the callbacks; the finished message is returned. */
  turn(params: BetaMessageStreamParams, callbacks: TurnCallbacks, signal: AbortSignal): Promise<BetaMessage>;
}

export function claudeModel(apiKey: string): AiModel {
  const client = new Anthropic({ apiKey });
  return {
    async turn(params, { onText, onProgress }, signal) {
      const stream = client.beta.messages.stream(params, { signal });
      stream.on("text", onText);
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
      return stream.finalMessage();
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
  const usage = {
    model: message.model,
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
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
