import { describe, expect, it } from "vitest";

import { DEFAULT_TABLE, classifyLine, effectiveTable, gate } from "./classify.js";
import type { BankPayment, BankStatement } from "./statement.js";

const MAIN = "20208000705733821001";
const ctx = { account: MAIN, own: new Set([MAIN, "22613000405733821001"]) };

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

const kind = (over: Partial<BankPayment>) => {
  const c = classifyLine(pay(over), ctx);
  return `${c.type}/${c.confidence}`;
};

describe("a line is read before it is written: the account says first, the text only breaks ties", () => {
  it("a commission to the bank's transit account is a fee, even when the text says VAT is included", () => {
    expect(
      kind({
        account: "16401000105733821001",
        purpose: 'За документ №48 S=100 000,00 Тариф-ТАРИФ "CORPORATE"-1 000,00 UZS.в том числе НДС',
      }),
    ).toBe("bank_fee/high");
    expect(
      kind({ account: "16413000505733821001", purpose: "Комиссия инобанка USD 15.00 по курсу 12594.85" }),
    ).toBe("bank_fee/high");
  });

  it("a payment to the treasury is a tax, by the text's own code, and the tax is named", () => {
    const vat = classifyLine(
      pay({
        account: "23402000900000000001",
        purpose: "~1000228605062193141102093~Задолженность по Налог на добавленную стоимость",
      }),
      ctx,
    );
    expect(vat).toMatchObject({ type: "tax", confidence: "high", tax: "vat" });
    const social = classifyLine(
      pay({ account: "22628000900000000001", purpose: "Оплата за 36 Ижтимоий соли? 2025йил март ойи" }),
      ctx,
    );
    expect(social).toMatchObject({ type: "tax", confidence: "high", tax: "social" });
    // a payment through the treasury account that is no tax goes to the list
    expect(kind({ account: "23402000900000000001", purpose: "для лицевого счета УГТК по г.Ташкенту" })).toBe(
      "tax/medium",
    );
  });

  it("the other kinds the bank's accounts say: customs, an individual's card, a conversion, a SWIFT payment", () => {
    expect(
      kind({ account: "29801000900000000001", purpose: "Оплата таможенных пошлин юридических лиц" }),
    ).toBe("customs/high");
    expect(
      kind({
        account: "23120000900000000001",
        purpose: "Оплата по договору TI-FB-05 от 18.12.2024г с Qodirov Farruh Bozorovich на поставку",
      }),
    ).toBe("individual_card/high");
    expect(kind({ account: "22613000405733821001", purpose: "Блокировка средств для конвертации" })).toBe(
      "conversion/high",
    );
    expect(
      kind({ account: "17101000900001082944", purpose: "Конвертация валютных средств 4165.0 'Доллар США'" }),
    ).toBe("conversion/high");
    expect(kind({ account: "16103000900001082001", purpose: "BC: /100816681574 ACME LTD OC: /226" })).toBe(
      "swift/high",
    );
  });

  it("a payment under a contract is found by the company's account and the contract in the text", () => {
    const c = classifyLine(pay({}), ctx);
    expect(c).toMatchObject({ type: "contract_payment", confidence: "high" });
    expect(c.why).toContain("TI-01");
    // any current account of a company (202xx), not only the ones seen
    expect(kind({ account: "20212000900000000001" })).toBe("contract_payment/high");
  });

  it("a terminal's takings are a terminal receipt", () => {
    expect(
      kind({
        direction: "in",
        amount: 483_610_84,
        account: "29898000900000000001",
        purpose:
          "SmartVista - Выручка 483,610.84 сум ( TID 30061802) от сумма: 484,580.00 в том числе комиссия (0.2%) 969.16",
      }),
    ).toBe("terminal_receipt/high");
  });

  it("an empty purpose is never written, whatever the account says", () => {
    expect(kind({ purpose: "" })).toBe("unknown/low");
    expect(kind({ purpose: "00668", account: "16401000105733821001" })).toBe("unknown/low");
  });

  it("holds back a text that points to another kind than the account, and an account the program does not know", () => {
    expect(kind({ purpose: "Комиссия за обслуживание, НДС 12%" })).toBe("contract_payment/medium");
    expect(kind({ account: "99999000900000000001", purpose: "Прочий платёж" })).toBe("unknown/medium");
    expect(kind({ account: "99999000900000000001", purpose: "Комиссия банка" })).toBe("bank_fee/medium");
    expect(
      kind({ account: "99999000900000000001", purpose: "Комиссия и налог на добавленную стоимость" }),
    ).toBe("unknown/low");
  });

  it("flags a foreign currency in the text of a soum account", () => {
    expect(kind({ purpose: "Оплата по договору 5 от 01.02.2024 на сумму 8000.00 USD" })).toBe(
      "contract_payment/low",
    );
  });

  it("a statement with no counterparty account is read by the INN and the name, but not a bank's own line", () => {
    expect(kind({ account: "" })).toBe("contract_payment/high");
    expect(kind({ account: "", counterparty: "Транзитный счёт МУНИС", inn: "207117389" })).toBe(
      "unknown/medium",
    );
  });
});

describe("what may be written", () => {
  const statement = {
    fileName: "main.xlsx",
    account: MAIN,
    payments: [
      pay({ row: 1 }),
      pay({ row: 2, purpose: "" }),
      pay({ row: 3, account: "16401000105733821001", purpose: "Тариф, в том числе НДС" }),
      pay({ row: 4, account: "99999000900000000001", purpose: "Прочий платёж" }),
    ],
    issues: [],
  } as unknown as BankStatement;

  it("lets the high-confidence lines through and holds the rest, with the reason", () => {
    const out = gate(statement, [1, 2, 3, 4], ctx.own);
    expect(out.allowed).toEqual([1, 3]);
    expect(out.held.map((h) => [h.row, h.confidence])).toEqual([
      [2, "low"],
      [4, "medium"],
    ]);
    expect(out.held[0]?.why).toContain(
      "no text is not written".replace("no text is", "line with no text is"),
    );
  });
});

describe("the table of counterparty accounts", () => {
  it("is the program's own until the accountant changes a row or adds one", () => {
    expect(effectiveTable()).toEqual(DEFAULT_TABLE);
    const table = effectiveTable([
      { prefix: "16401", type: "bank_fee", account: "9420" },
      { prefix: "29898", type: "terminal_receipt" },
    ]);
    expect(table.find((r) => r.prefix === "16401")?.account).toBe("9420");
    expect(table.find((r) => r.prefix === "29898")?.type).toBe("terminal_receipt");
    expect(table).toHaveLength(DEFAULT_TABLE.length + 1);
  });

  it("is what a line is read by: a row added by the accountant makes a known account of an unknown one", () => {
    const unknown = pay({ account: "29898000900000000001", purpose: "Эквайринг за март" });
    expect(classifyLine(unknown, ctx).confidence).toBe("medium");
    const table = effectiveTable([{ prefix: "29898", type: "customs" }]);
    expect(classifyLine(unknown, { ...ctx, table })).toMatchObject({ type: "customs", confidence: "high" });
  });
});

describe("cash paid in or out, and a founder's contribution", () => {
  it("is told by the text on a company's account", () => {
    expect(kind({ direction: "in", purpose: "Взнос наличными на расчетный счет" })).toBe("cash_deposit/high");
    expect(kind({ direction: "out", purpose: "Снятие наличных на хозяйственные нужды" })).toBe(
      "cash_withdrawal/high",
    );
    expect(kind({ direction: "in", purpose: "Взнос учредителя в уставный капитал по протоколу 1" })).toBe(
      "charter_capital/high",
    );
  });

  it("holds a contribution back when the bank wrote no tax number for the founder, and a deposit under a contract is a payment", () => {
    expect(
      kind({
        direction: "in",
        inn: "",
        account: "20208000900000000001",
        purpose: "Вклад в уставный капитал",
      }),
    ).toBe("charter_capital/medium");
    expect(kind({ direction: "in", purpose: "Взнос наличными по договору TI-05 от 01.02.2024" })).toBe(
      "contract_payment/high",
    );
  });

  it("is only a guess, never enough to write, on an account the table does not know", () => {
    expect(kind({ direction: "in", account: "99999000900000000001", purpose: "Взнос наличными" })).toBe(
      "cash_deposit/medium",
    );
  });
});
