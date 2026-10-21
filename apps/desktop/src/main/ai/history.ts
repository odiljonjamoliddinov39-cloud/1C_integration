import type { AiContentBlock, AiMessage } from "@platform/shared";

/**
 * What a model step re-reads is the whole chat, and a chat that entered a year of documents holds hundreds of thousands
 * of tokens of results of questions long since answered. A result older than the question being answered is cut to its
 * start: the model has already used it, what it decided and what was created stay in its own messages and in the
 * chat state the app sends, and a result it still needs it reads again. The cut is at the start of the current
 * question, so it does not move while the question runs (the cached prompt stays valid between its steps).
 */
export const OLD_RESULT_CHARS = 1500;

const isQuestion = (m: AiMessage) =>
  m.role === "user" &&
  (typeof m.content === "string" ||
    (m.content as AiContentBlock[]).some((b) => b.type === "text" && !String(b.text ?? "").startsWith("[")));

/** Index of the message that holds the question being answered (the last user message with text of its own). */
function currentQuestion(messages: AiMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && isQuestion(m)) return i;
  }
  return 0;
}

function trimBlock(block: AiContentBlock): AiContentBlock {
  if (block.type !== "tool_result") return block;
  const content = block.content;
  if (typeof content === "string") {
    if (content.length <= OLD_RESULT_CHARS) return block;
    return {
      ...block,
      content: `${content.slice(0, OLD_RESULT_CHARS)}… [older result cut: ${content.length} characters; read it again if it is needed]`,
    };
  }
  if (Array.isArray(content)) {
    const size = JSON.stringify(content).length;
    if (size <= OLD_RESULT_CHARS) return block;
    const text = content
      .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
      .join("\n");
    return {
      ...block,
      content: `${text.slice(0, OLD_RESULT_CHARS)}… [older result cut: ${size} characters; read it again if it is needed]`,
    };
  }
  return block;
}

/** The chat as it is sent: results of earlier questions cut to their start; the stored chat is not touched. */
export function trimOlderResults(messages: AiMessage[]): AiMessage[] {
  const from = currentQuestion(messages);
  let changed = false;
  const out = messages.map((m, i) => {
    if (i >= from || m.role !== "user" || typeof m.content === "string") return m;
    const content = (m.content as AiContentBlock[]).map(trimBlock);
    if (content.some((b, k) => b !== (m.content as AiContentBlock[])[k])) changed = true;
    return { ...m, content };
  });
  return changed ? out : messages;
}
