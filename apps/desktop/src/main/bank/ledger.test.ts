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
  ["24.01.2024", "5", "OWN LLC", COMPANY, SPECIAL, "100000", "", "Блокировка средств для конвертации"],
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
    // 1 000 000 + 100 000 + 70 000 + 10 000 in; out 1 120 + 5 000 + 400 000 + 100 000 + 85 000.
    const closing = (1_180_000 - 591_120).toFixed(2);
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
    read(MAIN, mainRows, ["0", (1_180_000 - 591_120).toFixed(2)]),
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
    expect(conversions).toHaveLength(3);
    expect(conversions.every((t) => t.out && t.in)).toBe(true);
    expect(conversions.map((t) => [t.fromAccount.slice(0, 5), t.toAccount.slice(0, 5), t.amount])).toEqual([
      ["20208", "22613", 40_000_000],
      ["20208", "22613", 10_000_000],
      ["22613", "20208", 10_000_000],
    ]);
  });

  it("pairs a move whose two sides the bank posted on different days, so it is one move and not two", () => {
    const main = [["08.01.2024", "1", "OWN LLC", COMPANY, SPECIAL, "400000", "", "Блокировка средств"]];
    const special = [["09.01.2024", "1", "OWN LLC", COMPANY, MAIN, "", "400000", "Блокировка средств"]];
    const p = planLedger([read(MAIN, main), read(SPECIAL, special)], { ownInn: COMPANY });
    expect(p.transfers).toHaveLength(1);
    expect(p.transfers[0]).toMatchObject({ amount: 40_000_000 });
    expect(p.transfers[0]?.out).not.toBeNull();
    expect(p.transfers[0]?.in).not.toBeNull();
    expect(p.shifted).toBe(1);
    expect(describeLedger(p, { ownInn: COMPANY })).toContain("different days");
  });

  it("pairs the two sides of a move however the bank names the other account, and whichever file is read first", () => {
    const BANK_TRANSIT = "29896000100001082432";
    const main = [["08.01.2024", "1", "OWN LLC", COMPANY, SPECIAL, "400000", "", "Блокировка средств"]];
    // The blocked account's own statement writes the bank's account where the main account's number would be.
    const special = [
      ["08.01.2024", "1", "OWN LLC", COMPANY, BANK_TRANSIT, "", "400000", "Блокировка средств"],
    ];
    const mainFile = read(MAIN, main);
    // Not closed at zero: the blocked account is not a pass-through one, so its row is read as a move of its own too.
    const specialFile = read(SPECIAL, special, ["0", "400000"]);
    for (const order of [
      [mainFile, specialFile],
      [specialFile, mainFile],
    ]) {
      const p = planLedger(order, { ownInn: COMPANY });
      expect(p.transfers).toHaveLength(1);
      expect(p.transfers[0]?.out).not.toBeNull();
      expect(p.transfers[0]?.in).not.toBeNull();
    }
  });

  it("does not pair sides that are far apart in time", () => {
    const main = [["08.01.2024", "1", "OWN LLC", COMPANY, SPECIAL, "400000", "", "Блокировка средств"]];
    const special = [["20.01.2024", "1", "OWN LLC", COMPANY, MAIN, "", "400000", "Блокировка средств"]];
    const p = planLedger([read(MAIN, main), read(SPECIAL, special)], { ownInn: COMPANY });
    expect(p.transfers.every((t) => !t.out || !t.in)).toBe(true);
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
    expect(text).toContain("Transfers between the company's own accounts: 3");
    expect(text).toContain("Do not read the file");
  });

  it("compares what was paid into a pass-through account with what it took in", () => {
    const p = plan();
    expect(p.checks.map((c) => [c.to.slice(0, 5), c.paid, c.took])).toEqual([
      ["16401", 612_000, 612_000],
      ["22613", 50_000_000, 50_000_000],
    ]);
    expect(describeLedger(p)).toContain("equals what they took in (2 pairs");
    // A row missing from the transit statement is told.
    const broken = statements().map((x) =>
      x.account === TRANSIT ? { ...x, payments: x.payments.filter((q) => q.row !== x.payments[0]?.row) } : x,
    );
    const text = describeLedger(planLedger(broken, { ownInn: COMPANY }));
    expect(text).toContain("does not agree");
  });

  it("does not take an ordinary statement for a pass-through one", () => {
    // Money in from outside the company is not a pass-through account.
    const lone = planLedger([read(MAIN, mainRows)], { ownInn: COMPANY });
    expect(lone.accounts[0]?.role).toBe("settlement");
  });

  it("takes the terminals' takings for receipts to enter, not for a move between the company's own accounts", () => {
    const card = [
      "12.10.2026",
      "88",
      "OWN LLC",
      COMPANY,
      "23510000300000000004",
      "",
      "483610.84",
      "00634SmartVista - Выручка OWN LLC 483,610.84 сум с 12.10.2026 по 12.10.2026 ( TID 30061802) от сумма: 484,580.00 в том числе комиссия (0.2%) 969.16",
    ];
    const plain = [
      "12.10.2026",
      "89",
      "OWN LLC",
      COMPANY,
      "23510000300000000004",
      "",
      "5000",
      "Перевод средств",
    ];
    const lone = planLedger([read(MAIN, [card, plain])], { ownInn: COMPANY });
    const rows = lone.rows.values().next().value as number[];
    // The terminal receipt is entered; the plain move from an unattached own account is a transfer to look at.
    expect(rows).toHaveLength(1);
    expect(lone.transfers).toHaveLength(1);
    expect(lone.transfers[0]?.kind).toBe("unattached_own");
  });

  describe("a purchase and a sale of currency", () => {
    const BUY = "Без комиссии Конвертация валютных средств 4165.0 'Доллар США' по курсу 12484.0 МФО - 01082";
    const SELL = "Конвертация валютных средств 6080.0 'Доллар США'  по курсу 12596 МФО - 01082";
    // the block account pays the soums, the dollar account takes the dollars in; the sale the other way round
    const statements = () => [
      read(SPECIAL, [
        [
          "25.01.2024",
          "51392581",
          "840-Продажа иностр валюты",
          "207117389",
          "17101000900001082944",
          "51995860",
          "",
          BUY,
        ],
      ]),
      read(USD, [
        [
          "25.01.2024",
          "51392582",
          "840-Продажа иностр валюты",
          "207117389",
          "17101840400001082944",
          "",
          "4165",
          BUY,
        ],
        [
          "03.04.2024",
          "52640892",
          "840-Покупка иностранной валюты",
          "207117389",
          "17101840700001082851",
          "6080",
          "",
          SELL,
        ],
        ["20.05.2024", "7", "SUPPLIER LLC", "300000009", "20208000700000000999", "", "10", "Оплата"],
      ]),
      read(MAIN, [
        [
          "03.04.2024",
          "52640893",
          "840-Покупка иностранной валюты",
          "207117389",
          "17101000700001082851",
          "",
          "76583680",
          SELL,
        ],
      ]),
    ];

    it("each is one transfer of two legs paired by the bank's own words, and its rows are not payments", () => {
      const plan = planLedger(statements(), { ownInn: COMPANY });
      const conversions = plan.transfers.filter((t) => t.fx);
      expect(
        conversions.map((t) => [t.kind, t.fx?.direction, t.fx?.currency, t.fx?.amount, t.fx?.rate]),
      ).toEqual([
        ["conversion", "buy", "USD", 4165, 12484],
        ["conversion", "sell", "USD", 6080, 12596],
      ]);
      const [buy, sell] = conversions;
      expect(buy).toMatchObject({ fromAccount: SPECIAL, toAccount: USD, amount: 5_199_586_000 });
      expect(sell).toMatchObject({ fromAccount: USD, toAccount: MAIN, amount: 608_000 });
      // the only row left to enter is the dollar account's payment to a supplier
      const usdRows = plan.rows.get(`№ счёта ${USD}.xlsx`) ?? [];
      expect(usdRows).toHaveLength(1);
      expect(plan.rows.get(`№ счёта ${MAIN}.xlsx`) ?? []).toEqual([]);
    });

    it("a leg whose other leg is not attached stays an ordinary row, for the accountant", () => {
      const plan = planLedger(statements().slice(1, 2), { ownInn: COMPANY });
      expect(plan.transfers.filter((t) => t.fx)).toEqual([]);
      // the purchase's dollar leg and the sale's, and the supplier's payment: all three are still to enter
      expect(plan.rows.get(`№ счёта ${USD}.xlsx`)).toHaveLength(3);
    });
  });
});
