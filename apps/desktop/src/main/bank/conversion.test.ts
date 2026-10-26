import { describe, expect, it } from "vitest";

import { findConversions, fxText } from "./conversion.js";
import type { BankPayment, BankStatement } from "./statement.js";

const MAIN = "20208000705733821001";
const BLOCK = "22613000405733821001";
const USD = "22614840505733821001";

const statement = (account: string, fileName: string, payments: BankPayment[]): BankStatement =>
  ({ fileName, sheet: "s", account, payments, issues: [], columns: {}, convention: "" }) as BankStatement;

const pay = (over: Partial<BankPayment>): BankPayment => ({
  row: 1,
  date: "2024-01-25",
  number: "1",
  direction: "out",
  amount: 0,
  counterparty: "Продажа иностр валюты",
  inn: "207117389",
  account: "17101840400001082944",
  mfo: "01082",
  purpose: "",
  ...over,
});

describe("the bank's conversion text", () => {
  it.each([
    [
      "Без комиссии Конвертация валютных средств 4165.0 'Доллар США' по курсу 12484.0 МФО - 01082",
      4165,
      "USD",
      12484,
    ],
    [
      "02 - Конвертация валютных средств 866656.01 RUB  по курсу 162.48 МФО - 01082 Счет - 22614643905733821001",
      866656.01,
      "RUB",
      162.48,
    ],
    ["00668 Конвертация валютных средств 6080.0 'Доллар США'  по курсу 12596", 6080, "USD", 12596],
    ["01 - Конвертация валютных средств 8 000.00 USD по курсу 12869 МФО", 8000, "USD", 12869],
  ])("%s", (text, amount, currency, rate) => {
    expect(fxText(text)).toEqual({ amount, currency, rate });
  });

  it("is null for any other text", () => {
    expect(fxText("Блокировка средств для конвертации по контракту № KQ-TI-01 от 01.01.2024")).toBeNull();
    expect(fxText("Оплата по договору")).toBeNull();
  });
});

describe("a purchase and a sale of currency, paired by what the bank wrote", () => {
  const buyText =
    "Без комиссии Конвертация валютных средств 4165.0 'Доллар США' по курсу 12484.0 МФО - 01082";
  const sellText = "Конвертация валютных средств 6080.0 'Доллар США'  по курсу 12596 МФО - 01082";

  const block = statement(BLOCK, "block.xlsx", [
    // 4165 × 12484 = 51 995 860: the soums the block account paid for the dollars
    pay({ row: 5, amount: 5_199_586_000, direction: "out", purpose: buyText }),
    pay({ row: 6, date: "2024-04-03", amount: 100, direction: "out", purpose: "Блокировка средств" }),
  ]);
  const usd = statement(USD, "usd.xlsx", [
    pay({ row: 2, amount: 416_500, direction: "in", purpose: buyText }),
    // the sale: the dollars leave, the soums come to the main account
    pay({
      row: 6,
      date: "2024-04-03",
      number: "52640892",
      amount: 608_000,
      direction: "out",
      purpose: sellText,
    }),
  ]);
  const main = statement(MAIN, "main.xlsx", [
    pay({ row: 9, date: "2024-04-03", amount: 7_658_368_000, direction: "in", purpose: sellText }),
  ]);

  it("pairs each purchase and each sale with its own other leg", () => {
    const { conversions, consumed, alone } = findConversions([block, usd, main]);
    expect(conversions.map((c) => [c.direction, c.currency, c.amount, c.rate])).toEqual([
      ["buy", "USD", 4165, 12484],
      ["sell", "USD", 6080, 12596],
    ]);
    const [buy, sell] = conversions;
    expect(buy?.soum).toMatchObject({ file: "block.xlsx", row: 5 });
    expect(buy?.foreign).toMatchObject({ file: "usd.xlsx", row: 2 });
    expect(sell?.soum).toMatchObject({ file: "main.xlsx", row: 9 });
    expect(sell?.foreign).toMatchObject({ file: "usd.xlsx", row: 6 });
    expect(consumed.size).toBe(4);
    expect(alone).toEqual([]);
    expect(buy?.id).toMatch(/^FX-2024-01-25-USD-4165-/);
  });

  it("leaves a leg whose other leg is not attached, and one that does not agree on the amount", () => {
    const only = findConversions([usd]);
    expect(only.conversions).toEqual([]);
    expect(only.alone).toHaveLength(2);
    const off = statement(BLOCK, "block.xlsx", [
      pay({ row: 5, amount: 5_199_586_000, direction: "out", purpose: buyText.replace("4165.0", "4166.0") }),
    ]);
    expect(findConversions([off, usd]).conversions).toEqual([]);
  });

  it("does not pair a purchase with a sale: the soum side must be the opposite way", () => {
    const wrong = statement(BLOCK, "block.xlsx", [
      pay({ row: 5, amount: 5_199_586_000, direction: "in", purpose: buyText }),
    ]);
    expect(findConversions([wrong, usd]).conversions).toEqual([]);
  });
});

describe("the soums of a conversion are the foreign amount times the rate", () => {
  const text = "Конвертация валютных средств 4165.0 'Доллар США' по курсу 12484.0";
  const legs = (soums: number) => [
    statement(MAIN, "main.xlsx", [
      pay({ row: 1, direction: "out", amount: soums, account: "17101000900001082944", purpose: text }),
    ]),
    statement(USD, "usd.xlsx", [
      pay({ row: 1, direction: "in", amount: 416_500, account: "17101840400001082944", purpose: text }),
    ]),
  ];

  it("pairs a conversion whose sides agree: 4165 × 12484 = 51 995 860", () => {
    const found = findConversions(legs(5_199_586_000));
    expect(found.conversions).toHaveLength(1);
    expect(found.mismatched).toEqual([]);
  });

  it("does not pair one whose sides disagree, and says what the soums should have been", () => {
    const found = findConversions(legs(5_199_586_000 + 5_000_000));
    expect(found.conversions).toEqual([]);
    expect(found.mismatched).toHaveLength(1);
    expect(found.mismatched[0]?.expected).toBe(5_199_586_000);
  });
});
