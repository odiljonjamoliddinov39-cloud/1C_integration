import { describe, expect, it } from "vitest";

import { gate } from "./classify.js";
import { documentOfLine, previewOfBank, rowIsOfKind } from "./preview.js";
import type { BankPayment, BankStatement } from "./statement.js";

const MAIN = "20208000705733821001";

const pay = (over: Partial<BankPayment>): BankPayment => ({
  row: 1,
  date: "2024-03-01",
  number: "1",
  direction: "out",
  amount: 100_000_00,
  counterparty: "ООО Ромашка",
  inn: "301122334",
  account: "20208000900000000001",
  mfo: "00444",
  purpose: "Оплата по договору TI-01 от 01.02.2024 за товар",
  ...over,
});

// A small statement with the three kinds that matter on the day: a supplier, a tax and a fee.
const statement = {
  fileName: "main.xlsx",
  sheet: "s",
  account: MAIN,
  payments: [
    pay({ row: 12, purpose: "Оплата по договору TI-01 от 01.02.2024 за товар" }),
    pay({
      row: 13,
      direction: "in",
      counterparty: "ООО Лотос",
      purpose: "Оплата по договору TI-02 от 01.02.2024",
    }),
    pay({
      row: 14,
      amount: 5_039_333_86,
      counterparty: "Казначейство Министерства финансов",
      account: "23402000900000000001",
      purpose: "Оплата за 46 НДФЛ за февраль 2024",
    }),
    pay({
      row: 15,
      amount: 1_120_00,
      counterparty: "TEXMASH IMPORT MCHJ",
      account: "16401000105733821001",
      purpose: "За iBank-24-1120.00, за iBank-24 (внутри банка)",
    }),
  ],
  issues: [],
  columns: {},
  convention: "",
} as unknown as BankStatement;

const rows = statement.payments.map((p) => p.row);
const read = () => gate(statement, rows, new Set([MAIN]));

describe("only the kinds asked for", () => {
  it("keeps the tax payment and nothing else when the kind is tax", () => {
    const { allowed, classes } = read();
    expect(allowed).toEqual([12, 13, 14, 15]);
    const kinds = new Set(["tax"]);
    expect(allowed.filter((row) => rowIsOfKind(classes, row, kinds))).toEqual([14]);
  });

  it("keeps every line when no kind is asked for", () => {
    const { allowed, classes } = read();
    expect(allowed.filter((row) => rowIsOfKind(classes, row, null))).toEqual(allowed);
  });

  it("drops a row the program did not classify", () => {
    const { classes } = read();
    expect(rowIsOfKind(classes, 999, new Set(["tax"]))).toBe(false);
  });
});

describe("the preview lists what would be entered and writes nothing", () => {
  const { allowed, classes } = read();
  const kinds = new Set(["tax"]);
  const only = allowed.filter((row) => rowIsOfKind(classes, row, kinds));
  const preview = previewOfBank(
    [{ statement, rows: only, currency: "UZS" }],
    new Map([[statement.fileName, classes]]),
    [],
    0,
    kinds,
  );

  it("says nothing was written", () => {
    expect(preview.status).toBe("preview");
    expect(preview.wrote).toMatch(/^nothing/);
  });

  it("counts and lists the tax line with its kind, amount and document", () => {
    expect(preview.count).toBe(1);
    expect(preview.byKind).toEqual({ tax: 1 });
    expect(preview.lines).toHaveLength(1);
    expect(preview.lines[0]).toMatchObject({
      row: 14,
      kind: "tax",
      amount: "5039333.86",
      direction: "out",
      document: expect.stringContaining("Уплата налога"),
    });
  });

  it("is the whole statement when no kind is asked for", () => {
    const all = previewOfBank(
      [{ statement, rows: allowed, currency: "UZS" }],
      new Map([[statement.fileName, classes]]),
      [],
      0,
      null,
    );
    expect(all.count).toBe(4);
    expect(Object.keys(all.byKind).sort()).toEqual(["bank_fee", "contract_payment", "tax"]);
  });

  it("names the 1C document by the direction of the money", () => {
    expect(documentOfLine("contract_payment", "in")).toBe("Поступление на расчетный счет");
    expect(documentOfLine("contract_payment", "out")).toBe("Списание с расчетного счета");
  });
});
