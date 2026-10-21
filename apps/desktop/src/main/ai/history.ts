import { type AiContentBlock, type AiMessage, CONTINUE_NOTE } from "@platform/shared";

/**
 * What a model step re-reads is the whole chat, and a chat that entered a year of documents holds hundreds of thousands
 * of tokens of results of questions long since answered. A result older than the question being answered is cut to its
 * start: the model has already used it, what it decided and what was created stay in its own messages and in the
 * chat state the app sends, and a result it still needs it reads again. The cut is at the start of the current
 * question, so it does not move while the question runs (the cached prompt stays valid between its steps).
 */
export const OLD_RESULT_CHARS = 1500;

/** Text of a user message that is the user's own words (not a bracketed note of the app, nor the continuation of a cut-off answer). */
const ownWords = (text: string) => !text.startsWith("[") && !text.startsWith(CONTINUE_NOTE);

const isQuestion = (m: AiMessage) =>
  m.role === "user" &&
  (typeof m.content === "string"
    ? ownWords(m.content)
    : !(m.content as AiContentBlock[]).some((b) => b.type === "tool_result") &&
      (m.content as AiContentBlock[]).some((b) => b.type === "text" && ownWords(String(b.text ?? ""))));

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

const isToolBlock = (b: AiContentBlock) => b.type === "tool_use" || b.type === "tool_result";
const isThinking = (b: AiContentBlock) => b.type === "thinking" || b.type === "redacted_thinking";

/**
 * The chat as it is sent, the strong form: of every question before the current one only the question and the
 * assistant's last words remain. Its tool calls, their results, its thinking and its progress notes are dropped: the
 * answer says what was done, the chat state the app sends says what was created and what is attached, and anything else
 * is read again. A year of documents entered question by question used to be re-read, result by result, at every
 * later step; this is what makes the cost of a step the same on the hundredth question as on the first.
 */
export function compactOlderTurns(messages: AiMessage[]): AiMessage[] {
  const from = currentQuestion(messages);
  if (from === 0) return messages;
  const out: AiMessage[] = [];
  let pendingAnswer: AiMessage | null = null;
  const flush = () => {
    if (pendingAnswer) out.push(pendingAnswer);
    pendingAnswer = null;
  };
  for (let i = 0; i < from; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "assistant") {
      if (typeof m.content === "string") {
        pendingAnswer = m;
        continue;
      }
      const text = (m.content as AiContentBlock[]).filter((b) => !isToolBlock(b) && !isThinking(b));
      // A step that only called tools has no words of its own: the answer before it stays the last words.
      if (text.some((b) => b.type === "text" && String(b.text ?? "").trim() !== "")) {
        pendingAnswer = { ...m, content: text };
      }
      continue;
    }
    // A user message: a question (kept), or tool results (dropped).
    if (typeof m.content === "string") {
      flush();
      out.push(m);
      continue;
    }
    const kept = (m.content as AiContentBlock[]).filter((b) => b.type !== "tool_result");
    if (kept.length === 0) continue;
    flush();
    out.push(kept.length === m.content.length ? m : { ...m, content: kept });
  }
  flush();
  const rest = messages.slice(from);
  return out.length === from && out.every((m, k) => m === messages[k]) ? messages : [...out, ...rest];
}
