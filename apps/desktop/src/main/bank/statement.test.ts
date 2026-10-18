import { describe, expect, it } from "vitest";

import type { TableFile } from "../tables.js";
import { describeBankStatement, parseBankStatement } from "./statement.js";

const file = (rows: string[][]): TableFile => ({ name: "vypiska.xlsx", sheets: [{ name: "Лист1", rows }] });

const debitCredit = file([
  ["Выписка по счёту 20208000100438330001 за 01.09.2026 – 30.09.2026"],
  [],
  [
    "Дата",
    "№ док",
    "Наименование корреспондента",
    "ИНН",
    "МФО",
    "Счёт корр.",
    "Дебет",
    "Кредит",
    "Назначение платежа",
  ],
  [
    "01.09.2026",
    "101",
    "NAVRO'Z-PTK",
    "201607534",
    "00444",
    "20208000900000000001",
    "",
    "1 500 000,00",
    "Оплата по договору №17",
  ],
  [
    "02.09.2026",
    "102",
    "HYDRO DRILL",
    "312318957",
    "00014",
    "20208000100000000002",
    "250 000,50",
    "",
    "За услуги бурения",
  ],
  ["15.10.2026", "7", "Банк", "", "", "", "100,00", "", "Комиссия банка"],
  ["Итого", "", "", "", "", "", "250 100,50", "1 500 000,00", ""],
]);

describe("bank statement", () => {
  it("finds the columns by their headings and reads each payment in whole tiyin", () => {
    const statement = parseBankStatement(debitCredit);
    expect(statement?.account).toBe("20208000100438330001");
    expect(statement?.payments).toEqual([
      {
        row: 4,
        date: "2026-09-01",
        number: "101",
        direction: "in",
        amount: 150_000_000,
        counterparty: "NAVRO'Z-PTK",
        inn: "201607534",
        account: "20208000900000000001",
        mfo: "00444",
        purpose: "Оплата по договору №17",
      },
      expect.objectContaining({ number: "102", direction: "out", amount: 25_000_050, inn: "312318957" }),
      expect.objectContaining({ number: "7", direction: "out", amount: 10_000, inn: "" }),
    ]);
    expect(statement?.issues).toEqual([]);
  });

  it("reads one signed amount column, and separate payer and receiver columns", () => {
    const statement = parseBankStatement(
      file([
        [
          "Sana",
          "Hujjat raqami",
          "To'lovchi nomi",
          "To'lovchi STIR",
          "Oluvchi nomi",
          "Oluvchi STIR",
          "Summa",
          "To'lov maqsadi",
        ],
        ["2026-09-03", "55", "AQUA", "200111222", "CRYSTAL WATER", "303212825", "1 000,00", "Oplata"],
        ["2026-09-04", "56", "CRYSTAL WATER", "303212825", "HYDRO", "312318957", "-400,00", "Uslugi"],
      ]),
    );
    expect(statement?.payments).toMatchObject([
      { direction: "in", amount: 100_000, counterparty: "AQUA", inn: "200111222" },
      { direction: "out", amount: 40_000, counterparty: "HYDRO", inn: "312318957" },
    ]);
    expect(statement?.issues.map((i) => i.code)).toEqual(["NEGATIVE"]);
    expect(statement?.convention).toMatch(/sign/);
  });

  it("names what looks wrong and keeps going", () => {
    const statement = parseBankStatement(
      file([
        ["Дата", "№", "Корреспондент", "ИНН", "Дебет", "Кредит", "Назначение"],
        ["01.09.2026", "1", "A", "12345", "", "100", "x"],
        ["01.09.2026", "1", "A", "12345", "", "100", "x"],
        ["02.09.2026", "", "B", "201607534", "50", "60", "y"],
        ["03.09.2026", "3", "C", "201607534", "", "", "z"],
      ]),
    );
    expect(statement?.payments).toHaveLength(3);
    expect(statement?.issues.map((i) => `${i.row}:${i.code}`)).toEqual([
      "2:INN_FORMAT",
      "3:INN_FORMAT",
      "3:DUPLICATE",
      "4:BOTH_SIDES",
      "4:NO_NUMBER",
      "5:NO_AMOUNT",
    ]);
  });

  it("reads an INN of only zeros as no INN, and remembers that the bank wrote zeros", () => {
    const statement = parseBankStatement(
      file([
        ["Дата", "№", "Корреспондент", "ИНН", "Дебет", "Кредит", "Назначение"],
        ["01.09.2026", "1", "AMERHANOVA-VINERA", "000000000", "", "126 000,00", "Оплата"],
      ]),
    );
    expect(statement?.payments[0]).toMatchObject({
      counterparty: "AMERHANOVA-VINERA",
      inn: "",
      innZero: true,
    });
    expect(statement?.issues).toEqual([]);
  });

  it("is not a statement when there is no date and amount heading", () => {
    expect(
      parseBankStatement(
        file([
          ["Название", "Цена"],
          ["Вода", "100"],
        ]),
      ),
    ).toBeNull();
    expect(parseBankStatement(file([]))).toBeNull();
  });

  it("describes a statement with its totals and exceptions, not its rows", () => {
    const statement = parseBankStatement(debitCredit);
    const text = describeBankStatement(statement as never);
    expect(text).toContain("3 payments 2026-09-01 – 2026-10-15");
    expect(text).toContain("account 20208000100438330001");
    expect(text).toContain("Дебет = money out");
    expect(text).toContain("In: 1 payments, 1 500 000.00. Out: 2 payments, 250 100.50.");
    expect(text).toContain("2026-09: in 1 500 000.00, out 250 000.50 (2)");
    expect(text).not.toContain("NAVRO'Z-PTK");
  });
});
