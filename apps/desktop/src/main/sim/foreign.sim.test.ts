/**
 * Simulation: thousands of payments copied for a foreign-currency account and of own-account moves. Whatever the
 * amounts, the rates and the shape of the earlier document, the copy's figures must follow the payment: the sum, the
 * breakdown, the settlement at the rate; and a copy that cannot be honest must be refused, never guessed.
 */
import { describe, expect, it } from "vitest";

import { copyTemplate } from "../bank/resolve.js";
import type { BankPayment } from "../bank/statement.js";
import { cases, Rng, seed } from "./rng.js";

const ref = (type: string, id: string, name: string) => ({ type, ref: id, name });
const CONTRACT = "33333333-3333-4333-8333-333333333333";

function template(rng: Rng, settled: "usd" | "soums", currency: "foreign" | "soums") {
  const oldTotal = rng.money(10, 900_000, true);
  const oldRate = currency === "soums" ? 1 : rng.money(8000, 14000, true);
  const row: Record<string, unknown> = {
    ДоговорКонтрагента: ref("Справочник.ДоговорыКонтрагентов", CONTRACT, "№7"),
    СуммаПлатежа: oldTotal,
    КурсВзаиморасчетов: oldRate,
    КратностьВзаиморасчетов: 1,
    СуммаВзаиморасчетов:
      settled === "soums" && currency === "foreign" ? Math.round(oldTotal * oldRate * 100) / 100 : oldTotal,
    СуммаНДС: 0,
  };
  return {
    object: "Документ.СписаниеСРасчетногоСчета",
    ref: "55555555-5555-4555-8555-555555555555",
    fields: {
      Номер: "1",
      Дата: "2026-08-10T00:00:00",
      Проведен: true,
      Контрагент: ref("Справочник.Контрагенты", "22222222-2222-4222-8222-222222222222", "ACME"),
      БанковскийСчет: ref("Справочник.БанковскиеСчета", "88888888-8888-4888-8888-888888888888", "x"),
      ДоговорКонтрагента: ref("Справочник.ДоговорыКонтрагентов", CONTRACT, "№7"),
      СуммаДокумента: oldTotal,
      НазначениеПлатежа: "старое",
    },
    tables: { РасшифровкаПлатежа: [row] },
    oldTotal,
    oldRate,
  };
}

describe("simulation: payments in a currency are copied honestly", () => {
  it("the breakdown follows the payment, the rate is the day's, the settlement follows the rate", () => {
    const rng = new Rng(seed(110));
    for (let i = 0; i < cases(4000); i++) {
      const settled = rng.pick(["usd", "soums"] as const);
      const t = template(rng, settled, "foreign");
      const tiyin = rng.int(100, 9_999_999_999);
      const rate = rng.chance(0.15) ? null : rng.money(8000, 14000, true);
      const payment = {
        row: 4,
        date: "2026-09-10",
        number: "9",
        direction: "out",
        amount: tiyin,
        counterparty: "ACME",
        inn: "1",
        account: "",
        mfo: "",
        purpose: "p",
      } as BankPayment;
      const made = copyTemplate(t, payment, { foreign: { currency: "USD", rate } });
      expect(made.ok).toBe(true);
      if (!made.ok) continue;
      const row = made.change.tables?.РасшифровкаПлатежа?.[0] as Record<string, number>;
      const amount = tiyin / 100;
      expect(made.change.fields?.СуммаДокумента).toBe(amount);
      expect(Math.abs((row.СуммаПлатежа ?? 0) - amount)).toBeLessThan(0.006);
      const usedRate = rate ?? t.oldRate;
      expect(row.КурсВзаиморасчетов).toBe(usedRate);
      if (settled === "soums" && rate !== null)
        expect(Math.abs((row.СуммаВзаиморасчетов ?? 0) - amount * rate)).toBeLessThan(0.006);
      if (settled === "usd") expect(Math.abs((row.СуммаВзаиморасчетов ?? 0) - amount)).toBeLessThan(0.006);
      // The copy says when it could not take the day's rate.
      expect(made.notes?.length).toBe(1);
      if (rate === null) expect(made.notes?.[0]).toContain("was not found");
    }
  });

  it("refuses the wrong currency both ways, always", () => {
    const rng = new Rng(seed(111));
    for (let i = 0; i < cases(2000); i++) {
      const payment = {
        row: 1,
        date: "2026-09-10",
        number: "1",
        direction: "out",
        amount: rng.int(100, 99_999_999),
        counterparty: "A",
        inn: "1",
        account: "",
        mfo: "",
        purpose: "p",
      } as BankPayment;
      const soums = template(rng, "soums", "soums");
      expect(copyTemplate(soums, payment, { foreign: { currency: "USD", rate: 12_700 } }).ok).toBe(false);
      const dollars = template(rng, rng.pick(["usd", "soums"] as const), "foreign");
      expect(copyTemplate(dollars, payment, {}).ok).toBe(false);
      expect(copyTemplate(soums, payment, {}).ok).toBe(true);
    }
  });
});
