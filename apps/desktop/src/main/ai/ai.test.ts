import { DEFAULT_AI_POLICY, type QueryTemplateView } from "@platform/shared";
import { describe, expect, it } from "vitest";

import { classifyTask } from "./classify.js";
import { learnFromRun, matchTemplate, renderTemplate } from "./templates.js";
import { cell, encodeTable } from "./toon.js";
import { clampQuery, shapeQueryResult } from "./trim.js";

describe("TOON tables", () => {
  it("writes the column names once and one line per row", () => {
    expect(
      encodeTable(
        ["Счет", "Сумма", "Проведен"],
        [
          ["5110 Расчетный счет", 125000000, true],
          ["6010, поставщики", -3.5, null],
        ],
      ),
    ).toBe(
      [
        "rows[2]{Счет,Сумма,Проведен}:",
        "  5110 Расчетный счет,125000000,true",
        '  "6010, поставщики",-3.5,null',
      ].join("\n"),
    );
    expect(encodeTable(["A"], [])).toBe("rows[0]{A}:");
  });

  it("quotes what could be read as something else, and escapes quotes and line breaks", () => {
    expect(cell("12")).toBe('"12"');
    expect(cell("007")).toBe('"007"');
    expect(cell("true")).toBe('"true"');
    expect(cell("null")).toBe('"null"');
    expect(cell("")).toBe('""');
    expect(cell(" padded ")).toBe('" padded "');
    expect(cell("a:b")).toBe("a:b");
    expect(cell("2026-09-01T00:00:00")).toBe("2026-09-01");
    expect(cell("2026-09-01T10:30:00")).toBe("2026-09-01T10:30:00");
    expect(cell('say "hi"\nnow')).toBe('"say \\"hi\\"\\nnow"');
    expect(cell("-5 so'm")).toBe('"-5 so\'m"');
    expect(cell(Number.NaN)).toBe("null");
    expect(cell({ ref: "x" })).toBe('"{\\"ref\\":\\"x\\"}"');
    expect(cell("ООО «Тест»")).toBe("ООО «Тест»");
  });

  it("is smaller than the same rows as JSON", () => {
    const rows = Array.from({ length: 50 }, (_, i) => [
      `Контрагент ${i}`,
      i * 1000 + 0.5,
      "2026-09-01T00:00:00",
      `Оплата по договору № ${i}`,
    ]);
    const columns = ["Контрагент", "Сумма", "Дата", "Назначение"];
    const json = JSON.stringify({ columns, rows, truncated: false });
    expect(encodeTable(columns, rows).length).toBeLessThan(json.length * 0.85);
  });
});

describe("result trimmer", () => {
  it("sets the row limit from the policy: its default, never above the hard cap", () => {
    const query = { query: "ВЫБРАТЬ 1" };
    expect(clampQuery(query, DEFAULT_AI_POLICY).limit).toBe(50);
    expect(clampQuery({ ...query, limit: 200 }, DEFAULT_AI_POLICY).limit).toBe(200);
    expect(clampQuery({ ...query, limit: 1000 }, DEFAULT_AI_POLICY).limit).toBe(500);
    expect(clampQuery({ ...query, limit: 5 }, { ...DEFAULT_AI_POLICY, maxRows: 100 }).limit).toBe(5);
  });

  it("tells the model when a result was cut, and what to do instead of paging", () => {
    const whole = shapeQueryResult({ columns: ["A"], rows: [["x"]], truncated: false }, DEFAULT_AI_POLICY);
    expect(whole).toBe("rows[1]{A}:\n  x");
    const cut = shapeQueryResult({ columns: ["A"], rows: [["x"]], truncated: true }, DEFAULT_AI_POLICY);
    expect(cut).toContain("cut at 1 rows");
    expect(cut).toContain("aggregate");
    expect(cut).toContain("up to 500");
    // Anything that is not a table stays JSON.
    expect(shapeQueryResult({ fullName: "Документ.X" }, DEFAULT_AI_POLICY)).toBeNull();
  });
});

describe("task classification", () => {
  it("calls a short read a lookup, and everything else work", () => {
    expect(classifyTask("Сколько денег на расчётном счёте?", false)).toBe("lookup");
    expect(classifyTask("5110 qoldig'i qancha?", false)).toBe("lookup");
    expect(classifyTask("Show the balance of 6010", false)).toBe("lookup");
    expect(classifyTask("Создай счет-фактуры по реализациям за сентябрь", false)).toBe("work");
    expect(classifyTask("Почему не сходится остаток по 6010?", false)).toBe("work");
    expect(classifyTask("Show the balance", true)).toBe("work");
    expect(classifyTask("Привет", false)).toBe("work");
    expect(classifyTask(`Сколько ${"очень ".repeat(40)}долго`, false)).toBe("work");
  });
});

const TODAY = new Date("2026-10-07T10:00:00Z");
const template = (over: Partial<QueryTemplateView>): QueryTemplateView => ({
  id: "1",
  code: "cash_balance",
  title: "Остаток в кассе",
  intents: ["остаток в кассе", "kassadagi qoldiq", "cash balance"],
  query: "ВЫБРАТЬ 1",
  params: [{ name: "Дата", type: "date" }],
  columns: [
    { label: "Касса", format: "text" },
    { label: "Сумма", format: "money" },
  ],
  totals: true,
  enabled: true,
  version: 1,
  updatedAt: "2026-10-07T00:00:00Z",
  source: "admin",
  company: null,
  accountName: null,
  hits: 0,
  rejected: 0,
  action: null,
  ...over,
});

describe("template matcher", () => {
  const cash = template({});
  const debts = template({
    code: "debts",
    title: "Долги покупателей",
    intents: ["долги покупателей", "дебиторская задолженность"],
    params: [
      { name: "ДатаНачала", type: "month_start" },
      { name: "ДатаКонца", type: "month_end" },
    ],
  });

  it("recognizes a known question however it is worded, and takes the date from it", () => {
    expect(matchTemplate("Какой остаток в кассе?", [cash], TODAY)?.params).toEqual({ Дата: "2026-10-07" });
    expect(matchTemplate("остатки в кассе на 30.09.2026", [cash], TODAY)?.params).toEqual({
      Дата: "2026-09-30",
    });
    expect(matchTemplate("kassadagi qoldiq", [cash], TODAY)?.template.code).toBe("cash_balance");
    expect(matchTemplate("Cash balance, please", [cash], TODAY)?.template.code).toBe("cash_balance");
    expect(matchTemplate("покажи остаток в кассе сегодня", [cash], TODAY)).not.toBeNull();
  });

  it("takes the month and year for a period", () => {
    expect(matchTemplate("долги покупателей за сентябрь", [debts], TODAY)?.params).toEqual({
      ДатаНачала: "2026-09-01",
      ДатаКонца: "2026-09-30",
    });
    expect(matchTemplate("Долги покупателей за февраль 2024", [debts], TODAY)?.params).toEqual({
      ДатаНачала: "2024-02-01",
      ДатаКонца: "2024-02-29",
    });
    expect(matchTemplate("долги покупателей за прошлый месяц", [debts], TODAY)?.params).toEqual({
      ДатаНачала: "2026-09-01",
      ДатаКонца: "2026-09-30",
    });
    expect(matchTemplate("долги покупателей", [debts], TODAY)?.params).toEqual({
      ДатаНачала: "2026-10-01",
      ДатаКонца: "2026-10-31",
    });
  });

  it("leaves a different, longer or conditional question to the model", () => {
    // An extra condition changes the question.
    expect(matchTemplate("остаток в кассе без учёта подотчёта по Ивану", [cash], TODAY)).toBeNull();
    expect(matchTemplate("остаток в кассе по валютной кассе", [cash], TODAY)).toBeNull();
    // Not all of the phrase's words are there.
    expect(matchTemplate("остаток на складе", [cash], TODAY)).toBeNull();
    expect(matchTemplate("касса", [cash], TODAY)).toBeNull();
    // Too long to be the known question.
    expect(
      matchTemplate(
        "а можете подробно рассказать мне про остаток в кассе за все время работы фирмы",
        [cash],
        TODAY,
      ),
    ).toBeNull();
    // A turned-off template is not used.
    expect(matchTemplate("остаток в кассе", [template({ enabled: false })], TODAY)).toBeNull();
  });

  it("needs the values a template asks for in the question", () => {
    const byNumber = template({
      code: "doc",
      intents: ["найди документ номер"],
      params: [{ name: "Номер", type: "number" }],
    });
    expect(matchTemplate("найди документ номер 125", [byNumber], TODAY)?.params).toEqual({ Номер: 125 });
    expect(matchTemplate("найди документ номер", [byNumber], TODAY)).toBeNull();
    const byName = template({
      code: "cp",
      intents: ["долг контрагента"],
      params: [{ name: "Контрагент", type: "text" }],
    });
    expect(matchTemplate('долг контрагента "ООО Рога"', [byName], TODAY)?.params).toEqual({
      Контрагент: "ООО Рога",
    });
    expect(matchTemplate("долг контрагента", [byName], TODAY)).toBeNull();
  });

  it("picks the most specific phrase when several templates fit", () => {
    const general = template({ code: "g", intents: ["остаток денег"], params: [] });
    const specific = template({ code: "s", intents: ["остаток денег в кассе"], params: [] });
    expect(matchTemplate("остаток денег в кассе", [general, specific], TODAY)?.template.code).toBe("s");
  });
});

describe("template answer", () => {
  it("shows the rows in the layout, with totals", () => {
    const text = renderTemplate(template({}), {
      columns: ["Касса", "Сумма"],
      rows: [
        ["Основная касса", 1250000.5],
        ["Касса магазина", 300000],
      ],
      truncated: false,
    });
    // The thousands are separated by a non-breaking space; compare with a plain one.
    expect(text.replace(/[\u00a0\u202f]/g, " ").split("\n")).toEqual([
      "**Остаток в кассе**",
      "",
      "| Касса | Сумма |",
      "| --- | ---: |",
      "| Основная касса | 1 250 000,5 |",
      "| Касса магазина | 300 000 |",
      "| **Σ** | **1 550 000,5** |",
    ]);
  });
});

describe("learning a template from an answered question", () => {
  const result = {
    columns: ["Счет", "Сумма", "Дата"],
    rows: [
      ["5010", 1250000.5, "2026-10-01T00:00:00"],
      ["5020", 0, null],
    ],
    truncated: false,
  };
  const query = "ВЫБРАТЬ Счет, Сумма ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки(&Дата)";

  it("takes the question's meaningful words, the parameter types and the column formats", () => {
    expect(
      learnFromRun(
        "Какой остаток в кассе сегодня?",
        { query, params: { Дата: "2026-10-07" } },
        result,
        TODAY,
      ),
    ).toEqual({
      phrase: "остаток кассе",
      query,
      params: [{ name: "Дата", type: "date" }],
      columns: [
        { label: "Счет", format: "text" },
        { label: "Сумма", format: "number" },
        { label: "Дата", format: "date" },
      ],
    });
  });

  it("types a month's start and end, and leaves the month's name out of the phrase", () => {
    const learned = learnFromRun(
      "Долги покупателей за сентябрь",
      { query, params: { ДатаНачала: "2026-09-01", ДатаКонца: "2026-09-30" } },
      result,
      TODAY,
    );
    expect(learned?.params).toEqual([
      { name: "ДатаНачала", type: "month_start" },
      { name: "ДатаКонца", type: "month_end" },
    ]);
    expect(learned?.phrase).toBe("долги покупателей");
    // Which the matcher then recognizes for another month.
    const template = { ...learnedTemplate(learned!), id: "l" };
    expect(matchTemplate("долги покупателей за август", [template], TODAY)?.params).toEqual({
      ДатаНачала: "2026-08-01",
      ДатаКонца: "2026-08-31",
    });
  });

  it("learns nothing it could get wrong", () => {
    const ask = (question: string, params?: Record<string, string | number>, over = {}) =>
      learnFromRun(question, { query, ...(params ? { params } : {}) }, { ...result, ...over }, TODAY);
    expect(ask("Остаток в кассе", { Дата: "2026-10-07" })).not.toBeNull();
    // Numbers or quoted values in the question are specifics a template cannot follow.
    expect(ask("Остаток по счету 5010", { Дата: "2026-10-07" })).toBeNull();
    expect(ask('Долг контрагента "Рога"', { Дата: "2026-10-07" })).toBeNull();
    // A parameter that is not the question's date or month (a counterparty, an amount, another period).
    expect(ask("Остаток в кассе", { Дата: "2025-01-15" })).toBeNull();
    expect(ask("Остаток в кассе", { Сумма: 1000 })).toBeNull();
    // A period written into the query.
    expect(
      learnFromRun("Остаток в кассе", { query: "ВЫБРАТЬ 1 ГДЕ Дата > ДАТАВРЕМЯ(2026, 1, 1)" }, result, TODAY),
    ).toBeNull();
    // A cut or empty result, and a question with too little in it.
    expect(ask("Остаток в кассе", { Дата: "2026-10-07" }, { truncated: true })).toBeNull();
    expect(ask("Остаток в кассе", { Дата: "2026-10-07" }, { rows: [] })).toBeNull();
    expect(ask("Остатки", { Дата: "2026-10-07" })).toBeNull();
  });
});

function learnedTemplate(learned: NonNullable<ReturnType<typeof learnFromRun>>): QueryTemplateView {
  return template({
    code: "learned_x",
    title: learned.phrase,
    intents: [learned.phrase],
    query: learned.query,
    params: learned.params,
    columns: learned.columns,
    source: "learned",
    company: "ООО «Тест»",
  });
}
