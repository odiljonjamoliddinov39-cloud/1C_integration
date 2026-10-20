import { describe, expect, it } from "vitest";

import type { TableFile } from "../tables.js";
import { currencyOfAccount, describeLedger, planLedger } from "./ledger.js";
import { describeBankStatement, parseBankStatement } from "./statement.js";

const MAIN = "20208000700000000001";
const TRANSIT = "16401000100000000001";
const SPECIAL = "22613000400000000001";
const USD = "22614840500000000001";
const COMPANY = "300000001";

/** A statement in the layout one bank gives (heading lines, balances, then the table), as the sheet's rows. */
function statement(account: string, rows: string[][], balances: [string, string] = ["0", "0"]): TableFile {
  return {
    name: `№ счёта ${account}.xlsx`,
    sheets: [
      {
        name: "Page 1",
        rows: [
          [],
          ["", "", "", "", "Выписка лицевых счетов"],
          ["", "", "", "", "за 01.01.2024 по 30.09.2025"],
          ["", `№ счёта ${account}`],
          ["", "Остаток:", "Начало дня", balances[0], "", "Конец дня", balances[1]],
          [],
          [
            "№ пп",
            "Дата документа",
            "Дата обработки",
            "№ док",
            "Наименование счёта",
            "ИНН",
            "№ счёта",
            "МФО",
            "Обороты по дебету",
            "Обороты по кредиту",
            "Назначение платежа",
          ],
          ...rows.map((r, i) => [
            String(i + 1),
            r[0] ?? "",
            r[0] ?? "",
            r[1] ?? "",
            r[2] ?? "",
            r[3] ?? "",
            r[4] ?? "",
            "01082",
            r[5] ?? "",
            r[6] ?? "",
            r[7] ?? "",
          ]),
        ],
      },
    ],
  };
}

// date, doc no, counterparty name, INN, counterparty account, debit (out), credit (in), purpose
const mainRows = [
  [
    "08.01.2024",
    "37",
    "TASHBURMASH",
    "310740640",
    "20208000605689898001",
    "",
    "1000000",
    "Договор 1 поставку",
  ],
  ["16.01.2024", "4", "OWN LLC", COMPANY, TRANSIT, "1120", "", "За iBank-24-1120.00 документ №4"],
  ["16.01.2024", "4", "OWN LLC", COMPANY, TRANSIT, "5000", "", "За Комиссия за iBank-24 5000.00"],
  ["18.01.2024", "1", "OWN LLC", COMPANY, SPECIAL, "400000", "", "Блокировка средств для конвертации"],
  ["24.01.2024", "6", "OWN LLC", COMPANY, SPECIAL, "", "100000", "Возврат средств на расчетный счет"],
  [
    "25.01.2024",
    "7",
    "OWN LLC",
    COMPANY,
    "16413000500000000001",
    "85000",
    "",
    "Комиссия за конвертацию SWIFT",
  ],
  ["02.02.2025", "9", "ACME", "311111111", "20208000100000000009", "", "70000", "Оплата 2025"],
  ["03.02.2025", "10", "ACME", "311111111", "20208000100000000009", "", "10000", "Оплата 2025 б"],
];
// Money in from the main account equals money out to the bank's accounts; opens and closes at zero.
const transitRows = [
  ["16.01.2024", "4", "OWN LLC", COMPANY, MAIN, "", "1120", "За iBank-24-1120.00 документ №4"],
  [
    "16.01.2024",
    "4",
    "Тр. счет для комиссий (ОКБ)",
    "207117389",
    "29896000100001082432",
    "1120",
    "",
    "За iBank-24-1120.00",
  ],
  ["16.01.2024", "4", "OWN LLC", COMPANY, MAIN, "", "5000", "За Комиссия за iBank-24 5000.00"],
  [
    "16.01.2024",
    "4",
    "Комиссионные доходы по платежам (ОКБ)",
    "207117389",
    "45249000000001082160",
    "5000",
    "",
    "Комиссия за iBank-24",
  ],
];
const specialRows = [
  ["18.01.2024", "1", "OWN LLC", COMPANY, MAIN, "", "400000", "Блокировка средств для конвертации"],
  [
    "18.01.2024",
    "51",
    "840-Продажа иностр валюты юридическим лицам",
    "207117389",
    "17101000900001082944",
    "400000",
    "",
    "Конвертация валютных средств",
  ],
  ["24.01.2024", "6", "OWN LLC", COMPANY, MAIN, "", "100000", "Блокировка средств для конвертации"],
  ["24.01.2024", "51", "OWN LLC", COMPANY, MAIN, "100000", "", "Возврат средств на расчетный счет"],
];
const usdRows = [
  [
    "25.01.2024",
    "8",
    "Продажа иностр валюты",
    "207117389",
    "17101840000001082944",
    "",
    "4165",
    "Конвертация валютных средств",
  ],
];

const read = (account: string, rows: string[][], balances?: [string, string]) => {
  const parsed = parseBankStatement(statement(account, rows, balances));
  if (!parsed) throw new Error(`not a statement: ${account}`);
  return parsed;
};

describe("a bank statement of this layout", () => {
  it("takes the counterparty's name from 'Наименование счёта' and its account from '№ счёта'", () => {
    const main = read(MAIN, mainRows, ["0", "6350.00"]);
    expect(main.account).toBe(MAIN);
    expect(main.columns).toMatchObject({ name: "Наименование счёта", account: "№ счёта" });
    expect(main.payments[0]).toMatchObject({ counterparty: "TASHBURMASH", account: "20208000605689898001" });
  });

  it("names any 20-digit account in the heading, not only 202…", () => {
    expect(read(TRANSIT, transitRows).account).toBe(TRANSIT);
    expect(read(SPECIAL, specialRows).account).toBe(SPECIAL);
  });

  it("checks the printed balances against the rows", () => {
    // 1 000 000 + 100 000 + 70 000 + 10 000 in; out 1 120 + 5 000 + 400 000 + 85 000.
    const closing = (1_180_000 - 491_120).toFixed(2);
    expect(describeBankStatement(read(MAIN, mainRows, ["0", closing]))).toContain("the rows add up to them");
    expect(describeBankStatement(read(MAIN, mainRows, ["0", "1.00"]))).toContain("some rows are missing");
  });
});

describe("the currency of an account", () => {
  it("is in digits 6 to 8", () => {
    expect(currencyOfAccount(MAIN)).toBe("UZS");
    expect(currencyOfAccount(USD)).toBe("USD");
    expect(currencyOfAccount("22614643900000000001")).toBe("RUB");
    expect(currencyOfAccount("short")).toBe("");
  });
});

describe("the accounts of one company read together", () => {
  const statements = () => [
    read(MAIN, mainRows, ["0", (1_180_000 - 491_120).toFixed(2)]),
    read(TRANSIT, transitRows),
    read(SPECIAL, specialRows),
    read(USD, usdRows),
  ];
  const plan = (from?: string, to?: string) => planLedger(statements(), { from, to, ownInn: COMPANY });

  it("tells what each account is", () => {
    const roles = Object.fromEntries(plan().accounts.map((a) => [a.account, a.role]));
    expect(roles).toEqual({
      [MAIN]: "settlement",
      [TRANSIT]: "pass_through",
      [SPECIAL]: "pass_through",
      [USD]: "foreign_currency",
    });
  });

  it("enters the bank's fees as fees, and leaves the pass-through accounts' own rows out", () => {
    const p = plan();
    const main = statements()[0]!;
    const fees = p.fees.get(main.fileName) ?? new Set();
    // Rows 8–9 (sheet rows) are the two payments to the transit account, and the one to the account not attached
    // (its purpose reads as a fee); the conversion blocking and its return are not fees.
    const feeRows = [...fees].map((row) => main.payments.find((x) => x.row === row)?.purpose);
    expect(feeRows).toHaveLength(3);
    expect(feeRows.some((x) => x?.includes("Блокировка"))).toBe(false);
    expect(p.inPassThrough).toBe(8);
    // The payments to hand on: the counterparties' and the fees; not the conversion transfers.
    expect(p.rows.get(main.fileName)).toHaveLength(6);
  });

  it("matches each transfer between own accounts with its other leg, once", () => {
    const p = plan();
    const conversions = p.transfers.filter((t) => t.kind === "conversion");
    expect(conversions).toHaveLength(2);
    expect(conversions.every((t) => t.out && t.in)).toBe(true);
    expect(conversions.map((t) => [t.fromAccount.slice(0, 5), t.toAccount.slice(0, 5), t.amount])).toEqual([
      ["20208", "22613", 40_000_000],
      ["22613", "20208", 10_000_000],
    ]);
  });

  it("takes only the period asked for, from every statement", () => {
    const inJanuary = plan("2024-01-01", "2024-01-31");
    const main = statements()[0]!;
    // The counterparty's payment and the three fees; the two conversion transfers are not entered.
    expect(inJanuary.rows.get(main.fileName)).toHaveLength(4);
    expect(inJanuary.outsidePeriod).toBe(2);
    const in2025 = plan("2025-01-01", "2025-12-31");
    expect(in2025.rows.get(main.fileName)).toHaveLength(2);
    expect(in2025.accounts.find((a) => a.account === TRANSIT)?.inPeriod).toBe(0);
  });

  it("tells the model in a few lines, and that it must not look for rows", () => {
    const text = describeLedger(plan("2024-01-01", "2024-12-31"), { from: "2024-01-01", to: "2024-12-31" });
    expect(text).toContain("pass_through");
    expect(text).toContain("foreign_currency");
    expect(text).toContain("Transfers between the company's own accounts: 2");
    expect(text).toContain("Do not read the file");
  });

  it("does not take an ordinary statement for a pass-through one", () => {
    // Money in from outside the company is not a pass-through account.
    const lone = planLedger([read(MAIN, mainRows)], { ownInn: COMPANY });
    expect(lone.accounts[0]?.role).toBe("settlement");
  });
});
