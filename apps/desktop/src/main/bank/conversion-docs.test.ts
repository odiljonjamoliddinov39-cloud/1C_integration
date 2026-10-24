import type { RunQueryInput } from "@platform/shared";
import { describe, expect, it } from "vitest";

import type { Transfer } from "./ledger.js";
import type { BankDeps } from "./resolve.js";
import type { BankPayment, BankStatement } from "./statement.js";
import { resolveTransfers } from "./transfer.js";

const BLOCK = "22613000405733821001";
const MAIN = "20208000705733821001";
const USD = "22614840505733821001";
const REF_BLOCK = "b1b1b1b1-0000-4000-8000-000000000001";
const REF_MAIN = "b1b1b1b1-0000-4000-8000-000000000002";
const REF_USD = "b1b1b1b1-0000-4000-8000-000000000003";
const USD_ITEM = "c1c1c1c1-0000-4000-8000-000000000001";
const SOUM_ITEM = "c1c1c1c1-0000-4000-8000-000000000002";
const BANK = "d1d1d1d1-0000-4000-8000-000000000001";
const BANK_LINE = "d1d1d1d1-0000-4000-8000-000000000002";
const CONTRACT_USD = "e1e1e1e1-0000-4000-8000-000000000001";
const CONTRACT_UZS = "e1e1e1e1-0000-4000-8000-000000000002";
const ORG = "f1f1f1f1-0000-4000-8000-000000000001";

const ref = (type: string, id: string, name: string) => ({ type, ref: id, name });
const value = (type: string, name: string, shown: string) => ref(`Перечисление.${type}`, name, shown);
const attrs = (names: Record<string, string[]>) =>
  Object.entries(names).map(([name, types]) => ({ name, synonym: "", types }));

const DESCRIBE: Record<string, unknown> = {
  "Документ.СписаниеСРасчетногоСчета": {
    attributes: attrs({
      Организация: ["Справочник.Организации"],
      ВидОперации: ["Перечисление.ВидыОперацийСписаниеДенежныхСредств"],
      СчетОрганизации: ["Справочник.БанковскиеСчета"],
      Контрагент: ["Справочник.Контрагенты"],
      ДоговорКонтрагента: ["Справочник.ДоговорыКонтрагентов"],
      СчетУчетаРасчетовСКонтрагентом: ["ПланСчетов.Хозрасчетный"],
      ВалютаДокумента: ["Справочник.Валюты"],
      КурсДокумента: [],
      КратностьДокумента: [],
      СуммаДокумента: [],
      НазначениеПлатежа: [],
      Комментарий: [],
    }),
    tabularSections: [],
  },
  "Справочник.ДоговорыКонтрагентов": {
    attributes: attrs({
      Владелец: ["Справочник.Контрагенты"],
      Номер: [],
      Дата: [],
      ВидДоговора: ["Перечисление.ВидыДоговоровКонтрагентов"],
      ВалютаВзаиморасчетов: ["Справочник.Валюты"],
      Организация: ["Справочник.Организации"],
    }),
    tabularSections: [],
  },
  "Документ.ПоступлениеНаРасчетныйСчет": {
    attributes: attrs({
      Организация: ["Справочник.Организации"],
      ВидОперации: ["Перечисление.ВидыОперацийПоступлениеДенежныхСредств"],
      СчетОрганизации: ["Справочник.БанковскиеСчета"],
      Контрагент: ["Справочник.Контрагенты"],
      ДоговорКонтрагента: ["Справочник.ДоговорыКонтрагентов"],
      СчетУчетаРасчетовСКонтрагентом: ["ПланСчетов.Хозрасчетный"],
      ВалютаДокумента: ["Справочник.Валюты"],
      КурсДокумента: [],
      КратностьДокумента: [],
      СуммаДокумента: [],
      НазначениеПлатежа: [],
      Комментарий: [],
    }),
    tabularSections: [],
  },
};

interface World {
  /** Counterparties with the bank's INN. */
  counterparties?: [string, string][];
  /** Contracts of the bank: owner ref, ref, kind, currency code. */
  contracts?: [string, string, string, string][];
  rate?: number | null;
  chart?: string[];
}

const BANK_INN = "207117389";

function deps(world: World = {}): BankDeps {
  const chart = world.chart ?? ["5730", "5740"];
  const codes: Record<string, string> = {
    "5730": "a5730000-0000-4000-8000-000000000000",
    "5740": "a5740000-0000-4000-8000-000000000000",
  };
  const counterparties = world.counterparties ?? [
    [BANK, "KAPITALBANK"],
    [BANK_LINE, "К получению с Головного Офиса - Долларов США"],
  ];
  const contracts = world.contracts ?? [
    [BANK, CONTRACT_USD, "Прочее", "840"],
    [BANK, CONTRACT_UZS, "Прочее", "860"],
  ];
  return {
    async query(input: RunQueryInput) {
      const q = input.query;
      const rows = (list: unknown[][]) => ({ ok: true as const, data: { rows: list } });
      if (q.includes("КурсыВалют")) return rows(world.rate === null ? [] : [[world.rate ?? 12_421.76, 1]]);
      if (q.includes("Справочник.Валюты"))
        return rows([[ref("Справочник.Валюты", input.params?.Код === "840" ? USD_ITEM : SOUM_ITEM, "x")]]);
      if (q.includes("Справочник.БанковскиеСчета"))
        return rows([
          [BLOCK, ref("Справочник.БанковскиеСчета", REF_BLOCK, "блок"), "311012912"],
          [MAIN, ref("Справочник.БанковскиеСчета", REF_MAIN, "основной"), "311012912"],
          [USD, ref("Справочник.БанковскиеСчета", REF_USD, "USD"), "311012912"],
        ]);
      if (q.includes("Справочник.Контрагенты"))
        return rows(counterparties.map(([id, name]) => [ref("Справочник.Контрагенты", id, name), name]));
      if (q.includes("Справочник.ДоговорыКонтрагентов"))
        return rows(
          contracts.map(([owner, id, kind, code]) => [
            ref("Справочник.Контрагенты", owner, "bank"),
            ref("Справочник.ДоговорыКонтрагентов", id, "договор"),
            value("ВидыДоговоровКонтрагентов", kind, kind),
            code,
            "2024-01-01T00:00:00",
          ]),
        );
      if (q.includes("Перечисление.ВидыДоговоровКонтрагентов"))
        return rows([
          [value("ВидыДоговоровКонтрагентов", "СПоставщиком", "С поставщиком")],
          [value("ВидыДоговоровКонтрагентов", "Прочее", "Прочее")],
        ]);
      if (q.includes("Перечисление.ВидыОперацийСписаниеДенежныхСредств"))
        return rows([[value("ВидыОперацийСписаниеДенежныхСредств", "ПрочееСписание", "Прочее списание")]]);
      if (q.includes("Перечисление.ВидыОперацийПоступлениеДенежныхСредств"))
        return rows([
          [value("ВидыОперацийПоступлениеДенежныхСредств", "ПрочееПоступление", "Прочее поступление")],
        ]);
      if (q.includes("ПланСчетов.Хозрасчетный"))
        return rows(
          Object.entries(codes)
            .filter(([code]) => chart.includes(code))
            .map(([code, id]) => [code, ref("ПланСчетов.Хозрасчетный", id, code)]),
        );
      return rows([]);
    },
    async describe(objects) {
      return { ok: true, data: objects.map((o) => DESCRIBE[o]).filter(Boolean) };
    },
    async getObject() {
      return { ok: false, code: "X", message: "none" };
    },
  };
}

const pay = (over: Partial<BankPayment>): BankPayment => ({
  row: 1,
  date: "2024-01-25",
  number: "51392581",
  direction: "out",
  amount: 5_199_586_000,
  counterparty: "840-Продажа иностр валюты",
  inn: BANK_INN,
  account: "17101000900001082944",
  mfo: "01082",
  purpose: "Без комиссии Конвертация валютных средств 4165.0 'Доллар США' по курсу 12484.0",
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

const buy: Transfer = {
  kind: "conversion",
  date: "2024-01-25",
  amount: 5_199_586_000,
  fromAccount: BLOCK,
  toAccount: USD,
  purpose: "Конвертация",
  out: { file: "block.xlsx", row: 1 },
  in: { file: "usd.xlsx", row: 2 },
  fx: { id: "FX-2024-01-25-USD-4165-1", direction: "buy", currency: "USD", amount: 4165, rate: 12_484 },
};

const statements = [
  statement("block.xlsx", BLOCK, [pay({ row: 1 })]),
  statement("usd.xlsx", USD, [
    pay({ row: 2, direction: "in", amount: 416_500, counterparty: "840-Покупка", number: "51392582" }),
  ]),
];

const run = (world: World = {}, transfers: Transfer[] = [buy]) =>
  resolveTransfers(
    transfers,
    statements,
    { ownInn: "311012912", files: new Set(["block.xlsx", "usd.xlsx"]), organization: ORG },
    deps(world),
  );

describe("a currency purchase, entered by the program with no earlier document to copy", () => {
  it("is two linked documents with the bank and its contract in each leg's own currency, the paying one first", async () => {
    const out = await run();
    expect(out.problems).toEqual([]);
    expect(out.ready.map((r) => [r.side, r.change.object])).toEqual([
      ["out", "Документ.СписаниеСРасчетногоСчета"],
      ["in", "Документ.ПоступлениеНаРасчетныйСчет"],
    ]);
    const [paying, taking] = out.ready;
    expect(paying?.change.fields).toMatchObject({
      Дата: "2024-01-25T10:00:00",
      ВидОперации: "ПрочееСписание",
      СчетОрганизации: { ref: REF_BLOCK },
      Контрагент: { ref: BANK },
      // the soum leg is with the bank's contract of kind «Прочее» in soums
      ДоговорКонтрагента: { ref: CONTRACT_UZS },
      СуммаДокумента: 51_995_860,
      Комментарий: "Conversion FX-2024-01-25-USD-4165-1",
    });
    expect(taking?.change.fields).toMatchObject({
      Дата: "2024-01-25T10:00:01",
      ВидОперации: "ПрочееПоступление",
      СчетОрганизации: { ref: REF_USD },
      // the dollar leg is with the contract in dollars, at the day's official rate
      ДоговорКонтрагента: { ref: CONTRACT_USD },
      ВалютаДокумента: { ref: USD_ITEM },
      КурсДокумента: 12_421.76,
      СуммаДокумента: 4165,
      Комментарий: "Conversion FX-2024-01-25-USD-4165-1",
    });
    expect(out.notes.some((n) => n.includes("conversion FX-2024-01-25-USD-4165-1: bought 4165 USD"))).toBe(
      true,
    );
    expect(out.notes.join(" ")).toContain("5730");
  });

  it("stops, saying exactly what 1C lacks: the bank, its contract in the currency, a rate, the conversion account", async () => {
    const noBank = await run({
      counterparties: [[BANK_LINE, "К получению с Головного Офиса - Долларов США"]],
    });
    expect(noBank.ready).toEqual([]);
    expect(noBank.problems[0]?.message).toContain("create the bank as a counterparty first");

    const noContract = await run({ contracts: [[BANK, CONTRACT_UZS, "Прочее", "860"]] });
    // the soum leg can be made, the dollar leg cannot
    expect(noContract.ready.map((r) => r.side)).toEqual(["out"]);
    expect(noContract.problems[0]?.message).toContain("has no contract of kind «Прочее» in USD");
    // the contract is offered, made from 1C's description of the directory, dated the conversion's first day
    expect(noContract.contractsToCreate).toHaveLength(1);
    expect(noContract.contractsToCreate[0]?.label).toBe("KAPITALBANK · «Прочее» USD");
    expect(noContract.contractsToCreate[0]?.change.fields).toMatchObject({
      Владелец: { ref: BANK },
      Номер: "FX-USD",
      Дата: "2024-01-25",
      ВидДоговора: "Прочее",
    });

    const noRate = await run({ rate: null });
    expect(noRate.ready.map((r) => r.side)).toEqual(["out"]);
    expect(noRate.problems[0]?.message).toContain("exchange rate of USD");

    const noAccount = await run({ chart: [] });
    expect(noAccount.ready).toEqual([]);
    expect(noAccount.problems[0]?.message).toContain("no conversion account 5730");
  });

  it("does not guess between two counterparties that could be the bank", async () => {
    const out = await run({
      counterparties: [
        [BANK, "KAPITALBANK"],
        ["d1d1d1d1-0000-4000-8000-000000000009", "KAPITALBANK BUXORO FILIALI"],
      ],
    });
    expect(out.ready).toEqual([]);
    expect(out.problems[0]?.message).toContain("2 counterparties could be the conversion's bank");
  });
});
