import { describe, expect, it } from "vitest";

import { describeRepeats, rereadStatements } from "./reread.js";
import type { BankPayment, BankStatement } from "./statement.js";

const MAIN = "20208000705733821001";
const BLOCK = "22613000405733821001";

const pay = (row: number, over: Partial<BankPayment> = {}): BankPayment => ({
  row,
  date: "2024-01-08",
  number: "1",
  direction: "out",
  amount: 12_446_000_000,
  counterparty: "OWN LLC",
  inn: "311012912",
  account: BLOCK,
  mfo: "01082",
  purpose: "Блокировка средств",
  ...over,
});
const file = (name: string, account: string, payments: BankPayment[]): BankStatement => ({
  fileName: name,
  sheet: "1",
  account,
  columns: {},
  convention: "",
  payments,
  issues: [],
});

describe("a row met a second time in statements of the same account", () => {
  it("is kept once, by the first file, and the second meeting is told", () => {
    const a = file("a.xlsx", MAIN, [pay(7), pay(8, { amount: 1_000, number: "2" })]);
    const b = file("b.xlsx", MAIN, [pay(3), pay(4, { amount: 5_000, number: "3" })]);
    const { statements, repeats } = rereadStatements([a, b]);
    expect(statements[0]?.payments).toHaveLength(2);
    expect(statements[1]?.payments.map((p) => p.row)).toEqual([4]);
    expect(repeats).toEqual([{ file: "b.xlsx", row: 3, firstFile: "a.xlsx", firstRow: 7 }]);
    expect(describeRepeats(repeats)).toContain("b.xlsx row 3 = a.xlsx row 7");
  });

  it("is also the same row when a third file carries it again", () => {
    const files = ["a", "b", "c"].map((n) => file(`${n}.xlsx`, MAIN, [pay(1)]));
    const { statements, repeats } = rereadStatements(files);
    expect(statements.map((s) => s.payments.length)).toEqual([1, 0, 0]);
    expect(repeats).toHaveLength(2);
  });

  it("two equal rows inside one file are two payments, and a later file takes away only as many as the first holds", () => {
    const a = file("a.xlsx", MAIN, [pay(1), pay(2)]);
    const b = file("b.xlsx", MAIN, [pay(1), pay(2), pay(3)]);
    const { statements, repeats } = rereadStatements([a, b]);
    expect(statements[0]?.payments).toHaveLength(2);
    expect(statements[1]?.payments.map((p) => p.row)).toEqual([3]);
    expect(repeats).toHaveLength(2);
  });

  it("leaves statements of different accounts alone: the other side of a move is not a repeat", () => {
    const main = file("main.xlsx", MAIN, [pay(7)]);
    const block = file("block.xlsx", BLOCK, [pay(1, { direction: "in", account: MAIN })]);
    const { statements, repeats } = rereadStatements([main, block]);
    expect(repeats).toEqual([]);
    expect(statements[0]).toBe(main);
    expect(statements[1]).toBe(block);
  });

  it("rows that differ in the number, the amount, the day or the purpose are different rows", () => {
    const a = file("a.xlsx", MAIN, [pay(1)]);
    const b = file("b.xlsx", MAIN, [
      pay(1, { number: "9" }),
      pay(2, { amount: 1 }),
      pay(3, { date: "2024-01-09" }),
      pay(4, { purpose: "Возврат" }),
    ]);
    expect(rereadStatements([a, b]).repeats).toEqual([]);
  });
});
