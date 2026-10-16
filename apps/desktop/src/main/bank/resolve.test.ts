import { describe, expect, it } from "vitest";

import type { RunQueryInput } from "@platform/shared";

import { type BankDeps, copyTemplate, resolvePayments } from "./resolve.js";
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
    ВидОперации: ref("Перечисление.ВидыОперацийПоступлениеНаРасчетныйСчет", "Оплата", "Оплата"),
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

function deps(
  opts: {
    ownAccounts?: string[];
    counterparties?: [string, string, string][];
    templates?: Record<string, ReturnType<typeof earlier> | null>;
    existing?: [string, string, number][];
  } = {},
) {
  const seen: RunQueryInput[] = [];
  const object = (name: string, id: string) => (name === "Документ.СписаниеСРасчетногоСчета" ? OLD_OUT : id);
  const d: BankDeps = {
    async query(input) {
      seen.push(input);
      const q = input.query;
      if (q.includes("Справочник.БанковскиеСчета")) {
        return {
          ok: true,
          data: {
            rows: (opts.ownAccounts ?? [OWN]).map((id) => [ref("Справочник.БанковскиеСчета", id, "р/с")]),
          },
        };
      }
      if (q.includes("Справочник.Контрагенты")) {
        return {
          ok: true,
          data: {
            rows: (opts.counterparties ?? [["201607534", NAVRUZ, "NAVRO'Z-PTK"]]).map(([inn, id, name]) => [
              inn,
              ref("Справочник.Контрагенты", id, name),
              name,
            ]),
          },
        };
      }
      if (q.includes("ПЕРВЫЕ 1")) {
        const key = `${q.includes("СписаниеС") ? "out" : "in"}|${String(input.params?.к)}`;
        const found = opts.templates ? opts.templates[key] : earlier();
        return {
          ok: true,
          data: {
            rows: found
              ? [
                  [
                    ref(
                      q.includes("СписаниеС")
                        ? "Документ.СписаниеСРасчетногоСчета"
                        : "Документ.ПоступлениеНаРасчетныйСчет",
                      object(q, OLD_IN),
                      "старый",
                    ),
                  ],
                ]
              : [],
          },
        };
      }
      return {
        ok: true,
        data: {
          rows: (opts.existing ?? []).map(([date, id, sum]) => [
            ref("Справочник.Контрагенты", id, "x"),
            date,
            sum,
          ]),
        },
      };
    },
    async describe() {
      return { ok: true, data: [] };
    },
    async getObject(objectName, id) {
      const key = `${objectName.includes("Списание") ? "out" : "in"}|${NAVRUZ}`;
      const found = opts.templates ? (opts.templates[key] ?? null) : earlier();
      return found && (id === OLD_IN || id === OLD_OUT)
        ? { ok: true, data: { object: objectName, ref: id, ...found } }
        : { ok: false, code: "NOT_FOUND", message: "no such document" };
    },
  };
  return { d, seen };
}

describe("copying the counterparty's last payment", () => {
  it("keeps the company's own contract and accounts, and changes date, amount, number and purpose", () => {
    const template = { object: "Документ.ПоступлениеНаРасчетныйСчет", ref: OLD_IN, ...earlier() };
    const made = copyTemplate(template, payment({ amount: 50_000_000 }), OWN);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.change).toMatchObject({
      action: "create",
      object: "Документ.ПоступлениеНаРасчетныйСчет",
      post: false,
      fields: {
        Date: "2026-09-01",
        СуммаДокумента: 500_000,
        НазначениеПлатежа: "Оплата по договору №17",
        НомерВходящегоДокумента: "101",
        ДатаВходящегоДокумента: "2026-09-01",
        БанковскийСчет: { ref: OWN },
        Контрагент: { ref: NAVRUZ },
        ВидОперации: "Оплата",
      },
    });
    expect(made.change.fields).not.toHaveProperty("Номер");
    expect(made.change.fields).not.toHaveProperty("Проведен");
    // The breakdown row scales with the new amount; the contract and the account stay.
    expect(made.change.tables?.РасшифровкаПлатежа).toEqual([
      expect.objectContaining({
        СуммаПлатежа: 500_000,
        СуммаВзаиморасчетов: 500_000,
        СуммаНДС: 53_571.43,
        КурсВзаиморасчетов: 1,
        ДоговорКонтрагента: { ref: "88888888-8888-4888-8888-888888888888" },
        СчетРасчетов: { ref: "99999999-9999-4999-8999-999999999999" },
      }),
    ]);
  });

  it("refuses what it cannot copy honestly: a split payment, another currency, an unbalanced breakdown", () => {
    const base = { object: "Документ.ПоступлениеНаРасчетныйСчет", ref: OLD_IN };
    const one = earlier().tables.РасшифровкаПлатежа[0] ?? {};
    const split = copyTemplate(
      { ...base, ...earlier(), tables: { РасшифровкаПлатежа: [one, one] } },
      payment(),
      OWN,
    );
    expect(split).toMatchObject({ ok: false, message: expect.stringContaining("2 rows") });
    const usd = copyTemplate(
      { ...base, ...earlier(), tables: { РасшифровкаПлатежа: [{ ...one, КурсВзаиморасчетов: 12_700 }] } },
      payment(),
      OWN,
    );
    expect(usd).toMatchObject({ ok: false, message: expect.stringContaining("foreign currency") });
    const off = copyTemplate(
      { ...base, ...earlier(), tables: { РасшифровкаПлатежа: [{ ...one, СуммаПлатежа: 5 }] } },
      payment(),
      OWN,
    );
    expect(off).toMatchObject({ ok: false, message: expect.stringContaining("does not add up") });
    const none = copyTemplate({ ...base, ...earlier({ СуммаДокумента: 0 }) }, payment(), OWN);
    expect(none.ok).toBe(false);
  });
});

describe("bank payments for 1C", () => {
  it("makes a ready document of each payment whose counterparty and earlier payment it finds", async () => {
    const { d } = deps();
    const resolved = await resolvePayments(statement([payment()]), {}, d);
    expect(resolved.problems).toEqual([]);
    expect(resolved.ready).toHaveLength(1);
    expect(resolved.ready[0]?.change.fields).toMatchObject({
      СуммаДокумента: 1_500_000,
      БанковскийСчет: { ref: OWN },
    });
  });

  it("groups what it could not settle by counterparty", async () => {
    const { d } = deps({ templates: { [`in|${NAVRUZ}`]: earlier() } });
    const resolved = await resolvePayments(
      statement(
        [
          payment({ row: 4 }),
          payment({ row: 5, inn: "", counterparty: "Банк", direction: "out", number: "7" }),
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
      expect.objectContaining({ rows: [5], code: "NO_INN" }),
      expect.objectContaining({
        rows: [6, 7],
        code: "COUNTERPARTY_NOT_FOUND",
        counterparty: "NEW LTD (INN 999999999)",
      }),
    ]);
  });

  it("says when the counterparty has no earlier payment, and copies the one the model names", async () => {
    const { d } = deps({ templates: { [`in|${NAVRUZ}`]: null } });
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

  it("leaves out payments already in 1C and asks when the bank account or the counterparty is ambiguous", async () => {
    const { d } = deps({ existing: [["2026-09-01T00:00:00", NAVRUZ, 1_500_000]] });
    const resolved = await resolvePayments(
      statement([payment(), payment({ row: 5, number: "102", amount: 100 })]),
      {},
      d,
    );
    expect(resolved.alreadyIn1c).toEqual([4]);
    expect(resolved.ready.map((r) => r.payment.row)).toEqual([5]);

    const two = deps({ ownAccounts: [OWN, HYDRO] });
    const ambiguous = await resolvePayments(statement([payment()]), {}, two.d);
    expect(ambiguous.ready).toEqual([]);
    expect(ambiguous.problems[0]).toMatchObject({ code: "BANK_ACCOUNT_AMBIGUOUS", rows: [4] });
    const chosen = await resolvePayments(statement([payment()]), { overrides: { ownAccount: OWN } }, two.d);
    expect(chosen.ready).toHaveLength(1);

    const twins = deps({
      counterparties: [
        ["201607534", NAVRUZ, "NAVRO'Z-PTK"],
        ["201607534", HYDRO, "NAVRUZ dublikat"],
      ],
    });
    const dup = await resolvePayments(statement([payment()]), {}, twins.d);
    expect(dup.problems[0]).toMatchObject({ code: "COUNTERPARTY_AMBIGUOUS", candidates: expect.any(Array) });
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
