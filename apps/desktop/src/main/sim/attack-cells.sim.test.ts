/**
 * Attack: the cells of a bank statement as banks and Excel really write them: numbers with every kind of separator,
 * negatives in brackets or with a trailing minus, dates in every order and width. A figure read wrongly is worse than
 * one not read: it must come out right or come out as "not a number" / "not a date", never as another value.
 */
import { describe, expect, it } from "vitest";

import { parseDate, parseNumber } from "../tables.js";
import { cases, Rng, seed } from "./rng.js";

const group = (n: number, sep: string) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, sep);

/** The same amount written the ways statements do. */
function written(rng: Rng, whole: number, frac: number): { text: string; value: number } {
  const f = String(frac).padStart(2, "0");
  const style = rng.int(0, 9);
  const value = Number(`${whole}.${f}`);
  switch (style) {
    case 0:
      return { text: `${group(whole, " ")},${f}`, value };
    case 1:
      return { text: `${whole}.${f}`, value };
    case 2:
      return { text: `${group(whole, ",")}.${f}`, value };
    case 3:
      return { text: `${group(whole, ".")},${f}`, value };
    case 4:
      return { text: `${group(whole, " ")},${f}`, value };
    case 5:
      return { text: `${group(whole, "'")}.${f}`, value };
    case 6:
      return { text: `${whole},${f}`, value };
    case 7:
      return { text: `${group(whole, " ")}`, value: whole };
    case 8:
      return { text: ` ${group(whole, " ")},${f} `, value };
    default:
      return { text: `${group(whole, " ")},${f}`, value };
  }
}

describe("attack: numbers in cells", () => {
  it("are read to the same value whatever the separators, or not read at all", () => {
    const rng = new Rng(seed(210));
    const wrong: string[] = [];
    for (let i = 0; i < cases(8000); i++) {
      const whole = rng.chance(0.5) ? rng.int(0, 999) : rng.int(1000, 9_999_999_999);
      const { text, value } = written(rng, whole, rng.int(0, 99));
      const got = parseNumber(text);
      if (Number.isNaN(got)) continue;
      if (Math.abs(got - value) > 0.0001) wrong.push(`"${text}" → ${got}, meant ${value}`);
    }
    expect(wrong.slice(0, 10), `${wrong.length} misread`).toEqual([]);
  });

  it("are mostly read: the common separators never give NaN", () => {
    const rng = new Rng(seed(211));
    let nan = 0;
    const n = cases(4000);
    for (let i = 0; i < n; i++) {
      const { text } = written(rng, rng.int(0, 9_999_999), rng.int(0, 99));
      if (Number.isNaN(parseNumber(text))) nan++;
    }
    expect(nan).toBe(0);
  });

  it("negatives: a minus in front or behind, brackets", () => {
    const rng = new Rng(seed(212));
    for (let i = 0; i < cases(2000); i++) {
      const whole = rng.int(1, 9_999_999);
      const { text, value } = written(rng, whole, rng.int(0, 99));
      for (const negative of [`-${text.trim()}`, `${text.trim()}-`, `(${text.trim()})`, `−${text.trim()}`]) {
        const got = parseNumber(negative);
        expect(got, negative).toBeCloseTo(-value, 4);
      }
    }
  });

  it("words, dates and codes are no numbers", () => {
    for (const text of [
      "",
      " ",
      "abc",
      "01.09.2026",
      "2026-09-01",
      "20208000100438330001x",
      "—",
      "N/A",
      "1 2 x",
      "1.23.456",
      "12.5.7.1",
    ]) {
      expect(parseNumber(text), text).toBeNaN();
    }
  });

  it("one group of thousands with a comma for the decimals is not a decimal number", () => {
    expect(parseNumber("1.000,50")).toBe(1000.5);
    expect(parseNumber("12.345,6")).toBe(12345.6);
    expect(parseNumber("1.234.567")).toBe(1234567);
    expect(parseNumber("1,234,567.5")).toBe(1234567.5);
  });
});

describe("attack: dates in cells", () => {
  it("are read to the same day in every order and width, or not read", () => {
    const rng = new Rng(seed(213));
    const wrong: string[] = [];
    let unread = 0;
    const n = cases(8000);
    for (let i = 0; i < n; i++) {
      const y = rng.int(2020, 2030);
      const m = rng.int(1, 12);
      const d = rng.int(1, 28);
      const [dd, mm] = [String(d).padStart(2, "0"), String(m).padStart(2, "0")];
      const iso = `${y}-${mm}-${dd}`;
      const forms = [
        `${dd}.${mm}.${y}`,
        `${d}.${m}.${y}`,
        `${dd}/${mm}/${y}`,
        `${dd}-${mm}-${y}`,
        `${y}/${mm}/${dd}`,
        `${y}.${mm}.${dd}`,
        `${iso}T00:00:00`,
        `${iso} 10:15:00`,
        `${dd}.${mm}.${String(y).slice(2)}`,
        `${dd}.${mm}.${y} 10:15`,
        ` ${dd}.${mm}.${y} `,
        `${dd}.${mm}.${y}г.`,
      ];
      const text = rng.pick(forms);
      const got = parseDate(text.trim());
      if (got === null) unread++;
      else if (got !== iso) wrong.push(`"${text}" → ${got}, meant ${iso}`);
    }
    expect(wrong.slice(0, 10), `${wrong.length} misread`).toEqual([]);
    // The usual forms are read: only truly odd ones may be left.
    expect(unread / n).toBeLessThan(0.05);
  });

  it("an impossible date is no date", () => {
    for (const text of [
      "31.02.2026",
      "00.01.2026",
      "32.01.2026",
      "15.13.2026",
      "2026-13-01",
      "2026-02-30",
      "99.99.9999",
    ]) {
      expect(parseDate(text), text).toBeNull();
    }
  });
});
