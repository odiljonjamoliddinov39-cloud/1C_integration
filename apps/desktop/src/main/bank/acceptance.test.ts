import { describe, expect, it } from "vitest";

import { acceptance, acceptanceText } from "./acceptance.js";
import type { BankPayment, BankStatement } from "./statement.js";

const MAIN = "20208000705733821001";
const BLOCK = "22613000405733821001";

const pay = (over: Partial<BankPayment>): BankPayment => ({
  row: 1,
  date: "2024-03-01",
  number: "1",
  direction: "out",
  amount: 100_000,
  counterparty: "X",
  inn: "301122334",
  account: "20208000900000000001",
  mfo: "00444",
  purpose: "Оплата по договору TI-01 от 01.02.2024",
  ...over,
});

const statement = (
  account: string,
  fileName: string,
  payments: BankPayment[],
  balances?: { opening: number; closing: number },
): BankStatement =>
  ({
    fileName,
    sheet: "s",
    account,
    payments,
    issues: [],
    columns: {},
    convention: "",
    balances,
  }) as BankStatement;

describe("the acceptance run", () => {
  const main = statement(
    MAIN,
    "main.xlsx",
    [
      pay({ row: 1, account: "16401000105733821001", amount: 100_000, purpose: "Тариф, в том числе НДС" }),
      pay({
        row: 2,
        account: "23402000900000000001",
        amount: 5_700_000,
        purpose: "~1000228605062193141102093~Задолженность по Налог на добавленную стоимость",
      }),
      pay({
        row: 3,
        account: "23402000900000000001",
        amount: 1_000_000,
        purpose: "Оплата за 46 Налог на доходы физических лиц",
      }),
      pay({ row: 4, purpose: "" }),
      pay({ row: 5, direction: "in", amount: 9_000_000 }),
    ],
    { opening: 0, closing: 9_000_000 - 100_000 - 5_700_000 - 1_000_000 - 100_000 },
  );

  it("counts the commissions, the payments to the budget and the VAT, and holds back the line with no text", () => {
    const a = acceptance([main]);
    expect(a.fees).toEqual({ lines: 1, sum: 100_000 });
    expect(a.budget).toEqual({ lines: 2, sum: 6_700_000, vat: { lines: 1, sum: 5_700_000 } });
    expect(a.accounts[0]?.balancesAgree).toBe(true);
    expect(a.held.map((h) => [h.row, h.confidence])).toEqual([[4, "low"]]);
    expect(acceptanceText(a)).toContain("Bank commissions: 1 lines");
  });

  it("checks that the money blocked for conversions is sold or returned, and that the account ends at zero", () => {
    const block = statement(
      BLOCK,
      "block.xlsx",
      [
        pay({
          row: 1,
          direction: "in",
          amount: 1_000_000,
          account: MAIN,
          purpose: "Блокировка средств для конвертации",
        }),
        pay({
          row: 2,
          direction: "out",
          amount: 700_000,
          account: "17101840400001082944",
          purpose: "Конвертация валютных средств 56.0 'Доллар США' по курсу 12500.0",
        }),
        pay({ row: 3, direction: "out", amount: 300_000, account: MAIN, purpose: "Возврат блокировки" }),
      ],
      { opening: 0, closing: 0 },
    );
    const [b] = acceptance([main, block]).blocked;
    expect(b).toMatchObject({
      blocked: 1_000_000,
      sold: 700_000,
      returned: 300_000,
      agrees: true,
      endsAtZero: true,
    });
    const broken = statement(BLOCK, "block.xlsx", [
      pay({ row: 1, direction: "in", amount: 1_000_000, account: MAIN, purpose: "Блокировка" }),
    ]);
    expect(acceptance([main, broken]).blocked[0]?.agrees).toBe(false);
  });
});
