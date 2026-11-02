import { type AiMessage, CONTINUE_NOTE } from "@platform/shared";
import { describe, expect, it } from "vitest";

const textOf = (m: AiMessage | undefined) =>
  ((m?.content ?? []) as unknown as { content: string }[])[0]?.content ?? "";

import {
  CHAIN_RESULT_CHARS,
  OLD_RESULT_CHARS,
  compactOlderTurns,
  isGoAhead,
  trimOlderResults,
} from "./history.js";

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

describe("a go-ahead goes on with the work before it", () => {
  const said = (text: string): AiMessage => ({ role: "assistant", content: [{ type: "text", text }] });

  it("knows a go-ahead from a task, however short the task is", () => {
    for (const reply of ["davom et", "1", "2", "o'tkazib yubor", "Davom et", "да"])
      expect(isGoAhead(ask(reply)), reply).toBe(true);
    expect(isGoAhead(ask("Write the sales invoices for the payments of 27-30 October"))).toBe(false);
  });

  it("keeps what the earlier steps read, so 'davom et' has something to go on with", () => {
    const data = "payments: " + "row\n".repeat(200);
    const chat = [
      ask("Enter the sales for the bank receipts of 27-30.10.2026"),
      use("a"),
      result("a", data),
      said("I read the payments. Write 'davom et' and I enter them."),
      ask("davom et"),
    ];
    const sent = compactOlderTurns(chat);
    // The task, the call, its result and the answer are all still there.
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(textOf(sent[2])).toBe(data);
  });

  it("keeps the whole chain of go-aheads back to the task, and reduces what is older than the task", () => {
    const chat = [
      ask("an older task"),
      use("old"),
      result("old", "old data"),
      said("old answer"),
      ask("the real task: enter the receipts"),
      use("a"),
      result("a", "data a"),
      said("read them; say davom et"),
      ask("davom et"),
      use("b"),
      result("b", "data b"),
      said("read more; say 1"),
      ask("1"),
    ];
    const sent = compactOlderTurns(chat);
    const results = sent
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === "tool_result");
    // The older task lost its result; the chain kept its two.
    expect(results.map((b) => (b as unknown as { content: string }).content)).toEqual(["data a", "data b"]);
    expect(sent[0]).toBe(chat[0]);
  });

  it("cuts a long kept result, and reduces as before when the new question is a task", () => {
    const big = "z".repeat(CHAIN_RESULT_CHARS * 3);
    const chat = [ask("task"), use("a"), result("a", big), said("done"), ask("davom et")];
    const kept = textOf(compactOlderTurns(chat)[2]);
    expect(kept.length).toBeLessThan(CHAIN_RESULT_CHARS + 200);
    expect(kept).toContain("older result cut");
    const task = [
      ask("task"),
      use("a"),
      result("a", big),
      said("done"),
      ask("Now write the invoices for the whole of September please"),
    ];
    expect(compactOlderTurns(task).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});
