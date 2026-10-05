import { describe, expect, it } from "vitest";

import {
  INLINE_CHARS,
  type TableFile,
  columnLetter,
  describeTable,
  parseCsv,
  parseDate,
  parseNumber,
  readTable,
} from "./tables.js";

const statement: TableFile = {
  name: "Выписка.xlsx",
  sheets: [
    {
      name: "Лист1",
      rows: [
        ["Выписка по счёту 20208000100438330001"],
        [],
        ["Дата", "Контрагент", "Дебет", "Кредит", "Назначение"],
        ["05.01.2026", "ООО Тест", "", "1 500 000,00", "Оплата по договору №3"],
        ["2026-01-20", "ИП Каримов", "250 000,50", "", "Покупка"],
        ["03.02.2026", "ООО Тест", "", "2 000 000", "Оплата"],
        ["15.02.2026", "AQUA-PRODUCTS IMPORT", "100", "", "Комиссия банка"],
      ],
    },
  ],
};

describe("attached tables", () => {
  it("reads numbers, dates and CSV the way Uzbek banks and 1C write them", () => {
    expect(parseNumber("1 500 000,00")).toBe(1_500_000);
    expect(parseNumber("1,234,567.89")).toBe(1_234_567.89);
    expect(parseNumber("-500")).toBe(-500);
    expect(parseNumber("Оплата")).toBeNaN();
    expect(parseDate("05.01.2026")).toBe("2026-01-05");
    expect(parseDate("2026-01-20T10:00:00")).toBe("2026-01-20");
    expect(parseDate("abc")).toBeNull();
    expect(parseCsv('Дата;Сумма;Назначение\n05.01.2026;"1 500,00";"Оплата; по ""договору"""\r\n')).toEqual([
      ["Дата", "Сумма", "Назначение"],
      ["05.01.2026", "1 500,00", 'Оплата; по "договору"'],
    ]);
    expect([0, 25, 26, 27, 701].map(columnLetter)).toEqual(["A", "Z", "AA", "AB", "ZZ"]);
  });

  it("shows a small table whole, and a large one as its start and end", () => {
    const small = describeTable(statement);
    expect(small.whole).toBe(true);
    expect(small.text).toContain("row\tA\tB\tC\tD\tE");
    expect(small.text).toContain("4\t05.01.2026\tООО Тест\t\t1 500 000,00\tОплата по договору №3");

    const rows = Array.from({ length: 5000 }, (_, i) => [`${i + 1}`, "x".repeat(30)]);
    const large = describeTable({ name: "big.csv", sheets: [{ name: "big", rows }] });
    expect(large.whole).toBe(false);
    expect(large.text.length).toBeLessThan(INLINE_CHARS / 10);
    expect(large.text).toContain("40\t40\t");
    expect(large.text).toContain("5000\t5000\t");
    expect(large.text).not.toContain("\n41\t41\t");
  });

  it("lists, filters, groups by month and totals over the whole file", () => {
    const totals = readTable([statement], {
      file: "выписка.XLSX",
      from: 4,
      group_by: { column: "A", by: "month" },
      sum: ["C", "D"],
    });
    expect(totals).toMatchObject({
      ok: true,
      data: {
        matchedRows: 4,
        groups: [
          ["2026-01", 2, 250_000.5, 1_500_000],
          ["2026-02", 2, 100, 2_000_000],
        ],
      },
    });

    const filtered = readTable([statement], {
      file: "Выписка.xlsx",
      where: [
        { column: "B", op: "contains", value: "тест" },
        { column: "D", op: ">", value: "1 600 000" },
      ],
      columns: ["A", "D"],
    });
    expect(filtered).toMatchObject({
      ok: true,
      data: { matchedRows: 1, columns: ["row", "A", "D"], rows: [[6, "03.02.2026", "2 000 000"]] },
    });

    const page = readTable([statement], { file: "Выписка.xlsx", from: 3, limit: 2 });
    expect(page).toMatchObject({ ok: true, data: { matchedRows: 5, more: 3, next: "from 5" } });

    const byDate = readTable([statement], {
      file: "Выписка.xlsx",
      where: [{ column: "A", op: ">=", value: "2026-02-01" }],
      sum: ["D"],
    });
    expect(byDate).toMatchObject({ ok: true, data: { groups: [["all", 2, 2_000_000]] } });
  });

  it("says which files and sheets there are when asked for a missing one", () => {
    expect(readTable([statement], { file: "other.xlsx" })).toMatchObject({
      ok: false,
      code: "FILE_NOT_FOUND",
      message: expect.stringContaining("Выписка.xlsx"),
    });
    expect(readTable([statement], { file: "Выписка.xlsx", sheet: "Лист9" })).toMatchObject({
      ok: false,
      code: "SHEET_NOT_FOUND",
      message: expect.stringContaining("Лист1"),
    });
  });
});
