import { type AiMessage, CONTINUE_NOTE } from "@platform/shared";
import { describe, expect, it } from "vitest";

const textOf = (m: AiMessage | undefined) =>
  ((m?.content ?? []) as unknown as { content: string }[])[0]?.content ?? "";

import { OLD_RESULT_CHARS, compactOlderTurns, trimOlderResults } from "./history.js";

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

describe("the chat as it is sent", () => {
  const answer = (text: string): AiMessage => ({ role: "assistant", content: [{ type: "text", text }] });
  const step = (id: string, note = ""): AiMessage => ({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "x".repeat(2000), signature: "s" },
      ...(note ? [{ type: "text", text: note }] : []),
      { type: "tool_use", id, name: "run_query", input: { query: "q".repeat(500) } },
    ],
  });

  it("keeps of an earlier question only the question and the answer", () => {
    const chat = [
      ask("first"),
      step("a", "looking"),
      result("a", "r".repeat(40_000)),
      step("b"),
      result("b", "r".repeat(40_000)),
      answer("Done: 12 documents"),
      ask("second"),
      step("c"),
      result("c", "live"),
    ];
    const sent = compactOlderTurns(chat);
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(sent[1]).toEqual(answer("Done: 12 documents"));
    // The question being answered is whole, thinking and results included.
    expect(sent.slice(2)).toEqual(chat.slice(6));
    expect(JSON.stringify(sent).length).toBeLessThan(4_000);
  });

  it("does not take the continuation of a cut-off answer for a new question", () => {
    const chat = [
      ask("q"),
      step("a"),
      result("a", "live"),
      {
        role: "user",
        content: [{ type: "text", text: CONTINUE_NOTE }],
      } as AiMessage,
    ];
    expect(compactOlderTurns(chat)).toBe(chat);
  });

  it("costs the same on the hundredth question as on the second: what a step sends does not grow", () => {
    const chat: AiMessage[] = [];
    const sizes: number[] = [];
    for (let q = 0; q < 100; q++) {
      chat.push(ask(`question ${q}`));
      sizes.push(JSON.stringify(compactOlderTurns(chat)).length);
      for (let k = 0; k < 4; k++) {
        chat.push(step(`${q}-${k}`, `step ${k}`), result(`${q}-${k}`, "r".repeat(30_000)));
      }
      chat.push(answer(`Question ${q}: 4 steps, 30 documents entered`));
    }
    // The size at the start of a question: the questions and the answers so far, never the results.
    expect(sizes[99]).toBeLessThan(sizes[1]! + 100 * 200);
    expect(sizes[99]).toBeLessThan(30_000);
    expect(JSON.stringify(chat).length).toBeGreaterThan(12_000_000);
  });
});
