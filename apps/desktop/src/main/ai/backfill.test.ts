import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AiMessage } from "@platform/shared";
import { describe, expect, it } from "vitest";

import { TraceLog, tracesFromMessages } from "./backfill.js";
import { decodeTable, encodeTable } from "./toon.js";

const QUERY = "ВЫБРАТЬ Счет, СальдоДт ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки(&Дата)";
const DAY = new Date("2026-10-08T12:00:00Z");

const use = (id: string, name: string, input: object): AiMessage => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input }],
});
const result = (id: string, content: string, error = false): AiMessage => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content, ...(error ? { is_error: true } : {}) }],
});
const answer = (text: string): AiMessage => ({ role: "assistant", content: [{ type: "text", text }] });
const table = encodeTable(
  ["Счет", "СальдоДт"],
  [
    ["5110 Расчетный счет", 125000000],
    ['6010, "поставщики"', 0],
  ],
);

describe("TOON tables read back", () => {
  it("round-trips what encodeTable writes: commas and quotes in cells, numbers, nulls, midnight dates", () => {
    const text = encodeTable(
      ["Счет, имя", "Сумма", "Дата", "Пусто", "Флаг"],
      [
        ['6010, "поставщики"', 12.5, "2026-10-01T00:00:00", null, true],
        ["00123", "123", "line\nbreak", "", false],
      ],
    );
    expect(decodeTable(text)).toEqual({
      columns: ["Счет, имя", "Сумма", "Дата", "Пусто", "Флаг"],
      rows: [
        ['6010, "поставщики"', 12.5, "2026-10-01", null, true],
        ["00123", "123", "line\nbreak", "", false],
      ],
    });
    expect(decodeTable("not a table")).toBeNull();
    // A note after a cut result is not a row.
    expect(decodeTable(`${table}\n[The result was cut at 2 rows; more exist.]`)?.rows).toHaveLength(2);
  });
});

describe("traces from saved chats", () => {
  const read = (question: string, query = QUERY, params: object = { Дата: "2026-10-08" }): AiMessage[] => [
    { role: "user", content: question },
    use("q1", "run_query", { query, params }),
    result("q1", table),
    answer("Qoldiq: 125 mln"),
  ];

  it("rebuilds the trace of a question answered by one query, as a live one would be", () => {
    const [trace, ...rest] = tracesFromMessages(read("Какой остаток в кассе сегодня?"), 0, "Crystal", [DAY]);
    expect(rest).toEqual([]);
    expect(trace).toMatchObject({
      company: "Crystal",
      question: "Какой остаток в кассе сегодня?",
      outcome: "answered",
      steps: [
        {
          tool: "run_query",
          ok: true,
          query: QUERY,
          columns: ["Счет", "СальдоДт"],
          rowCount: 2,
          truncated: false,
        },
      ],
      learnable: { step: 0, params: [{ name: "Дата", type: "date" }] },
    });
    // The figures stay behind.
    expect(JSON.stringify(trace)).not.toContain("125000000");
  });

  it("takes the day the question was asked on from the chat's days, and skips what it cannot place", () => {
    const messages = read("Какой остаток в кассе сегодня?");
    // Asked on another day than the query's date: not a "today" question.
    expect(tracesFromMessages(messages, 0, "C", [new Date("2026-10-20T12:00:00Z")])).toEqual([]);
    expect(tracesFromMessages(messages, 0, "C", [new Date("2026-10-20T12:00:00Z"), DAY])).toHaveLength(1);
  });

  it("replays only from where it was left, one trace per question, and leaves out what cannot be a template", () => {
    const messages: AiMessage[] = [
      ...read("Какой остаток в кассе сегодня?"),
      // Needs two queries: no.
      { role: "user", content: "Какая выручка сегодня" },
      use("a", "run_query", { query: "ВЫБРАТЬ 1", params: {} }),
      result("a", table),
      use("b", "run_query", { query: "ВЫБРАТЬ 2", params: {} }),
      result("b", table),
      answer("x"),
      // A file came with it: no.
      {
        role: "user",
        content: [
          { type: "document", title: "a.pdf", source: { type: "text", media_type: "text/plain", data: "x" } },
          { type: "text", text: "Что в файле" },
        ],
      },
      answer("y"),
      // A card was prepared: no.
      { role: "user", content: "Выпиши счета-фактуры" },
      use("c", "propose_invoices_issued", { title: "t", sales: [] }),
      result("c", '{"status":"done"}'),
      answer("z"),
      // A failed query: no.
      ...read("Остаток по банку сегодня", "ВЫБРАТЬ Ошибка").slice(0, 2),
      result("q1", "1C error", true),
      answer("failed"),
      ...read("Дебиторская задолженность на сегодня", "ВЫБРАТЬ Дебиторка"),
    ];
    const traces = tracesFromMessages(messages, 0, "C", [DAY]);
    expect(traces.map((t) => t.question)).toEqual([
      "Какой остаток в кассе сегодня?",
      "Дебиторская задолженность на сегодня",
    ]);
    // From the middle: only the later question.
    expect(tracesFromMessages(messages, messages.length - 4, "C", [DAY]).map((t) => t.question)).toEqual([
      "Дебиторская задолженность на сегодня",
    ]);
  });

  it("reads results kept in the older JSON form too", () => {
    const messages = read("Какой остаток в кассе сегодня?");
    messages[2] = result(
      "q1",
      JSON.stringify({ columns: ["Счет", "СальдоДт"], rows: [["5110", 1]], truncated: false }),
    );
    expect(tracesFromMessages(messages, 0, "C", [DAY])).toHaveLength(1);
  });
});

describe("TraceLog", () => {
  it("remembers how far each chat was learned from, across restarts", () => {
    const file = join(mkdtempSync(join(tmpdir(), "tracelog-")), "traced.json");
    const log = new TraceLog(file);
    expect(log.get("chat-1")).toBe(0);
    log.set("chat-1", 6);
    expect(new TraceLog(file).get("chat-1")).toBe(6);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "chat-1": 6 });
  });
});
