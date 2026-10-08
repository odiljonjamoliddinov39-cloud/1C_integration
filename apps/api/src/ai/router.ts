/**
 * The model router: simple lookups may run on the cheaper model (policy.simpleModel), everything
 * else on the default one. A failed tool step, or a request the app marks as escalated, moves the
 * rest of the question to the default model, so a cheaper answer never replaces a correct one.
 */
import type { AiChatInput, AiMessage, AiPolicy } from "@platform/shared";

import type { ModelChoice } from "./settings.js";
import { questionStart } from "./usage.js";

export interface Routed {
  model: string;
  /** null: the model takes no effort setting. */
  effort: ModelChoice["effort"] | null;
  /** True when this call runs on the simple-task model. */
  simple: boolean;
}

/** A tool result with is_error since the question began. */
export function toolStepFailed(messages: AiMessage[]): boolean {
  return messages.slice(questionStart(messages)).some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => {
        const b = block as { type?: unknown; is_error?: unknown };
        return b.type === "tool_result" && b.is_error === true;
      }),
  );
}

export function routeModel(
  choice: ModelChoice,
  policy: AiPolicy,
  input: AiChatInput,
  audit: boolean,
): Routed {
  const simple =
    policy.simpleModel !== null &&
    !audit &&
    input.task === "lookup" &&
    input.escalate !== true &&
    !toolStepFailed(input.messages);
  return simple && policy.simpleModel
    ? { model: policy.simpleModel, effort: null, simple: true }
    : { model: choice.model, effort: choice.effort, simple: false };
}

/** The simple model takes no thinking blocks from earlier turns of another model. */
export function withoutThinking(messages: AiMessage[]): AiMessage[] {
  return messages.map((message) =>
    message.role === "assistant" && Array.isArray(message.content)
      ? {
          ...message,
          content: message.content.filter((block) => {
            const type = (block as { type?: unknown }).type;
            return type !== "thinking" && type !== "redacted_thinking";
          }),
        }
      : message,
  );
}
