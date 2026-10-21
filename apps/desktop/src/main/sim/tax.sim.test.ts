/**
 * Simulation: thousands of generated payment purposes. The tax and the period are known by construction, so what the
 * program reads out of the words can be checked against what was put into them.
 */
import { describe, expect, it } from "vitest";

import {
  lagOf,
  periodBefore,
  periodOfPurpose,
  taxKindOf,
  type TaxKind,
  taxPeriodFor,
  usualLag,
} from "../bank/tax.js";
import { cases, Rng, seed } from "./rng.js";

const WORDS: Record<TaxKind, string[]> = {
  ndfl: ["НДФЛ", "ндфл", "подоходный налог", "налог на доходы физических лиц", "JSHDS", "daromad solig'i"],
  social: ["социальный налог", "единый социальный платеж", "ijtimoiy soliq", "ЕСП"],
  inps: ["ИНПС", "INPS", "накопительные взносы"],
  vat: ["НДС", "QQS", "налог на добавленную стоимость"],
  profit: ["налог на прибыль", "foyda solig'i"],
  property: ["налог на имущество", "mol-mulk solig'i"],
  land: ["земельный налог", "yer solig'i"],
  water: ["водный налог", "налог за воду", "suv resurslari solig'i"],
  turnover: ["налог с оборота", "aylanma solig'i"],
  excise: ["акциз", "aksiz solig'i"],
};
const KINDS = Object.keys(WORDS) as TaxKind[];
const MONTHS = [
  "январь",
  "февраль",
  "март",
  "апрель",
  "май",
  "июнь",
  "июль",
  "август",
  "сентябрь",
  "октябрь",
  "ноябрь",
  "декабрь",
];
const MONTHS_OF = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];
const LAT = [
  "yanvar",
  "fevral",
  "mart",
  "aprel",
  "may",
  "iyun",
  "iyul",
  "avgust",
  "sentyabr",
  "oktyabr",
  "noyabr",
  "dekabr",
];
const pad = (n: number) => String(n).padStart(2, "0");

describe("simulation: tax payments read from their purposes", () => {
  it("names the tax, once, whatever else the purpose says", () => {
    const rng = new Rng(seed(30));
    const bad: string[] = [];
    for (let i = 0; i < cases(5000); i++) {
      const kind = rng.pick(KINDS);
      const name = rng.pick(WORDS[kind]);
      const noise = [
        `Оплата ${name}`,
        `Перечисление ${name} по ПП №${rng.int(1, 9999)} от ${pad(rng.int(1, 28))}.${pad(rng.int(1, 12))}.${rng.int(2024, 2026)}`,
        `ИНН ${rng.digits(9)}`,
        `Согласно договору ${rng.int(1, 300)}`,
      ];
      const purpose = rng.shuffle(noise.filter((_, k) => k === 0 || rng.chance(0.6))).join(", ");
      const got = taxKindOf(purpose);
      if (got !== kind) bad.push(`${kind} → ${String(got)} ← ${purpose}`);
    }
    expect(bad.slice(0, 15), `${bad.length}`).toEqual([]);
  });

  it("leaves a payment of two taxes, or of none, to the model", () => {
    const rng = new Rng(seed(31));
    const bad: string[] = [];
    for (let i = 0; i < cases(2500); i++) {
      const [a, b] = rng.shuffle(KINDS);
      const two = `${rng.pick(WORDS[a!])} и ${rng.pick(WORDS[b!])}`;
      if (taxKindOf(two) !== null) bad.push(`TWO ${two}`);
      const none = rng.pick([
        `Оплата по договору №${rng.int(1, 999)} за услуги`,
        `Аренда офиса за ${rng.pick(MONTHS_OF)} ${rng.int(2024, 2026)}`,
        `Оплата за товар согласно счет-фактуре ${rng.int(1, 9999)}`,
        `Зарплата за ${rng.pick(MONTHS_OF)}`,
        `Xizmat uchun to'lov ${rng.int(1, 999)}`,
      ]);
      if (taxKindOf(none) !== null) bad.push(`NONE ${none} → ${String(taxKindOf(none))}`);
    }
    expect(bad.slice(0, 15), `${bad.length}`).toEqual([]);
  });

  it("reads the period out of 'за <month> <year>', '<month> <year>', 'за MM.YYYY' in any of the forms", () => {
    const rng = new Rng(seed(32));
    const bad: string[] = [];
    for (let i = 0; i < cases(6000); i++) {
      const year = rng.int(2023, 2027);
      const m = rng.int(1, 12);
      const paidOn = `${year + (rng.chance(0.2) ? 1 : 0)}-${pad(rng.int(1, 12))}-${pad(rng.int(1, 28))}`;
      const form = rng.int(0, 5);
      const word = form === 5 ? LAT[m - 1]! : rng.chance(0.5) ? MONTHS_OF[m - 1]! : MONTHS[m - 1]!;
      const text = [
        `за ${word} ${year}`,
        `${word} ${year} г.`,
        `за ${pad(m)}.${year}`,
        `${m}/${year}`,
        `налог за ${word} ${year}г`,
        `${word} ${year}`,
      ][form]!;
      const withDate = rng.chance(0.4)
        ? ` по ПП от ${pad(rng.int(13, 28))}.${pad(rng.int(1, 12))}.${rng.int(2024, 2026)}`
        : "";
      const purpose = `${rng.pick(WORDS[rng.pick(KINDS)])} ${text}${withDate}`;
      const got = periodOfPurpose(purpose, paidOn);
      const want = `${year}-${pad(m)}`;
      if (got !== want) bad.push(`${want} → ${got} ← ${purpose}`);
    }
    expect(bad.slice(0, 15), `${bad.length}`).toEqual([]);
  });

  it("a month without a year, after 'за', is the latest such month not after the payment", () => {
    const rng = new Rng(seed(33));
    for (let i = 0; i < cases(3000); i++) {
      const paidY = rng.int(2024, 2026);
      const paidM = rng.int(1, 12);
      const m = rng.int(1, 12);
      const got = periodOfPurpose(`ндфл за ${MONTHS_OF[m - 1]}`, `${paidY}-${pad(paidM)}-15`);
      expect(got).toBe(`${m > paidM ? paidY - 1 : paidY}-${pad(m)}`);
    }
  });

  it("a date in the text is not a period", () => {
    const rng = new Rng(seed(34));
    for (let i = 0; i < cases(3000); i++) {
      const d = `${pad(rng.int(1, 28))}.${pad(rng.int(1, 12))}.${rng.int(2023, 2027)}`;
      const purpose = rng.pick([`Оплата по договору от ${d}`, `ПП от ${d} налог`, `Согласно счету от ${d}`]);
      expect(periodOfPurpose(purpose, "2026-10-12"), purpose).toBe("");
    }
  });

  it("the company's habit: the usual lag wins, a period for the payment's own month or later is no habit, the date is right", () => {
    const rng = new Rng(seed(35));
    for (let i = 0; i < cases(3000); i++) {
      const lag = rng.int(0, 3);
      const history = Array.from({ length: rng.int(2, 12) }, () => {
        const date = `${rng.int(2024, 2026)}-${pad(rng.int(1, 12))}-${pad(rng.int(1, 28))}`;
        return { date, period: periodBefore(date, lag).slice(0, 7) };
      });
      // The odd one out: a correction for an old period.
      if (history.length > 4)
        history[0] = { date: history[0]!.date, period: periodBefore(history[0]!.date, 30).slice(0, 7) };
      expect(usualLag(history)).toBe(lag);
      const paidOn = `${rng.int(2024, 2026)}-${pad(rng.int(1, 12))}-${pad(rng.int(1, 28))}`;
      const period = taxPeriodFor("налог на прибыль", paidOn, history);
      expect(period?.source).toBe("habit");
      expect(period?.value).toMatch(/^\d{4}-\d{2}-01T00:00:00$/);
      expect(lagOf(paidOn, period!.value.slice(0, 7))).toBe(lag);
      // The purpose names a period: it wins over the habit.
      const named = taxPeriodFor("ндфл за март 2025", paidOn, history);
      expect(named).toEqual({ value: "2025-03-01T00:00:00", source: "purpose" });
      // Nothing to learn from, nothing named: no guess.
      expect(taxPeriodFor("ндфл", paidOn, [])).toBeNull();
    }
  });
});
