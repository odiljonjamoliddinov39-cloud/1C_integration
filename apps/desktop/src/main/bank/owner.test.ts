import { describe, expect, it } from "vitest";

import { foreignStatements, statementOwners } from "./owner.js";
import type { BankPayment, BankStatement } from "./statement.js";

const MAIN = "20208000705733821001";
const FEE = "16401000105733821001";

const pay = (over: Partial<BankPayment>): BankPayment => ({
  row: 1,
  date: "2024-01-16",
  number: "1",
  direction: "out",
  amount: 112_000,
  counterparty: "TEXMASH IMPORT MCHJ",
  inn: "311012912",
  account: FEE,
  mfo: "01082",
  purpose: "fee",
  ...over,
});

const statement = (fileName: string, account: string, payments: BankPayment[]): BankStatement => ({
  fileName,
  sheet: "s",
  account,
  payments,
  issues: [],
  columns: {},
  convention: "",
});

const set = [
  statement("main.xlsx", MAIN, [
    pay({ row: 1 }),
    pay({ row: 2 }),
    pay({ row: 3, inn: "310740640", account: "20208000605689898001", counterparty: "TASHBURMASH" }),
  ]),
  statement("fee.xlsx", FEE, [pay({ row: 1, direction: "in", account: MAIN })]),
];

describe("whose statement it is", () => {
  it("reads the owner's INN from the lines to the company's own attached accounts", () => {
    expect(statementOwners(set).get("main.xlsx")).toEqual({ inn: "311012912", lines: 2 });
    expect(statementOwners(set).get("fee.xlsx")).toEqual({ inn: "311012912", lines: 1 });
  });

  it("is quiet when the statements are the selected company's", () => {
    expect(foreignStatements(set, "311012912")).toEqual([]);
  });

  it("names the statements of another company, whichever company is selected", () => {
    expect(foreignStatements(set, "300000001").map((m) => [m.file, m.statementInn])).toEqual([
      ["main.xlsx", "311012912"],
      ["fee.xlsx", "311012912"],
    ]);
  });

  it("says nothing when the statement has no line to an own account (nothing to judge by)", () => {
    expect(
      foreignStatements(
        [statement("solo.xlsx", MAIN, [pay({ account: "20208000605689898001" })])],
        "300000001",
      ),
    ).toEqual([]);
  });

  it("ignores a company INN that is not nine digits", () => {
    expect(foreignStatements(set, "")).toEqual([]);
  });
});
