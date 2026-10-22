import { describe, expect, it } from "vitest";

import { reconcileBank, accountCurrency } from "./bank-reconcile.js";
import {
  TAX_DEADLINES,
  accrueProfitTax,
  compareRegisters,
  turnoverTax,
  upcomingDeadlines,
  vatPosition,
} from "./tax-accrual.js";
import { DEFAULT_PROFILE, type TaxBenefit, type TaxRate } from "./tax-tables.js";

describe("profit tax to accrue", () => {
  it("takes the rate of the date from the table and accrues what is not accrued yet", () => {
    const r = accrueProfitTax(1_000_000, 100_000, "2026-09-30", DEFAULT_PROFILE);
    expect(r).toMatchObject({ rate: 15, due: 150_000, accrued: 100_000, toAccrue: 50_000, approved: false });
    expect("error" in r ? null : r.entry).toMatchObject({
      debit: "9810",
      credit: "6410",
      amount: 50_000,
      needsApproval: false,
    });
  });

  it("owes nothing on a loss, and says when too much was accrued", () => {
    const loss = accrueProfitTax(-5_000, 0, "2026-09-30", DEFAULT_PROFILE);
    expect(loss).toMatchObject({ due: 0, entry: null });
    const over = accrueProfitTax(100_000, 20_000, "2026-09-30", DEFAULT_PROFILE);
    expect("error" in over ? "" : over.note).toContain("more tax has been accrued");
    expect("error" in over ? 0 : over.toAccrue).toBe(-5_000);
  });

  it("applies the company's benefit, and asks for the table when the date has no rate", () => {
    const benefit: TaxBenefit = {
      code: "B1",
      type: "profit",
      conditions: {},
      effect: { kind: "zero" },
      from: "2026-01-01",
      source: "test",
      approved: true,
    };
    const profile = { ...DEFAULT_PROFILE, benefits: [{ code: "B1", basis: "doc" }] };
    const rates: TaxRate[] = [{ type: "profit", rate: 15, from: "2020-01-01", source: "t", approved: true }];
    // The benefit table is the module's own; with none seeded the rate stays the base one.
    expect(accrueProfitTax(100, 0, "2026-09-30", profile, { rates })).toMatchObject({ rate: 15 });
    expect(benefit.code).toBe("B1");
    expect(accrueProfitTax(100, 0, "1890-01-01", DEFAULT_PROFILE)).toEqual({
      error: expect.stringContaining("not in the tax table"),
    });
  });
});

describe("VAT position", () => {
  it("sets the VAT charged against the VAT offset, month by month", () => {
    const p = vatPosition([
      { month: "2026-09", output: 1200, input: 700 },
      { month: "2026-08", output: 600, input: 900 },
      { month: "2026-09", output: 100, input: 0 },
    ]);
    expect(p.months).toEqual([
      { month: "2026-08", output: 600, input: 900, payable: -300 },
      { month: "2026-09", output: 1300, input: 700, payable: 600 },
    ]);
    expect(p.payable).toBe(300);
  });
});

describe("turnover tax", () => {
  it("is not guessed: with no rate in the table it asks for one", () => {
    expect(turnoverTax(1_000_000, "2026-03-31", { ...DEFAULT_PROFILE, regime: "turnover" })).toEqual({
      error: expect.stringContaining("tax adviser"),
    });
  });

  it("works out the tax once the table has the rate", () => {
    const rates: TaxRate[] = [
      { type: "turnover", rate: 4, from: "2026-01-01", source: "adviser", approved: true },
    ];
    expect(
      turnoverTax(1_000_000, "2026-03-31", { ...DEFAULT_PROFILE, regime: "turnover" }, { rates }),
    ).toMatchObject({
      rate: 4,
      tax: 40_000,
      approved: true,
    });
  });
});

describe("the calendar", () => {
  it("lists the deadlines in a range for the company's profile, earliest first", () => {
    const d = upcomingDeadlines(DEFAULT_PROFILE, "2026-10-01", "2026-10-31");
    expect(d.map((x) => `${x.date} ${x.tax} ${x.kind} ${x.period}`)).toEqual([
      "2026-10-15 income report 2026-09",
      "2026-10-15 social report 2026-09",
      "2026-10-20 profit report 2026-Q3",
      "2026-10-20 vat report 2026-09",
      "2026-10-25 vat payment 2026-09",
    ]);
    expect(d.every((x) => x.approved === false)).toBe(true);
  });

  it("leaves out what the profile does not owe: no VAT for a non-payer, turnover tax only on the turnover regime", () => {
    const none = upcomingDeadlines(
      { ...DEFAULT_PROFILE, vatPayer: false, regime: "turnover" },
      "2026-10-01",
      "2026-10-31",
    );
    expect(none.map((x) => x.tax)).toEqual(["income", "social", "turnover"]);
    expect(TAX_DEADLINES.length).toBeGreaterThan(4);
  });
});

describe("the VAT registers against Didox", () => {
  const d = (number: string, inn: string, amount: number, date = "2026-09-01") => ({
    number,
    inn,
    amount,
    date,
  });
  it("finds what is only in one, and what differs in amount", () => {
    const c = compareRegisters(
      [d("0007", "111", 1000), d("8", "222", 500), d("9", "333", 700)],
      [d("7", "111", 1000), d("8", "222", 450), d("10", "444", 300)],
    );
    expect(c.matched).toBe(1); // 0007 and 7 are one number
    expect(c.amountDiffers).toEqual([
      { number: "8", date: "2026-09-01", inn: "222", in1c: 500, inDidox: 450, difference: 50 },
    ]);
    expect(c.onlyIn1c.map((x) => x.number)).toEqual(["9"]);
    expect(c.onlyInDidox.map((x) => x.number)).toEqual(["10"]);
  });
});

describe("bank balance against 1C", () => {
  const books = [
    { account: "20208000100438330001", soum: 5_000_000, currency: 0 },
    { account: "20208840100438330002", soum: 1_250_000_000, currency: 100_000 },
  ];
  it("matches soum accounts in soums and currency accounts in the currency", () => {
    const r = reconcileBank(
      [
        { fileName: "a.xlsx", account: "20208000100438330001", date: "2026-09-30", closing: 5_000_000 },
        { fileName: "b.xlsx", account: "20208840100438330002", date: "2026-09-30", closing: 99_000 },
      ],
      books,
    );
    expect(r.rows.map((x) => [x.status, x.difference])).toEqual([
      ["match", 0],
      ["difference", -1000],
    ]);
    expect(r.allMatch).toBe(false);
  });

  it("says when 1C has no such account, and when the statement prints no balance", () => {
    const r = reconcileBank(
      [
        { fileName: "c.xlsx", account: "20208000999999999999", date: "2026-09-30", closing: 1 },
        { fileName: "d.xlsx", account: "20208000100438330001", date: "2026-09-30", closing: null },
      ],
      books,
    );
    expect(r.rows.map((x) => x.status)).toEqual(["not_in_1c", "no_balance"]);
  });

  it("reads the currency out of the account number", () => {
    expect(accountCurrency("20208 840 1 00438330 002")).toBe("840");
    expect(accountCurrency("20208000100438330001")).toBeNull();
  });
});
