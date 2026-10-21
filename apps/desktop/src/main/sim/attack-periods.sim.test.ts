/**
 * Attack: the period of a question. A template that takes a period must get the period the person meant (a month, a
 * quarter, a year, a day, a range from one date to another, "last month", "yesterday"), in the three languages and the
 * usual spellings, or hand the question to the model. What must never happen is the current month being quietly
 * answered for a question about another time.
 */
import { describe, expect, it } from "vitest";

import { type QueryTemplateView, seedTemplateInputs } from "@platform/shared";

import { matchTemplate } from "../ai/templates.js";
import { cases, Rng, seed } from "./rng.js";

const views: QueryTemplateView[] = seedTemplateInputs().map((t, i) => ({
  ...t,
  id: String(i),
  version: 1,
  updatedAt: "",
  source: "admin",
  company: null,
  accountName: null,
  hits: 0,
  rejected: 0,
}));
const today = new Date("2026-10-21T10:00:00Z");
const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const ask = (q: string) => matchTemplate(q, views, today);

const MONTHS_RU = [
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
const MONTHS_UZ = [
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
const MONTHS_EN = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

type Expect = { start: string; end: string };
const range = (y: number, m1: number, m2: number): Expect => ({
  start: `${y}-${pad(m1)}-01`,
  end: `${y}-${pad(m2)}-${pad(lastDay(y, m2))}`,
});

function periodQuestion(rng: Rng): { text: string; want: Expect | null } {
  const y = rng.int(2024, 2026);
  const m = rng.int(1, 12);
  const q = rng.int(1, 4);
  const d = rng.int(1, 28);
  const d2 = rng.int(d, 28);
  switch (rng.int(0, 13)) {
    case 0:
      return { text: `выручка за ${MONTHS_RU[m - 1]} ${y}`, want: range(y, m, m) };
    case 1:
      return { text: `daromad ${MONTHS_UZ[m - 1]} ${y}`, want: range(y, m, m) };
    case 2:
      return { text: `revenue for ${MONTHS_EN[m - 1]} ${y}`, want: range(y, m, m) };
    case 3:
      return { text: `выручка за ${q} квартал ${y}`, want: range(y, q * 3 - 2, q * 3) };
    case 4:
      return { text: `выручка за ${q}-й квартал ${y} года`, want: range(y, q * 3 - 2, q * 3) };
    case 5:
      return { text: `daromad ${y} yil ${q}-chorak`, want: range(y, q * 3 - 2, q * 3) };
    case 6:
      return { text: `revenue Q${q} ${y}`, want: range(y, q * 3 - 2, q * 3) };
    case 7:
      return { text: `выручка за ${y} год`, want: range(y, 1, 12) };
    case 8:
      return { text: `daromad ${y} yil uchun`, want: range(y, 1, 12) };
    case 9:
      return { text: `revenue for the year ${y}`, want: range(y, 1, 12) };
    case 10:
      return {
        text: `выручка за ${pad(d)}.${pad(m)}.${y}`,
        want: { start: `${y}-${pad(m)}-${pad(d)}`, end: `${y}-${pad(m)}-${pad(d)}` },
      };
    case 11:
      return {
        text: `выручка с ${pad(d)}.${pad(m)}.${y} по ${pad(d2)}.${pad(m)}.${y}`,
        want: { start: `${y}-${pad(m)}-${pad(d)}`, end: `${y}-${pad(m)}-${pad(d2)}` },
      };
    case 12:
      return { text: "выручка за прошлый год", want: range(2025, 1, 12) };
    default:
      return { text: "выручка за прошлый месяц", want: range(2026, 9, 9) };
  }
}

describe("attack: periods in questions", () => {
  it("get the period asked for, or go to the model — never the current month by default", () => {
    const rng = new Rng(seed(220));
    const wrong: string[] = [];
    let model = 0;
    const n = cases(4000);
    for (let i = 0; i < n; i++) {
      const { text, want } = periodQuestion(rng);
      const match = ask(text);
      if (!match) {
        model++;
        continue;
      }
      if (match.template.code !== "seed_revenue") {
        wrong.push(`${text} → ${match.template.code}`);
        continue;
      }
      const start = match.params["Начало"];
      const end = match.params["Конец"];
      if (want && (start !== want.start || end !== want.end))
        wrong.push(`${text} → ${String(start)}..${String(end)}, wanted ${want.start}..${want.end}`);
    }
    expect(wrong.slice(0, 12), `${wrong.length} wrong`).toEqual([]);
    // The usual ways of asking are understood by the program: the model is for the unusual.
    expect(model / n).toBeLessThan(0.1);
  });

  it("a date or a day word for the balance questions", () => {
    expect(ask("остаток в кассе вчера")?.params["Дата"]).toBe("2026-10-20");
    expect(ask("kassada qoldiq kecha")?.params["Дата"]).toBe("2026-10-20");
    expect(ask("cash balance yesterday")?.params["Дата"]).toBe("2026-10-20");
    expect(ask("остаток в кассе сегодня")?.params["Дата"]).toBe("2026-10-21");
    expect(ask("остаток в кассе на 31.12.2025")?.params["Дата"]).toBe("2025-12-31");
    expect(ask("остаток в кассе на конец сентября 2026")?.params["Дата"]).toBe("2026-09-30");
  });

  it("an impossible date, or two periods at once, is for the model", () => {
    expect(ask("выручка за 31.02.2026")).toBeNull();
    expect(ask("остаток в кассе на 45.13.2026")).toBeNull();
    expect(ask("выручка за сентябрь и октябрь")).toBeNull();
    expect(ask("выручка за 2025 и 2026 год")).toBeNull();
    expect(ask("выручка за 1 квартал и 2 квартал 2026")).toBeNull();
  });
});
