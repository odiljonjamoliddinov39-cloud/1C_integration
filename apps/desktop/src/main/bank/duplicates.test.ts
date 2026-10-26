import { describe, expect, it } from "vitest";

import { type BankDoc, findDuplicates } from "./duplicates.js";
import type { BankPayment, BankStatement } from "./statement.js";

const MAIN = "20208000705733821001";
const BLOCK = "22613000405733821001";

const pay = (over: Partial<BankPayment>): BankPayment => ({
  row: 1,
  date: "2024-01-18",
  number: "101",
  direction: "out",
  amount: 124_460_000_00,
  counterparty: "x",
  inn: "",
  account: BLOCK,
  mfo: "",
  purpose: "Блокировка средств для конвертации",
  ...over,
});

const statement = (account: string, payments: BankPayment[]): BankStatement => ({
  fileName: `${account}.xlsx`,
  sheet: "s",
  account,
  payments,
  issues: [],
  columns: {},
  convention: "",
});

const doc = (over: Partial<BankDoc>): BankDoc => ({
  object: "Документ.СписаниеСРасчетногоСчета",
  ref: "r",
  number: "0000-000000000001",
  day: "2024-01-18",
  cents: 124_460_000_00,
  posted: true,
  kind: "Перевод на другой счет организации",
  account: MAIN,
  incoming: "",
  counterparty: "",
  direction: "out",
  ...over,
});

describe("bank documents 1C has more than once", () => {
  it("a row the statement lists once and 1C has twice, in two kinds of document: the later copy is the extra one", () => {
    const report = findDuplicates(
      [statement(MAIN, [pay({ account: BLOCK })])],
      [
        doc({ ref: "a", number: "0000-000000000384", kind: "Прочее списание" }),
        doc({ ref: "b", number: "0000-000000000410" }),
      ],
    );
    expect(report.groups).toHaveLength(1);
    expect(report.extra.map((d) => d.ref)).toEqual(["b"]);
    expect(report.checked).toMatchObject({ statementRows: 1, documents: 2, missing: 0 });
  });

  it("the document that carries the row's bank number stays, then a posted one", () => {
    const rows = [pay({ number: "555" })];
    const byNumber = findDuplicates(
      [statement(MAIN, rows)],
      [doc({ ref: "old", number: "1" }), doc({ ref: "mine", number: "2", incoming: "555" })],
    );
    expect(byNumber.extra.map((d) => d.ref)).toEqual(["old"]);
    const byPosting = findDuplicates(
      [statement(MAIN, [pay({ number: "" })])],
      [doc({ ref: "draft", number: "1", posted: false }), doc({ ref: "posted", number: "2" })],
    );
    expect(byPosting.extra.map((d) => d.ref)).toEqual(["draft"]);
  });

  it("two equal rows of the statement stand for two documents; a third is the extra one", () => {
    const two = [pay({ row: 1, number: "1" }), pay({ row: 2, number: "2" })];
    const docs = ["1", "2", "3"].map((n) => doc({ ref: n, number: `0000-00000000000${n}` }));
    const report = findDuplicates([statement(MAIN, two)], docs);
    expect(report.extra.map((d) => d.ref)).toEqual(["3"]);
    expect(findDuplicates([statement(MAIN, two)], docs.slice(0, 2)).groups).toEqual([]);
  });

  it("judges only what the statements stand behind: other accounts, and documents no row stands behind, are left alone", () => {
    const report = findDuplicates(
      [statement(MAIN, [pay({})])],
      [
        doc({ ref: "ok" }),
        doc({ ref: "split", cents: 100 }),
        doc({ ref: "other", account: "20208000999999999999" }),
        doc({ ref: "none", account: "" }),
      ],
    );
    expect(report.groups).toEqual([]);
    expect(report.checked).toMatchObject({ unjudged: 2, withoutRow: 1, missing: 0 });
  });

  it("counts the rows 1C has too few documents for", () => {
    const report = findDuplicates([statement(MAIN, [pay({})])], []);
    expect(report.checked.missing).toBe(1);
  });
});
