import type { AiMessage } from "@platform/shared";
import { describe, expect, it } from "vitest";

const textOf = (m: AiMessage | undefined) =>
  ((m?.content ?? []) as unknown as { content: string }[])[0]?.content ?? "";

import { OLD_RESULT_CHARS, trimOlderResults } from "./history.js";

const result = (id: string, text: string): AiMessage => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: text }],
});
const use = (id: string): AiMessage => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "run_query", input: {} }],
});
const ask = (text: string): AiMessage => ({ role: "user", content: [{ type: "text", text }] });

describe("what the model re-reads of an old question", () => {
  it("cuts the results of earlier questions and keeps those of the current one whole", () => {
    const big = "x".repeat(50_000);
    const chat = [
      ask("first"),
      use("a"),
      result("a", big),
      { role: "assistant", content: [{ type: "text", text: "done" }] } as AiMessage,
      ask("second"),
      use("b"),
      result("b", big),
    ];
    const sent = trimOlderResults(chat);
    const old = textOf(sent[2]);
    expect(old.length).toBeLessThan(OLD_RESULT_CHARS + 200);
    expect(old).toContain("older result cut: 50000 characters");
    expect(textOf(sent[6])).toBe(big);
    // The stored chat is untouched.
    expect(textOf(chat[2])).toBe(big);
  });

  it("leaves short results and a chat with nothing old alone", () => {
    const chat = [ask("q"), use("a"), result("a", "short")];
    expect(trimOlderResults(chat)).toBe(chat);
    const withShort = [ask("q1"), use("a"), result("a", "short"), ask("q2")];
    expect(trimOlderResults(withShort)).toBe(withShort);
  });

  it("does not take a bracketed note (a continuation, the app's own message) for a new question", () => {
    const big = "y".repeat(5_000);
    const chat = [
      ask("question"),
      use("a"),
      result("a", big),
      { role: "user", content: [{ type: "text", text: "[note] go on" }] } as AiMessage,
    ];
    const sent = trimOlderResults(chat);
    expect(textOf(sent[2])).toBe(big);
  });
});
