/**
 * Attack: bank statements as they come out of a client-bank after a person has touched them: the columns in another
 * order, the header repeated at every page break, blank lines, notes between the rows, dates with a time, amounts in
 * every number style, names with quotes and commas. Every payment must come out once, to the tiyin; what is not a
 * payment (a header, a total, a note) must not become one.
 */
import { describe, expect, it } from "vitest";

import { parseBankStatement } from "../bank/statement.js";
import type { TableFile } from "../tables.js";
import { cases, Rng, seed } from "./rng.js";

interface Truth {
  date: string;
  number: string;
  direction: "in" | "out";
  tiyin: number;
  name: string;
  inn: string;
  purpose: string;
}

const NAMES = [
  "NAVRO'Z-PTK",
  'ООО "Ромашка, Плюс"',
  "Texmash MCHJ",
  'AJ "Alfa Stroy"',
  "Kapital Savdo",
  "ИП Иванов И.И.",
];
const PURPOSES = [
  "Оплата по договору №17 от 12.03.2026",
  "За услуги бурения, в т.ч. НДС 12%",
  "To'lov shartnoma asosida",
  "Аренда за сентябрь 2026",
];

const group = (n: number, sep: string) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
function money(rng: Rng, tiyin: number): string {
  const whole = Math.floor(tiyin / 100);
  const f = String(tiyin % 100).padStart(2, "0");
  return rng.pick([
    `${group(whole, " ")},${f}`,
    `${group(whole, " ")},${f}`,
    `${whole}.${f}`,
    `${group(whole, ",")}.${f}`,
    `${group(whole, ".")},${f}`,
  ]);
}

describe("attack: touched-up bank statements", () => {
  it("every payment once and to the tiyin, whatever the order of the columns and the clutter between the rows", () => {
    const rng = new Rng(seed(250));
    const bad: string[] = [];
    const n = cases(1200);
    for (let i = 0; i < n; i++) {
      const payments: Truth[] = Array.from({ length: rng.int(2, 60) }, (_, k) => ({
        date: rng.date(2025, 2026),
        number: String(1000 + k),
        direction: rng.pick(["in", "out"] as const),
        tiyin: rng.int(100, 99_999_999_999),
        name: rng.pick(NAMES),
        inn: String(300_000_000 + rng.int(0, 99_999)),
        purpose: rng.pick(PURPOSES),
      }));
      const cols = rng.shuffle(["date", "number", "name", "inn", "debit", "credit", "purpose"] as const);
      const head = (c: string) =>
        ({
          date: "Дата",
          number: "№ док",
          name: "Наименование корреспондента",
          inn: "ИНН",
          debit: "Дебет",
          credit: "Кредит",
          purpose: "Назначение платежа",
        })[c] ?? c;
      const header = cols.map(head);
      const cell = (p: Truth, c: (typeof cols)[number]) => {
        const [y, m, d] = p.date.split("-");
        switch (c) {
          case "date":
            return rng.pick([`${d}.${m}.${y}`, `${d}.${m}.${y} 10:15:00`, `${y}-${m}-${d}`]);
          case "number":
            return p.number;
          case "name":
            return p.name;
          case "inn":
            return p.inn;
          case "debit":
            return p.direction === "out" ? money(rng, p.tiyin) : "";
          case "credit":
            return p.direction === "in" ? money(rng, p.tiyin) : "";
          default:
            return p.purpose;
        }
      };
      const rows: string[][] = [
        ["Выписка по счёту 20208000100438330001"],
        ["Организация: CRYSTAL"],
        [],
        header,
      ];
      payments.forEach((p, k) => {
        rows.push(cols.map((c) => cell(p, c)));
        if (rng.chance(0.08)) rows.push([]);
        if (rng.chance(0.05)) rows.push(["Продолжение на следующей странице"]);
        // The header repeats at a page break.
        if (k > 0 && k % 25 === 0) rows.push(header);
      });
      rows.push(
        cols.map((c) =>
          c === "date" ? "Итого" : c === "debit" ? "1 000,00" : c === "credit" ? "2 000,00" : "",
        ),
      );
      rows.push(["Сформировано 05.10.2026 в банке"]);
      const file: TableFile = { name: "v.xlsx", sheets: [{ name: "s", rows }] };
      const parsed = parseBankStatement(file);
      if (!parsed) {
        bad.push(`#${i} not read`);
        continue;
      }
      if (parsed.payments.length !== payments.length) {
        bad.push(`#${i} ${parsed.payments.length} payments for ${payments.length}`);
        continue;
      }
      payments.forEach((p, k) => {
        const got = parsed.payments[k];
        if (!got) return;
        if (
          got.date !== p.date ||
          got.amount !== p.tiyin ||
          got.direction !== p.direction ||
          got.inn !== p.inn ||
          got.number !== p.number ||
          got.counterparty !== p.name
        )
          bad.push(`#${i} row ${k}: ${JSON.stringify(got)} vs ${JSON.stringify(p)}`);
      });
    }
    expect(bad.slice(0, 6), `${bad.length} problems in ${n}`).toEqual([]);
  });
});
