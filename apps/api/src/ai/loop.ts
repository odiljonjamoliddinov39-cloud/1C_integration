/**
 * The loop guard: a question may read 1C only so many times (policy.maxToolCalls). After that the
 * model is not offered tools and answers with what it has found, saying what is still missing.
 * Counted from the chat itself, so it cannot be bypassed by the app. Audit checks have their own
 * step limit in the app and are not counted here.
 */
import type { AiMessage, AiPolicy } from "@platform/shared";

import { readCallsInQuestion } from "./usage.js";

export interface LoopState {
  calls: number;
  capped: boolean;
}

export function loopGuard(policy: AiPolicy, messages: AiMessage[], audit: boolean): LoopState {
  const calls = readCallsInQuestion(messages);
  return { calls, capped: !audit && policy.maxToolCalls > 0 && calls >= policy.maxToolCalls };
}

export const loopNote = (calls: number) =>
  `Tool-call limit reached: this question already read 1C ${calls} times. Do not call any more tools. ` +
  "Answer now with what you have found, say clearly what is still missing, and how to get it " +
  "(the accountant can ask a narrower follow-up).";
