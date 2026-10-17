import { describe, expect, it } from "vitest";

import type { RunQueryInput } from "@platform/shared";

import {
  type BankDeps,
  contractMention,
  copyTemplate,
  isTaxPayment,
  resolvePayments,
  shapeOf,
} from "./resolve.js";
import { type BankPayment, type BankStatement } from "./statement.js";

const OWN = "11111111-1111-4111-8111-111111111111";
const NAVRUZ = "22222222-2222-4222-8222-222222222222";
const HYDRO = "33333333-3333-4333-8333-333333333333";
const OLD_IN = "44444444-4444-4444-8444-444444444444";
const OLD_OUT = "55555555-5555-4555-8555-555555555555";

const ref = (type: string, id: string, name: string) => ({ type, ref: id, name });

const payment = (over: Partial<BankPayment> = {}): BankPayment => ({
  row: 4,
  date: "2026-09-01",
  number: "101",
  direction: "in",
  amount: 150_000_000,
  counterparty: "NAVRO'Z-PTK",
  inn: "201607534",
  account: "",
  mfo: "",
  purpose: "Оплата по договору №17",
  ...over,
});

const statement = (payments: BankPayment[], issues: BankStatement["issues"] = []): BankStatement => ({
  fileName: "vypiska.xlsx",
  sheet: "Лист1",
  account: "20208000100438330001",
  payments,
  issues,
  columns: {},
  convention: "Дебет = money out of the account, Кредит = money in",
});

/** A payment the company already recorded for the counterparty: 1 000 000 incl. 12% VAT, in сум. */
const earlier = (over: Record<string, unknown> = {}) => ({
  fields: {
    Номер: "0000-000007",
    Дата: "2026-08-01T00:00:00",
    Проведен: true,
    // An enumeration: its value NAME is `ref`, its presentation (what 1C does not know as a value) is `name`.
    ВидОперации: ref(
      "Перечисление.ВидыОперацийПоступлениеДенежныхСредств",
      "ОплатаПокупателя",
      "Оплата покупателя",
    ),
    Организация: ref("Справочник.Организации", "66666666-6666-4666-8666-666666666666", "CRYSTAL"),
    БанковскийСчет: ref("Справочник.БанковскиеСчета", "77777777-7777-4777-8777-777777777777", "старый"),
    Контрагент: ref("Справочник.Контрагенты", NAVRUZ, "NAVRO'Z-PTK"),
    ДоговорКонтрагента: ref("Справочник.ДоговорыКонтрагентов", "88888888-8888-4888-8888-888888888888", "№17"),
    СуммаДокумента: 1_000_000,
    НазначениеПлатежа: "старое",
    НомерВходящегоДокумента: "55",
    ДатаВходящегоДокумента: "2026-08-01T00:00:00",
    ...over,
  },
  tables: {
    РасшифровкаПлатежа: [
      {
        ДоговорКонтрагента: ref(
          "Справочник.ДоговорыКонтрагентов",
          "88888888-8888-4888-8888-888888888888",
          "№17",
        ),
        СуммаПлатежа: 1_000_000,
        КурсВзаиморасчетов: 1,
        КратностьВзаиморасчетов: 1,
        СуммаВзаиморасчетов: 1_000_000,
        СтавкаНДС: ref("Перечисление.СтавкиНДС", "НДС12", "12%"),
        СуммаНДС: 107_142.86,
        СчетРасчетов: ref("ПланСчетов.Хозрасчетный", "99999999-9999-4999-8999-999999999999", "4010"),
      },
    ],
  },
});

interface Doc {
  object: string;
  ref: string;
  inn: string;
  purpose: string;
  snapshot: ReturnType<typeof earlier>;
}

const CONTRACT_17 = "88888888-8888-4888-8888-888888888888";

/** A 1C base in a few lists: the earlier payments, the contracts, the counterparties' accounts. */
function deps(
  opts: {
    ownAccounts?: string[];
    counterparties?: [string, string, string][];
    docs?: Doc[];
    contracts?: [string, string, string, string][];
    accounts?: [string, string, string][];
    existing?: [string, string, number][];
  } = {},
) {
  const seen: RunQueryInput[] = [];
  const docs = opts.docs ?? [
    {
      object: "Документ.ПоступлениеНаРасчетныйСчет",
      ref: OLD_IN,
      inn: "201607534",
      purpose: "старое",
      snapshot: earlier(),
    },
  ];
  const d: BankDeps = {
    async query(input) {
      seen.push(input);
      const q = input.query;
      const rows = (list: unknown[][]) => ({ ok: true as const, data: { rows: list } });
      if (q.includes("Справочник.БанковскиеСчета") && q.includes("Т.НомерСчета В")) {
        return rows((opts.ownAccounts ?? [OWN]).map((id) => [ref("Справочник.БанковскиеСчета", id, "р/с")]));
      }
      if (q.includes("Справочник.БанковскиеСчета")) {
        return rows(
          (opts.accounts ?? []).map(([inn, id, number]) => [
            inn,
            ref("Справочник.БанковскиеСчета", id, number),
            number,
          ]),
        );
      }
      if (q.includes("Справочник.ДоговорыКонтрагентов")) {
        return rows(
          (opts.contracts ?? []).map(([inn, id, number, date]) => [
            inn,
            ref("Справочник.ДоговорыКонтрагентов", id, number),
            number,
            date,
          ]),
        );
      }
      if (q.includes("Справочник.Контрагенты")) {
        return rows(
          (opts.counterparties ?? [["201607534", NAVRUZ, "NAVRO'Z-PTK"]]).map(([inn, id, name]) => [
            inn,
            ref("Справочник.Контрагенты", id, name),
            name,
          ]),
        );
      }
      if (q.includes("ПЕРВЫЕ")) {
        const object = q.includes("СписаниеС")
          ? "Документ.СписаниеСРасчетногоСчета"
          : "Документ.ПоступлениеНаРасчетныйСчет";
        const byInn = q.includes("Контрагент.ИНН =");
        return rows(
          docs
            .filter((x) => x.object === object && (!byInn || x.inn === input.params?.инн))
            .map((x) => [ref(x.object, x.ref, "старый"), x.purpose]),
        );
      }
      return rows(
        (opts.existing ?? []).map(([date, id, sum]) => [ref("Справочник.Контрагенты", id, "x"), date, sum]),
      );
    },
    async describe() {
      return { ok: true, data: [] };
    },
    async getObject(objectName, id) {
      const found = docs.find((x) => x.ref === id && x.object === objectName);
      return found
        ? { ok: true, data: { object: objectName, ref: id, ...found.snapshot } }
        : { ok: false, code: "NOT_FOUND", message: "no such document" };
    },
  };
  return { d, seen };
}

describe("copying the counterparty's last payment", () => {
  it("keeps the company's own contract and accounts, and changes date, amount, number and purpose", () => {
    const template = { object: "Документ.ПоступлениеНаРасчетныйСчет", ref: OLD_IN, ...earlier() };
    const made = copyTemplate(template, payment({ amount: 50_000_000 }), { ownAccount: OWN });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.change).toMatchObject({
      action: "create",
      object: "Документ.ПоступлениеНаРасчетныйСчет",
      post: false,
      fields: {
        Дата: "2026-09-01",
        СуммаДокумента: 500_000,
        НазначениеПлатежа: "Оплата по договору №17",
        НомерВходящегоДокумента: "101",
        ДатаВходящегоДокумента: "2026-09-01",
        БанковскийСчет: { type: "Справочник.БанковскиеСчета", ref: OWN },
        Контрагент: { type: "Справочник.Контрагенты", ref: NAVRUZ },
        ВидОперации: "ОплатаПокупателя",
      },
    });
    // 1C's own name of the date, never an English one it does not have.
    expect(made.change.fields).not.toHaveProperty("Date");
    expect(made.change.fields).not.toHaveProperty("Номер");
    expect(made.change.fields).not.toHaveProperty("Проведен");
    // The breakdown row scales with the new amount; the contract and the account stay.
    expect(made.change.tables?.РасшифровкаПлатежа).toEqual([
      expect.objectContaining({
        СуммаПлатежа: 500_000,
        СуммаВзаиморасчетов: 500_000,
        СуммаНДС: 53_571.43,
        КурсВзаиморасчетов: 1,
        ДоговорКонтрагента: { type: "Справочник.ДоговорыКонтрагентов", ref: CONTRACT_17 },
        СчетРасчетов: { type: "ПланСчетов.Хозрасчетный", ref: "99999999-9999-4999-8999-999999999999" },
      }),
    ]);
  });

  it("refuses what it cannot copy honestly: a split payment, another currency, an unbalanced breakdown", () => {
    const base = { object: "Документ.ПоступлениеНаРасчетныйСчет", ref: OLD_IN };
    const one = earlier().tables.РасшифровкаПлатежа[0] ?? {};
    const split = copyTemplate(
      { ...base, ...earlier(), tables: { РасшифровкаПлатежа: [one, one] } },
      payment(),
      {},
    );
    expect(split).toMatchObject({ ok: false, message: expect.stringContaining("2 rows") });
    const usd = copyTemplate(
      { ...base, ...earlier(), tables: { РасшифровкаПлатежа: [{ ...one, КурсВзаиморасчетов: 12_700 }] } },
      payment(),
      {},
    );
    expect(usd).toMatchObject({ ok: false, message: expect.stringContaining("foreign currency") });
    const off = copyTemplate(
      { ...base, ...earlier(), tables: { РасшифровкаПлатежа: [{ ...one, СуммаПлатежа: 5 }] } },
      payment(),
      {},
    );
    expect(off).toMatchObject({ ok: false, message: expect.stringContaining("does not add up") });
    const none = copyTemplate({ ...base, ...earlier({ СуммаДокумента: 0 }) }, payment(), {});
    expect(none.ok).toBe(false);
  });

  it("takes another counterparty's document only with that counterparty's contract, and drops its bank account", () => {
    const template = {
      object: "Документ.СписаниеСРасчетногоСчета",
      ref: OLD_OUT,
      ...earlier({
        СчетКонтрагента: ref("Справочник.БанковскиеСчета", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "чужой"),
      }),
    };
    const pay = payment({ direction: "out" });
    expect(copyTemplate(template, pay, { counterparty: HYDRO })).toMatchObject({
      ok: false,
      message: expect.stringContaining("another counterparty's"),
    });
    const contract = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const made = copyTemplate(template, pay, { counterparty: HYDRO, contract });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.change.fields).toMatchObject({
      Контрагент: { ref: HYDRO },
      ДоговорКонтрагента: { ref: contract },
    });
    expect(made.change.fields).not.toHaveProperty("СчетКонтрагента");
    expect(made.change.tables?.РасшифровкаПлатежа?.[0]).toMatchObject({
      ДоговорКонтрагента: { ref: contract },
    });
  });

  it("reads the contract a purpose names, and what kind of payment a purpose is", () => {
    expect(contractMention("00098 00508 Договор 4/28 от 01.01.2026г за прохладные напитки")).toEqual({
      number: "4/28",
      date: "2026-01-01",
    });
    expect(contractMention("По дог. № 17 от 08.01.2026 Товары народного потребления")).toEqual({
      number: "17",
      date: "2026-01-08",
    });
    expect(contractMention("00039 Договор номера 14 от 17.02.2026 г за напитки")).toEqual({
      number: "14",
      date: "2026-02-17",
    });
    expect(contractMention("00119 Договор номера №B-335 от 12.05.2026 г")).toEqual({
      number: "B-335",
      date: "2026-05-12",
    });
    expect(contractMention("00119 товары народного потребления дог6/3 от 01.01.2026г")).toEqual({
      number: "6/3",
      date: "2026-01-01",
    });
    expect(contractMention("оплата за природный газ Сумма 1 000 000")).toBeNull();
    expect(shapeOf("00634SmartVista - Выручка CRYSTAL WATER TRADE 483,610.84 сум с 12.10.2026")).toBe(
      shapeOf("00634SmartVista - Выручка CRYSTAL WATER TRADE 2,879,230.00 сум с 13.10.2026"),
    );
  });
});

describe("bank payments for 1C", () => {
  it("makes a ready document of each payment whose counterparty and earlier payment it finds", async () => {
    const { d, seen } = deps();
    const resolved = await resolvePayments(statement([payment()]), {}, d);
    expect(resolved.problems).toEqual([]);
    expect(resolved.ready).toHaveLength(1);
    expect(resolved.ready[0]?.change.fields).toMatchObject({
      СуммаДокумента: 1_500_000,
      БанковскийСчет: { ref: OWN },
      Дата: "2026-09-01",
    });
    // The earlier payment is found by the counterparty's INN, which a query can compare; a reference it cannot.
    expect(
      seen.some((q) => q.query.includes("Т.Контрагент.ИНН = &инн") && q.params?.инн === "201607534"),
    ).toBe(true);
  });

  it("copies a payment of the same kind for rows with no INN: acquiring and bank fees", async () => {
    const acquiring =
      "00634SmartVista - Выручка CRYSTAL WATER TRADE 483,610.84 сум с 12.10.2026 по 12.10.2026 ( TID 30061802)";
    const fee = "00667 BC 13.10.2026 погашение Дебетовый оборот (внеш) -17262.50 от суммы 34525000.00";
    const { d } = deps({
      docs: [
        {
          object: "Документ.ПоступлениеНаРасчетныйСчет",
          ref: OLD_IN,
          inn: "",
          purpose: acquiring.replace("483,610.84", "1,000.00"),
          snapshot: earlier(),
        },
        {
          object: "Документ.СписаниеСРасчетногоСчета",
          ref: OLD_OUT,
          inn: "",
          purpose: fee,
          snapshot: earlier(),
        },
      ],
    });
    const resolved = await resolvePayments(
      statement([
        payment({ row: 4, inn: "", counterparty: "", purpose: acquiring }),
        payment({ row: 5, inn: "", counterparty: "", direction: "out", purpose: fee, number: "50738889" }),
        payment({ row: 6, inn: "", counterparty: "", purpose: "что-то совсем новое" }),
      ]),
      {},
      d,
    );
    expect(resolved.ready.map((r) => [r.payment.row, r.change.object])).toEqual([
      [4, "Документ.ПоступлениеНаРасчетныйСчет"],
      [5, "Документ.СписаниеСРасчетногоСчета"],
    ]);
    expect(resolved.problems).toEqual([expect.objectContaining({ rows: [6], code: "NO_TEMPLATE" })]);
  });

  it("uses the contract the purpose names, and says so when 1C does not have it", async () => {
    const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const { d } = deps({
      contracts: [
        ["201607534", CONTRACT_17, "17", "2026-01-08T00:00:00"],
        ["201607534", other, "4/4", "2026-01-01T00:00:00"],
      ],
    });
    const resolved = await resolvePayments(
      statement([
        payment({ row: 4, purpose: "По дог. № 4/4 от 01.01.2026 оплата" }),
        payment({ row: 5, number: "102", purpose: "Договор 4/34 от 15.01.2025 оплата" }),
      ]),
      {},
      d,
    );
    expect(resolved.ready).toHaveLength(2);
    expect(resolved.ready[0]?.change.fields).toMatchObject({ ДоговорКонтрагента: { ref: other } });
    expect(resolved.ready[1]?.change.fields).toMatchObject({ ДоговорКонтрагента: { ref: CONTRACT_17 } });
    expect(resolved.notes).toEqual([
      expect.objectContaining({ rows: [5], message: expect.stringContaining("4/34") }),
    ]);
  });

  it("takes the counterparty's bank account from 1C by the number in the statement", async () => {
    const theirs = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const out = earlier({
      СчетКонтрагента: ref("Справочник.БанковскиеСчета", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "старый"),
    });
    const { d } = deps({
      docs: [
        {
          object: "Документ.СписаниеСРасчетногоСчета",
          ref: OLD_OUT,
          inn: "201607534",
          purpose: "x",
          snapshot: out,
        },
      ],
      accounts: [["201607534", theirs, "20208000900000000001"]],
    });
    const resolved = await resolvePayments(
      statement([payment({ direction: "out", account: "20208000900000000001" })]),
      {},
      d,
    );
    expect(resolved.ready[0]?.change.fields).toMatchObject({ СчетКонтрагента: { ref: theirs } });
  });

  it("groups what it could not settle by counterparty", async () => {
    const { d } = deps();
    const resolved = await resolvePayments(
      statement(
        [
          payment({ row: 4 }),
          payment({ row: 6, inn: "999999999", counterparty: "NEW LTD", number: "8" }),
          payment({ row: 7, inn: "999999999", counterparty: "NEW LTD", number: "9" }),
          payment({ row: 8, inn: "12345", counterparty: "BAD" }),
        ],
        [{ row: 8, code: "INN_FORMAT", message: 'INN "12345" has 5 digits' }],
      ),
      {},
      d,
    );
    expect(resolved.ready.map((r) => r.payment.row)).toEqual([4]);
    expect(resolved.problems).toEqual([
      expect.objectContaining({ rows: [8], code: "CHECK", counterparty: "BAD (INN 12345)" }),
      expect.objectContaining({
        rows: [6, 7],
        code: "COUNTERPARTY_NOT_FOUND",
        counterparty: "NEW LTD (INN 999999999)",
      }),
    ]);
  });

  it("says when the counterparty has no earlier payment, and copies the one the model names", async () => {
    const { d } = deps({ docs: [] });
    const asked = await resolvePayments(statement([payment()]), {}, d);
    expect(asked.ready).toEqual([]);
    expect(asked.problems).toEqual([expect.objectContaining({ rows: [4], code: "NO_TEMPLATE" })]);

    const named = deps();
    const answered = await resolvePayments(
      statement([payment()]),
      { overrides: { templates: [{ row: 4, ref: OLD_IN }] } },
      named.d,
    );
    expect(answered.problems).toEqual([]);
    expect(answered.ready).toHaveLength(1);
  });

  it("leaves out payments already in 1C, and is not stopped by a bank account it cannot find", async () => {
    const { d } = deps({ existing: [["2026-09-01T00:00:00", NAVRUZ, 1_500_000]] });
    const resolved = await resolvePayments(
      statement([payment(), payment({ row: 5, number: "102", amount: 100 })]),
      {},
      d,
    );
    expect(resolved.alreadyIn1c).toEqual([4]);
    expect(resolved.ready.map((r) => r.payment.row)).toEqual([5]);

    const none = deps({ ownAccounts: [] });
    const missing = await resolvePayments(statement([payment()]), {}, none.d);
    expect(missing.ready).toHaveLength(1);
    expect(missing.notes).toEqual([
      expect.objectContaining({ message: expect.stringContaining("no bank account") }),
    ]);
    // The copied document keeps its own account.
    expect(missing.ready[0]?.change.fields?.БанковскийСчет).toEqual({
      type: "Справочник.БанковскиеСчета",
      ref: "77777777-7777-4777-8777-777777777777",
    });

    const two = deps({ ownAccounts: [OWN, HYDRO] });
    const ambiguous = await resolvePayments(statement([payment()]), {}, two.d);
    expect(ambiguous.ready).toHaveLength(1);
    const chosen = await resolvePayments(statement([payment()]), { overrides: { ownAccount: OWN } }, two.d);
    expect(chosen.notes).toEqual([]);
    expect(chosen.ready[0]?.change.fields?.БанковскийСчет).toEqual({
      type: "Справочник.БанковскиеСчета",
      ref: OWN,
    });

    const twins = deps({
      counterparties: [
        ["201607534", NAVRUZ, "NAVRO'Z-PTK"],
        ["201607534", HYDRO, "NAVRUZ dublikat"],
      ],
    });
    const dup = await resolvePayments(statement([payment()]), {}, twins.d);
    expect(dup.problems[0]).toMatchObject({ code: "COUNTERPARTY_AMBIGUOUS", candidates: expect.any(Array) });
  });

  it("does not copy a supplier payment for a payment to the budget, unless the model names the tax document", async () => {
    const treasury = payment({
      row: 6,
      direction: "out",
      counterparty: "O‘zbekiston Respublikasi Iqtisodiyot Va Moliya Vazirligi",
      purpose: "Mol-mulk solig'i 5929938.78",
    });
    const tax = payment({ row: 7, direction: "out", number: "9", purpose: "ЖШДС за сентябрь" });
    const supplier = payment({
      row: 8,
      direction: "out",
      number: "10",
      purpose: "оплата за товары по договору 17",
    });
    expect([treasury, tax, supplier].map(isTaxPayment)).toEqual([true, true, false]);
    expect(isTaxPayment(payment({ direction: "in", purpose: "налог" }))).toBe(false);

    const { d } = deps({
      docs: [
        {
          object: "Документ.СписаниеСРасчетногоСчета",
          ref: OLD_OUT,
          inn: "201607534",
          purpose: "x",
          snapshot: earlier(),
        },
      ],
    });
    const resolved = await resolvePayments(statement([treasury, tax, supplier]), {}, d);
    expect(resolved.ready.map((r) => r.payment.row)).toEqual([8]);
    expect(resolved.problems).toEqual([expect.objectContaining({ rows: [6, 7], code: "TAX_PAYMENT" })]);

    const named = await resolvePayments(
      statement([treasury]),
      { overrides: { templates: [{ row: 6, ref: OLD_OUT }] } },
      d,
    );
    expect(named.problems).toEqual([]);
    expect(named.ready).toHaveLength(1);
  });

  it("takes only the rows asked for", async () => {
    const { d } = deps();
    const resolved = await resolvePayments(
      statement([payment({ row: 4 }), payment({ row: 5, number: "102", amount: 300 })]),
      { only: [5] },
      d,
    );
    expect(resolved.ready.map((r) => r.payment.row)).toEqual([5]);
  });
});
