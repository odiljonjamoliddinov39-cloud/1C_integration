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
  /** The counterparty's name, for a base looked up by name. */
  name?: string;
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
    /** Posted tax payments: ref, date, period, name of the tax, purpose. */
    tax?: [string, string, string, string, string][];
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
        // Asked by name (the bank wrote no INN): the first column is the name, as in the query.
        const byName = q.includes("Т.Наименование В");
        const asked = Object.values(input.params ?? {});
        return rows(
          (opts.counterparties ?? [["201607534", NAVRUZ, "NAVRO'Z-PTK"]])
            .filter(([, , name]) => !byName || asked.includes(name))
            .map(([inn, id, name]) => [byName ? name : inn, ref("Справочник.Контрагенты", id, name), name]),
        );
      }
      if (q.includes("Налог.Наименование")) {
        return rows(
          (opts.tax ?? []).map(([id, date, period, name, purpose]) => [
            ref("Документ.СписаниеСРасчетногоСчета", id, "налог"),
            date,
            period,
            ref("Справочник.ВидыНалоговИПлатежейВБюджет", "t", name),
            purpose,
          ]),
        );
      }
      if (q.includes("ПЕРВЫЕ")) {
        const object = q.includes("СписаниеС")
          ? "Документ.СписаниеСРасчетногоСчета"
          : "Документ.ПоступлениеНаРасчетныйСчет";
        const byInn = q.includes("Контрагент.ИНН =");
        const byName = q.includes("Контрагент.Наименование =");
        return rows(
          docs
            .filter(
              (x) =>
                x.object === object &&
                (!byInn || x.inn === input.params?.инн) &&
                (!byName || x.name === input.params?.имя),
            )
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
    // The counterparty of a row with no INN is the earlier payment's: the note says whose.
    expect(resolved.notes).toEqual([
      expect.objectContaining({ rows: [4], message: expect.stringContaining(`"NAVRO'Z-PTK"`) }),
      expect.objectContaining({ rows: [5], message: expect.stringContaining("no INN") }),
    ]);
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
    // With no payment of the same tax in 1C there is nothing to copy: each is named, with the tax.
    expect(resolved.problems.map((p) => [p.rows, p.code])).toEqual([
      [[6], "TAX_PAYMENT"],
      [[7], "TAX_PAYMENT"],
    ]);
    expect(resolved.problems[0]?.message).toContain("property");

    const named = await resolvePayments(
      statement([treasury]),
      { overrides: { templates: [{ row: 6, ref: OLD_OUT }] } },
      d,
    );
    expect(named.problems).toEqual([]);
    expect(named.ready).toHaveLength(1);
  });

  describe("payments to the budget", () => {
    const TAX_DOC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const taxDoc = (period: string, date: string) =>
      ({
        fields: {
          Номер: "0000-000000005600",
          Дата: date,
          Проведен: true,
          ВидОперации: ref(
            "Перечисление.ВидыОперацийСписаниеДенежныхСредств",
            "УплатаНалога",
            "Уплата налога",
          ),
          БанковскийСчет: ref("Справочник.БанковскиеСчета", "77777777-7777-4777-8777-777777777777", "старый"),
          Налог: ref("Справочник.ВидыНалоговИПлатежейВБюджет", "t", "Налог на доходы физических лиц"),
          НалоговыйПериод: period,
          ИФНС: ref("Справочник.ГНИ", "g", "2607"),
          СчетКонтрагента: ref("Справочник.БанковскиеСчета", "d", "23402000300100001010"),
          СуммаДокумента: 3_000_000,
          НазначениеПлатежа: "НДФЛ за июнь",
        },
        tables: {
          РасшифровкаПлатежа: [{ Сумма: 3_000_000, СуммаПлатежа: 3_000_000, КурсВзаиморасчетов: 1 }],
        },
      }) as unknown as ReturnType<typeof earlier>;
    const ndfl = payment({
      row: 9,
      direction: "out",
      date: "2026-10-19",
      amount: 374_000_000,
      number: "77",
      counterparty: "Davlat soliq qo'mitasi",
      inn: "201122919",
      purpose: "НДФЛ",
    });
    const history = (): [string, string, string, string, string][] => [
      [
        TAX_DOC,
        "2026-07-13T00:00:00",
        "2026-06-01T00:00:00",
        "Налог на доходы физических лиц",
        "НДФЛ за июнь",
      ],
      [
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "2026-06-12T00:00:00",
        "2026-05-01T00:00:00",
        "Налог на доходы физических лиц",
        "НДФЛ",
      ],
      [
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        "2026-07-13T00:00:00",
        "2026-06-01T00:00:00",
        "Единый социальный платеж",
        "ЕСП",
      ],
    ];

    it("copies the company's latest payment of the same tax, with the period the company's habit gives", async () => {
      const { d } = deps({
        tax: history(),
        docs: [
          {
            object: "Документ.СписаниеСРасчетногоСчета",
            ref: TAX_DOC,
            inn: "201122919",
            purpose: "НДФЛ за июнь",
            snapshot: taxDoc("2026-06-01T00:00:00", "2026-07-13T00:00:00"),
          },
        ],
      });
      const resolved = await resolvePayments(statement([ndfl]), {}, d);
      expect(resolved.problems).toEqual([]);
      expect(resolved.ready).toHaveLength(1);
      const change = resolved.ready[0]!.change;
      expect(change).toMatchObject({
        action: "create",
        object: "Документ.СписаниеСРасчетногоСчета",
        post: false,
      });
      expect(change.fields).toMatchObject({
        СуммаДокумента: 3_740_000,
        НалоговыйПериод: "2026-09-01T00:00:00",
        Дата: "2026-10-19",
        НазначениеПлатежа: "НДФЛ",
      });
      // The tax office and the tax stay the earlier payment's.
      expect(change.fields?.ИФНС).toMatchObject({ ref: "g" });
      expect(change.fields?.Налог).toMatchObject({ ref: "t" });
      expect(resolved.notes[0]?.message).toContain("the month before");
      // No counterparty was looked up for the treasury.
      expect(resolved.missing).toEqual([]);
    });

    it("takes the period the purpose names over the habit", async () => {
      const { d } = deps({
        tax: history(),
        docs: [
          {
            object: "Документ.СписаниеСРасчетногоСчета",
            ref: TAX_DOC,
            inn: "201122919",
            purpose: "НДФЛ за июнь",
            snapshot: taxDoc("2026-06-01T00:00:00", "2026-07-13T00:00:00"),
          },
        ],
      });
      const resolved = await resolvePayments(statement([{ ...ndfl, purpose: "НДФЛ за август 2026" }]), {}, d);
      expect(resolved.ready[0]?.change.fields).toMatchObject({ НалоговыйПериод: "2026-08-01T00:00:00" });
      expect(resolved.notes[0]?.message).toContain("as the purpose says");
    });

    it("does not guess a tax the company has never paid, and asks for a template", async () => {
      const { d } = deps({ tax: history() });
      const resolved = await resolvePayments(
        statement([{ ...ndfl, purpose: "Налог на прибыль за 3 квартал" }]),
        {},
        d,
      );
      expect(resolved.ready).toEqual([]);
      expect(resolved.problems[0]).toMatchObject({ code: "TAX_PAYMENT" });
      expect(resolved.problems[0]?.message).toContain("profit");
    });
  });

  it("offers to create a counterparty the statement names, then its contract, then the payment", async () => {
    const NEW_CP = "cccccccc-0000-4ccc-8ccc-cccccccccccc";
    const NEW_CONTRACT = "dddddddd-0000-4ddd-8ddd-dddddddddddd";
    const purpose = "Оплата по договору № 183 от 15.10.2026 за товары";
    const row = payment({
      row: 9,
      direction: "out",
      inn: "999999999",
      counterparty: "Sam active group 786 mchj",
      purpose,
    });
    // The company's usual supplier payment: it has a contract, whose kind and settlement rules are copied.
    const contractDoc: Doc = {
      object: "Справочник.ДоговорыКонтрагентов",
      ref: CONTRACT_17,
      inn: "",
      purpose: "",
      snapshot: {
        fields: {
          Код: "000000017",
          Наименование: "№17 от 08.01.2026",
          Владелец: ref("Справочник.Контрагенты", NAVRUZ, "NAVRO'Z-PTK"),
          ВидДоговора: ref("Перечисление.ВидыДоговоровКонтрагентов", "СПоставщиком", "С поставщиком"),
          ВалютаВзаиморасчетов: ref("Справочник.Валюты", "eeeeeeee-0000-4eee-8eee-eeeeeeeeeeee", "UZS"),
          СрокДействия: "2026-12-31T00:00:00",
          Номер: "17",
          Дата: "2026-01-08T00:00:00",
        },
        tables: {},
      } as never,
    };
    const supplierDoc: Doc = {
      object: "Документ.СписаниеСРасчетногоСчета",
      ref: OLD_OUT,
      inn: "201607534",
      purpose: "x",
      snapshot: earlier(),
    };

    // Round 1: nobody is in 1C yet: the counterparty is offered, and its payment waits.
    const first = deps({ docs: [supplierDoc, contractDoc], counterparties: [] });
    const one = await resolvePayments(statement([row]), { createMissing: true }, first.d);
    expect(one.missing).toEqual([
      { inn: "999999999", name: "Sam active group 786 mchj", rows: [9], key: "999999999" },
    ]);
    expect(one.problems).toEqual([]);
    expect(one.ready).toEqual([]);
    // A person's INN (14 digits) or a row with no name is not created from a statement.
    const person = await resolvePayments(
      statement([
        payment({ row: 4, inn: "12345678901234", counterparty: "Person" }),
        payment({ row: 5, counterparty: " " }),
      ]),
      { createMissing: true },
      first.d,
    );
    expect(person.missing).toEqual([]);

    // Round 2: the counterparty exists now: its contract is offered, made like the company's other contracts.
    const created = deps({
      docs: [supplierDoc, contractDoc],
      counterparties: [["999999999", NEW_CP, "Sam active group 786 mchj"]],
    });
    const two = await resolvePayments(
      statement([row]),
      { createMissing: true, fresh: new Set(["999999999"]) },
      created.d,
    );
    expect(two.ready).toEqual([]);
    expect(two.problems).toEqual([]);
    expect(two.contractsToCreate).toHaveLength(1);
    expect(two.contractsToCreate[0]?.change).toMatchObject({
      action: "create",
      object: "Справочник.ДоговорыКонтрагентов",
      fields: {
        Владелец: { type: "Справочник.Контрагенты", ref: NEW_CP },
        Номер: "183",
        Дата: "2026-10-15",
        Наименование: "№183 от 15.10.2026",
        ВидДоговора: "СПоставщиком",
        ВалютаВзаиморасчетов: { type: "Справочник.Валюты" },
      },
    });
    const fields = two.contractsToCreate[0]?.change.fields ?? {};
    for (const copied of ["Код", "СрокДействия"]) expect(fields).not.toHaveProperty(copied);

    // Round 3: the contract exists: the payment is made, with the new counterparty and its contract.
    const done = deps({
      docs: [supplierDoc, contractDoc],
      counterparties: [["999999999", NEW_CP, "Sam active group 786 mchj"]],
      contracts: [["999999999", NEW_CONTRACT, "183", "2026-10-15T00:00:00"]],
    });
    const three = await resolvePayments(
      statement([row]),
      { createMissing: true, fresh: new Set(["999999999"]) },
      done.d,
    );
    expect(three.contractsToCreate).toEqual([]);
    expect(three.ready).toHaveLength(1);
    expect(three.ready[0]?.change.fields).toMatchObject({
      Контрагент: { ref: NEW_CP },
      ДоговорКонтрагента: { ref: NEW_CONTRACT },
      СуммаДокумента: 1_500_000,
    });
    expect(three.notes).toEqual([
      expect.objectContaining({ rows: [9], message: expect.stringContaining("new counterparty") }),
    ]);

    // No contract named in the purpose: a neutral one is made, "№б/н от <the earliest payment's date>".
    const bareRow = { ...row, purpose: "за товары", date: "2026-10-15" };
    const bare = await resolvePayments(
      statement([bareRow, { ...bareRow, row: 10, date: "2026-10-17" }]),
      { createMissing: true, fresh: new Set(["999999999"]) },
      created.d,
    );
    expect(bare.problems).toEqual([]);
    expect(bare.ready).toEqual([]);
    expect(bare.contractsToCreate).toHaveLength(1);
    expect(bare.contractsToCreate[0]).toMatchObject({
      rows: [9, 10],
      change: { fields: { Номер: "б/н", Дата: "2026-10-15", Наименование: "№б/н от 15.10.2026" } },
    });
    // Once it exists, both payments use it, and the accountant is told.
    const neutralDone = deps({
      docs: [supplierDoc, contractDoc],
      counterparties: [["999999999", NEW_CP, "Sam active group 786 mchj"]],
      contracts: [["999999999", NEW_CONTRACT, "б/н", "2026-10-15T00:00:00"]],
    });
    const used = await resolvePayments(
      statement([bareRow, { ...bareRow, row: 10, date: "2026-10-17" }]),
      { createMissing: true, fresh: new Set(["999999999"]) },
      neutralDone.d,
    );
    expect(used.ready).toHaveLength(2);
    expect(used.ready[1]?.change.fields).toMatchObject({ ДоговорКонтрагента: { ref: NEW_CONTRACT } });
    expect(used.notes[0]?.message).toContain("neutral");
  });

  it("looks past payments that cannot be copied to find the company's usual one for a new counterparty", async () => {
    const NEW_CP = "cccccccc-0000-4ccc-8ccc-cccccccccccc";
    const one = earlier().tables.РасшифровкаПлатежа[0] ?? {};
    // Twelve newer payments split over two contracts (not copyable), then one that is.
    const split: Doc[] = Array.from({ length: 12 }, (_, i) => ({
      object: "Документ.СписаниеСРасчетногоСчета",
      ref: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
      inn: "201607534",
      purpose: "x",
      snapshot: { ...earlier(), tables: { РасшифровкаПлатежа: [one, one] } } as never,
    }));
    const usual: Doc = {
      object: "Документ.СписаниеСРасчетногоСчета",
      ref: OLD_OUT,
      inn: "201607534",
      purpose: "x",
      snapshot: earlier(),
    };
    const { d } = deps({
      docs: [...split, usual],
      counterparties: [["999999999", NEW_CP, "NEW LTD"]],
      contracts: [["999999999", "dddddddd-0000-4ddd-8ddd-dddddddddddd", "5", "2026-10-15T00:00:00"]],
    });
    const resolved = await resolvePayments(
      statement([
        payment({
          row: 9,
          direction: "out",
          inn: "999999999",
          counterparty: "NEW LTD",
          purpose: "Договор 5 от 15.10.2026",
        }),
      ]),
      { createMissing: true, fresh: new Set(["999999999"]) },
      d,
    );
    expect(resolved.problems).toEqual([]);
    expect(resolved.ready).toHaveLength(1);
  });

  it("finds a payer by name when the bank wrote no INN (nine zeros), and creates it by name when 1C lacks it", async () => {
    const NEW_CP = "cccccccc-0000-4ccc-8ccc-cccccccccccc";
    const NAME = '"AMERHANOVA-VINERA" hususiy tadbirkor';
    const person = payment({
      row: 6,
      inn: "",
      innZero: true,
      counterparty: NAME,
      purpose: "Оплата за товар",
    });
    const docs: Doc[] = [
      {
        object: "Документ.ПоступлениеНаРасчетныйСчет",
        ref: OLD_IN,
        inn: "000000000",
        name: NAME,
        purpose: "старое",
        snapshot: earlier({ Контрагент: ref("Справочник.Контрагенты", NEW_CP, NAME) }),
      },
    ];
    // In 1C by name: its own earlier payment is the template, and no INN is asked for.
    const there = deps({ docs, counterparties: [["000000000", NEW_CP, NAME]] });
    const found = await resolvePayments(statement([person]), { createMissing: true }, there.d);
    expect(found.missing).toEqual([]);
    expect(found.problems).toEqual([]);
    expect(found.ready).toHaveLength(1);
    expect(found.ready[0]?.change.fields).toMatchObject({ Контрагент: { ref: NEW_CP } });
    expect(found.notes).toEqual([]);
    expect(there.seen.some((q) => q.params?.инн !== undefined)).toBe(false);

    // Not in 1C: offered for creation under the zeros the bank wrote, by name.
    const nowhere = deps({ docs, counterparties: [] });
    const offered = await resolvePayments(statement([person]), { createMissing: true }, nowhere.d);
    expect(offered.missing).toEqual([
      { inn: "000000000", name: NAME, rows: [6], key: `name:${NAME.toLowerCase()}` },
    ]);
    // Two payers with zeros are two counterparties, not one.
    const other = payment({ row: 7, inn: "", innZero: true, counterparty: "OTHER PERSON", purpose: "x" });
    const two = await resolvePayments(statement([person, other]), { createMissing: true }, nowhere.d);
    expect(two.missing.map((m) => m.name)).toEqual([NAME, "OTHER PERSON"]);
    // Without leave to create, it is said by name.
    const stopped = await resolvePayments(statement([person]), {}, nowhere.d);
    expect(stopped.problems).toEqual([
      expect.objectContaining({ code: "COUNTERPARTY_NOT_FOUND", message: expect.stringContaining("name") }),
    ]);
    // A bank fee with zeros is not a counterparty to create.
    const fee = payment({
      row: 8,
      direction: "out",
      inn: "",
      innZero: true,
      counterparty: "Банк",
      purpose: "Комиссия банка за услуги",
    });
    const feed = await resolvePayments(statement([fee]), { createMissing: true }, nowhere.d);
    expect(feed.missing).toEqual([]);
  });

  it("books an acquiring receipt gross and its commission as a document of its own", async () => {
    const acquiring =
      "00634SmartVista - Выручка CRYSTAL WATER TRADE 483,610.84 сум с 12.10.2026 по 12.10.2026 ( TID 30061802) от сумма: 484,580.00 в том числе комиссия (0.2%) 969.16";
    const receipt = payment({ row: 4, inn: "", counterparty: "", purpose: acquiring, amount: 48_361_084 });
    const docs: Doc[] = [
      {
        object: "Документ.ПоступлениеНаРасчетныйСчет",
        ref: OLD_IN,
        inn: "",
        purpose: acquiring.replace("483,610.84", "1,000.00"),
        snapshot: { ...earlier({ СуммаДокумента: 1000 }), tables: {} } as never,
      },
    ];
    const fee: Doc = {
      object: "Документ.СписаниеСРасчетногоСчета",
      ref: OLD_OUT,
      inn: "",
      purpose: "Комиссия эквайринга SmartVista 0.2% за 11.10.2026",
      snapshot: {
        ...earlier({ СуммаДокумента: 800, НазначениеПлатежа: "Комиссия эквайринга" }),
        tables: {},
      } as never,
    };

    const both = await resolvePayments(statement([receipt]), {}, deps({ docs: [...docs, fee] }).d);
    expect(both.problems).toEqual([]);
    expect(both.ready.map((r) => [r.change.object, r.change.fields?.СуммаДокумента, r.part])).toEqual([
      ["Документ.ПоступлениеНаРасчетныйСчет", 484_580, undefined],
      ["Документ.СписаниеСРасчетногоСчета", 969.16, "commission"],
    ]);
    expect(both.notes.map((n) => n.message)).toEqual([
      expect.stringContaining("no INN"),
      expect.stringContaining("booked gross"),
    ]);

    // No earlier acquiring commission document to copy: the receipt is net, and it says so.
    const noFee = await resolvePayments(statement([receipt]), {}, deps({ docs }).d);
    expect(noFee.ready.map((r) => r.change.fields?.СуммаДокумента)).toEqual([483_610.84]);
    expect(noFee.notes.map((n) => n.message)).toContainEqual(
      expect.stringContaining("no earlier acquiring commission"),
    );

    // Asked to keep it net.
    const net = await resolvePayments(
      statement([receipt]),
      { splitCommission: false },
      deps({ docs: [...docs, fee] }).d,
    );
    expect(net.ready.map((r) => r.change.fields?.СуммаДокумента)).toEqual([483_610.84]);
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
