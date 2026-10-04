/**
 * The AI assistant (TD §7 "AI assistant", §8 "AI proxy"). The desktop app runs the tools against
 * 1C on the PC and sends the conversation to the control system; the control system holds the
 * Claude API key, the system prompt and the tool list, and counts tokens per account.
 */
import { z } from "zod";

import { RunQueryInput } from "./platform-api.js";

/** Read-only tools the assistant may call; the desktop runs them through PlatformAPI. */
export const AI_TOOLS = {
  list_organizations: z.object({}),
  describe_objects: z.object({
    /** Full 1C names, e.g. "Документ.СчетФактураПолученный", "РегистрБухгалтерии.Хозрасчетный". */
    objects: z.array(z.string().min(1)).min(1).max(20),
  }),
  run_query: RunQueryInput,
} as const;
export type AiToolName = keyof typeof AI_TOOLS;

export function isAiToolName(name: string): name is AiToolName {
  return Object.hasOwn(AI_TOOLS, name);
}

/** A content block as the Claude API returns it. Passed back unchanged: thinking blocks must be. */
export const AiContentBlock = z.looseObject({ type: z.string() });
export type AiContentBlock = z.infer<typeof AiContentBlock>;

export const AiMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string().min(1), z.array(AiContentBlock).min(1)]),
});
export type AiMessage = z.infer<typeof AiMessage>;

export const AiChatInput = z.object({
  /** The company the questions are about (its 1C organization name). */
  company: z.string().trim().min(1).max(200),
  messages: z.array(AiMessage).min(1).max(200),
});
export type AiChatInput = z.infer<typeof AiChatInput>;

export const AiToolUse = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
export type AiToolUse = z.infer<typeof AiToolUse>;

/** POST /v1/ai/chat answers with one JSON event per line. */
export const AiEvent = z.discriminatedUnion("type", [
  /** A piece of the answer text, as it is generated. */
  z.object({ type: z.literal("text"), text: z.string() }),
  /** The finished turn: append `content` to the conversation as the assistant message. */
  z.object({
    type: z.literal("message"),
    content: z.array(AiContentBlock),
    stopReason: z.string().nullable(),
  }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type AiEvent = z.infer<typeof AiEvent>;
