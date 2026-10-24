import { describe, expect, it } from "vitest";

import { type QueryResult, financialReport, readInvoiceRegister } from "./reports.js";
import { anyReportText } from "./report-text.js";

const rows = (...r: unknown[][]): QueryResult => ({ ok: true, data: { rows: r } });

/** A fake 1C: the answer is picked by what the query reads. */
function fake(answers: [RegExp, (params: Record<string, unknown>) => QueryResult][]) {
  const asked: { query: string; params: Record<string, unknown> }[] = [];
  const run = async (query: string, params: Record<string, unknown>): Promise<QueryResult> => {
    asked.push({ query, params });
    const found = answers.find(([re]) => re.test(query));
    return found ? found[1](params) : rows();
  };
  return { run, asked };
}

describe("what moved the result", () => {
  it("reads this period and the one before, and names the drivers", async () => {
    const { run, asked } = fake([
      [
        /Субконто?Дт1\) КАК Кто/,
        (p) =>
          String(p.Нач).startsWith("2026-01")
            ? rows(["9010", "Alpha", 0, 700], ["9010", "Beta", 0, 300], ["9110", "Rice", 400, 0])
            : rows(["9010", "Alpha", 0, 400], ["9110", "Rice", 300, 0]),
      ],
    ]);
    const r = await financialReport(
      run,
      { report: "result_explain", from: "2026-01-01", to: "2026-03-31" },
      "2026-10-22",
    );
    expect(asked.map((a) => a.params.Нач)).toEqual(["2026-01-01T00:00:00", "2025-10-01T00:00:00"]);
    const text = anyReportText(r.ok ? r.data : null, "uz");
    expect(text).toContain("Alpha: 700");
    expect(text).toContain("+300");
    expect(text).toContain("oldin 400");
  });
});

describe("aging", () => {
  it("builds the ages from the entries and the opening balance", async () => {
    const { run } = fake([
      [
        /НАЧАЛОПЕРИОДА\(Х\.Период, ДЕНЬ\)/,
        () => rows(["Alpha", "2026-09-01T00:00:00", 1000, 0], ["Alpha", "2026-10-01T00:00:00", 0, 400]),
      ],
      [/Субконто1\) КАК Субъект/, () => rows(["Alpha", 200, 0])],
    ]);
    const r = await financialReport(run, { report: "aging_receivables", date: "2026-10-22" }, "2026-10-22");
    expect(r.ok && (r.data as { total: number }).total).toBe(800);
    const text = anyReportText(r.ok ? r.data : null, "en");
    expect(text).toContain("Receivables by age at 2026-10-22: 800");
    expect(text).toContain("Alpha");
  });
});

describe("tax accrual", () => {
  const answers: [RegExp, (p: Record<string, unknown>) => QueryResult][] = [
    [
      /Х.СчетДт.Код КАК Код, Х.СчетДт.Наименование КАК Имя/,
      () =>
        rows(
          ["9010", "Sales", 0, 1_000_000],
          ["9110", "Cost", 600_000, 0],
          ["9810", "Profit tax", 30_000, 0],
        ),
    ],
    [
      /НАЧАЛОПЕРИОДА\(Х\.Период, МЕСЯЦ\)/,
      () => rows(["2026-09-01T00:00:00", 1, 120_000], ["2026-09-01T00:00:00", 2, 70_000]),
    ],
  ];

  it("works out the profit tax still to accrue and the VAT position", async () => {
    const { run } = fake(answers);
    const r = await financialReport(
      run,
      { report: "tax_accrual", from: "2026-01-01", to: "2026-09-30" },
      "2026-10-22",
    );
    const text = anyReportText(r.ok ? r.data : null, "en");
    expect(text).toContain("profit before tax 400 000 × 15% = 60 000; accrued 30 000; to accrue 30 000");
    expect(text).toContain("entry (proposal): Dt 9810 Kt 6410 30 000");
    expect(text).toContain("2026-09: charged 120 000, to offset 70 000, payable 50 000");
    expect(text).toContain("not confirmed");
  });

  it("a turnover-tax company has no profit tax, and with no rate in the table is told to ask the adviser", async () => {
    const { run } = fake(answers);
    const r = await financialReport(
      run,
      { report: "tax_accrual", from: "2026-01-01", to: "2026-09-30" },
      "2026-10-22",
      {
        profile: {
          entity: "llc",
          regime: "turnover",
          vatPayer: false,
          activities: [],
          benefits: [],
          validFrom: "2020-01-01",
        },
      },
    );
    const text = anyReportText(r.ok ? r.data : null, "en");
    expect(text).not.toContain("Profit tax");
    expect(text).toContain("tax adviser must add it");
  });
});

describe("the calendar", () => {
  it("lists what falls due in the next days, with no read of 1C", async () => {
    const { run, asked } = fake([]);
    const r = await financialReport(
      run,
      { report: "tax_calendar", from: "2026-10-01", to: "2026-10-31" },
      "2026-10-22",
    );
    expect(asked).toHaveLength(0);
    const text = anyReportText(r.ok ? r.data : null, "ru");
    expect(text).toContain("2026-10-20: НДС, отчёт (2026-09)");
    expect(text).toContain("консультант");
  });
});

describe("the VAT registers", () => {
  const describe1c = async () => ({
    ok: true as const,
    data: [
      {
        attributes: [
          { name: "НомерВходящегоДокумента" },
          { name: "ДатаВходящегоДокумента" },
          { name: "СуммаДокумента" },
        ],
      },
    ],
  });

  it("finds the incoming number, date and amount from the object's description", async () => {
    const { run, asked } = fake([
      [/СчетФактураПолученный/, () => rows(["7", "2026-09-01T00:00:00", "111", 1000])],
    ]);
    const r = await readInvoiceRegister(
      run,
      describe1c,
      "Документ.СчетФактураПолученный",
      "2026-09-01",
      "2026-09-30",
    );
    expect(r).toEqual({
      ok: true,
      amounts: true,
      docs: [{ number: "7", date: "2026-09-01", inn: "111", amount: 1000 }],
    });
    expect(asked[0]?.query).toContain("Д.НомерВходящегоДокумента КАК Номер");
    expect(asked[0]?.query).toContain("Д.СуммаДокумента КАК Сумма");
  });

  it("compares both directions with Didox's documents", async () => {
    const { run } = fake([
      [/СчетФактураПолученный/, () => rows(["7", "2026-09-01", "111", 1000], ["9", "2026-09-02", "333", 5])],
      [/СчетФактураВыданный/, () => rows()],
    ]);
    const r = await financialReport(
      run,
      { report: "tax_registers", from: "2026-09-01", to: "2026-09-30" },
      "2026-10-22",
      {
        describe: describe1c,
        didox: {
          incoming: [
            { number: "7", date: "2026-09-01", inn: "111", amount: 1000 },
            { number: "8", date: "2026-09-03", inn: "222", amount: 300 },
          ],
          outgoing: [{ number: "1", date: "2026-09-05", inn: "444", amount: 50 }],
        },
      },
    );
    const text = anyReportText(r.ok ? r.data : null, "en");
    expect(text).toContain("in 1C 2, in Didox 2, matched 1");
    expect(text).toContain("In Didox, not in 1C:");
    expect(text).toContain("№ 8 2026-09-03 INN 222");
    expect(text).toContain("In 1C, not in Didox:");
    expect(text).toContain("№ 1 2026-09-05 INN 444");
  });

  it("says Didox is not connected when no documents were handed in", async () => {
    const { run } = fake([]);
    expect(await financialReport(run, { report: "tax_registers" }, "2026-10-22")).toMatchObject({
      ok: false,
      code: "NO_DIDOX_CONNECTION",
    });
  });
});

describe("the bank balance against 1C", () => {
  it("reads the bank accounts' balances at each statement's day", async () => {
    const { run, asked } = fake([
      [/НомерСчета КАК Счет/, () => rows(["20208000100438330001", 5_000_000, 0])],
    ]);
    const r = await financialReport(run, { report: "bank_reconcile" }, "2026-10-22", {
      statements: [
        { fileName: "a.xlsx", account: "20208000100438330001", date: "2026-09-30", closing: 4_999_000 },
      ],
    });
    expect(asked[0]?.params.Дата).toBe("2026-09-30T23:59:59");
    const text = anyReportText(r.ok ? r.data : null, "uz");
    expect(text).toContain("farq bor");
    expect(text).toContain("Δ -1 000");
  });

  it("asks for a statement when none is attached", async () => {
    const { run } = fake([]);
    expect(await financialReport(run, { report: "bank_reconcile" }, "2026-10-22")).toMatchObject({
      ok: false,
      code: "NO_STATEMENT",
    });
  });
});
