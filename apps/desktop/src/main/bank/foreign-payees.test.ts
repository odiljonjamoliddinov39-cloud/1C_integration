import type { RunQueryInput } from "@platform/shared";
import { describe, expect, it } from "vitest";

import { matchPayees } from "./foreign-payees.js";
import type { BankDeps } from "./resolve.js";
import type { BankPayment, BankStatement } from "./statement.js";

const BC =
  "BC: /100816681574  ACME GREAT DRILL BITS CO LTD  NO 2 JIANSH OC: /22614840505733821001  EXAMPLE IMPORT LLC  R KAGAN MSG GEOFI PD:PREPAYMENT PER CONTRACT GR-TI-01 D  .D. 30.01.2024 FOR SUPPYING PDC BI  T 132MM";

const swift = (row: number, purpose = BC): BankPayment => ({
  row,
  date: "2024-11-26",
  number: String(row),
  direction: "out",
  amount: 870_000,
  counterparty: "К получению с Головного Офиса - Долларов США",
  inn: "207117389",
  account: "16103840000001082001",
  mfo: "01082",
  purpose,
});

const statement = (payments: BankPayment[]): BankStatement => ({
  fileName: "usd.xlsx",
  sheet: "s",
  account: "22614840505733821001",
  payments,
  issues: [],
  columns: {},
  convention: "",
});

const deps = (names: string[]): { d: BankDeps; seen: RunQueryInput[] } => {
  const seen: RunQueryInput[] = [];
  return {
    seen,
    d: {
      async query(input) {
        seen.push(input);
        return { ok: true, data: { rows: names.map((n) => [n]) } };
      },
      async describe() {
        return { ok: true, data: [] };
      },
      async getObject() {
        return { ok: false, code: "X", message: "none" };
      },
    },
  };
};

describe("the beneficiaries of a currency account's SWIFT payments", () => {
  it("are looked up by their first word and written with 1C's own spelling of the name", async () => {
    const { d, seen } = deps(["ACME GREAT DRILL BITS CO., LTD", "ACME TRADING"]);
    const out = await matchPayees(d, statement([swift(1), swift(2)]));
    expect(out.found).toBe(2);
    expect(out.statement.payments.map((p) => p.counterparty)).toEqual([
      "ACME GREAT DRILL BITS CO., LTD",
      "ACME GREAT DRILL BITS CO., LTD",
    ]);
    // one question for the two payments to the same beneficiary
    expect(seen).toHaveLength(1);
    expect(seen[0]?.params).toMatchObject({ п0: "%ACME%" });
  });

  it("keeps the bank's spelling for a beneficiary 1C does not have, and says so", async () => {
    const { d } = deps(["OTHER TRADING CO"]);
    const out = await matchPayees(d, statement([swift(1)]));
    expect(out.found).toBe(0);
    expect(out.unknown).toEqual(["ACME GREAT DRILL BITS CO LTD"]);
    expect(out.statement.payments[0]?.counterparty).toBe("ACME GREAT DRILL BITS CO LTD");
  });

  it("does not choose between two counterparties that could be the beneficiary", async () => {
    const { d } = deps(["ACME GREAT DRILL BITS CO., LTD", "ACME GREAT DRILL BITS CO., LTD (old)"]);
    const out = await matchPayees(d, statement([swift(1)]));
    expect(out.found).toBe(0);
    expect(out.ambiguous).toHaveLength(1);
    expect(out.ambiguous[0]?.candidates).toHaveLength(2);
  });

  it("asks 1C nothing when the statement has no SWIFT payment", async () => {
    const { d, seen } = deps([]);
    const plain = statement([swift(1, "Оплата по договору")]);
    const out = await matchPayees(d, plain);
    expect(out.statement).toBe(plain);
    expect(seen).toEqual([]);
  });
});
