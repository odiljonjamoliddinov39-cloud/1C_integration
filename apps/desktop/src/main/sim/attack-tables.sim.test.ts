/**
 * Attack: files attached to a chat. A CSV written with any delimiter, with quotes, delimiters and line breaks inside
 * cells, must be read back cell for cell; and the totals, counts and filters of read_attachment must agree with a plain
 * recount of the same table, so that a comparison with 1C is never off because the tool was.
 */
import { describe, expect, it } from "vitest";

import { parseCsv, parseNumber, readTable, type TableFile } from "../tables.js";
import { cases, Rng, seed } from "./rng.js";

const CELLS = [
  "abc",
  "ООО «Ромашка»",
  "a,b",
  "a;b",
  'say "hi"',
  "multi\nline",
  "tab\tin",
  "1 234,50",
  "x~y",
  "p|q",
  "",
  "  spaced  ",
];

function toCsv(rows: string[][], delimiter: string): string {
  const quote = (cell: string) =>
    /[",\n\r;~|\t]/.test(cell) || cell.includes(delimiter) ? `"${cell.replaceAll('"', '""')}"` : cell;
  return rows.map((row) => row.map(quote).join(delimiter)).join("\n");
}

describe("attack: files", () => {
  it("a CSV comes back cell for cell, with any delimiter and nasty cells", () => {
    const rng = new Rng(seed(290));
    const bad: string[] = [];
    for (let i = 0; i < cases(2000); i++) {
      const width = rng.int(3, 8);
      const rows = Array.from({ length: rng.int(3, 30) }, () =>
        Array.from({ length: width }, () => rng.pick(CELLS)),
      );
      // Real exports have a first row of words: the delimiter is judged from many lines of the same shape.
      const delimiter = rng.pick([";", "\t", "~", "|", ","]);
      const got = parseCsv(toCsv(rows, delimiter));
      const expected = rows.map((r) => r.map((c) => c.trim()));
      // A cell with a break inside is quoted: the rows stay rows.
      if (got.length !== expected.length) {
        bad.push(`${got.length} rows for ${expected.length} (delimiter ${JSON.stringify(delimiter)})`);
        continue;
      }
      expected.forEach((row, r) =>
        row.forEach((cell, c) => {
          if ((got[r]?.[c] ?? "") !== cell)
            bad.push(
              `[${r}][${c}] ${JSON.stringify(got[r]?.[c])} ≠ ${JSON.stringify(cell)} (delimiter ${JSON.stringify(delimiter)})`,
            );
        }),
      );
    }
    expect(bad.slice(0, 8), `${bad.length} wrong`).toEqual([]);
  });

  it("the totals, counts, groups and filters agree with a recount", () => {
    const rng = new Rng(seed(291));
    const bad: string[] = [];
    for (let i = 0; i < cases(2500); i++) {
      const n = rng.int(1, 60);
      const rows: string[][] = [["Дата", "Контрагент", "Сумма"]];
      const data = Array.from({ length: n }, () => {
        const date = rng.date(2025, 2026);
        const who = rng.pick(["A", "B", "C", ""]);
        const amount = rng.chance(0.1)
          ? "n/a"
          : rng
              .money(0, 1_000_000, true)
              .toFixed(2)
              .replace(".", rng.pick([".", ","]));
        rows.push([date, who, amount]);
        return { date, who, amount: parseNumber(amount) };
      });
      const file: TableFile = { name: "f.xlsx", sheets: [{ name: "s", rows }] };
      const wanted = rng.pick(["A", "B", "C"]);
      const matching = data.filter((d) => d.who === wanted);
      const total = matching.reduce((s, d) => s + (Number.isNaN(d.amount) ? 0 : d.amount), 0);
      const sum = readTable([file], {
        file: "f.xlsx",
        from: 2,
        where: [{ column: "B", op: "=", value: wanted }],
        sum: ["C"],
      });
      if (!sum.ok) {
        bad.push(`sum failed: ${sum.message}`);
        continue;
      }
      const group = (sum.data as { groups: [string, number, number][]; matchedRows: number }).groups[0];
      if ((sum.data as { matchedRows: number }).matchedRows !== matching.length)
        bad.push(`#${i} matched ${(sum.data as { matchedRows: number }).matchedRows} for ${matching.length}`);
      if (matching.length > 0 && Math.abs((group?.[2] ?? 0) - total) > 0.011)
        bad.push(`#${i} total ${group?.[2]} for ${total}`);
      // By month: the groups add up to the whole.
      const byMonth = readTable([file], {
        file: "f.xlsx",
        from: 2,
        group_by: { column: "A", by: "month" },
        sum: ["C"],
      });
      if (!byMonth.ok) {
        bad.push("month failed");
        continue;
      }
      const groups = (byMonth.data as { groups: [string, number, number][] }).groups;
      const all = data.reduce((s, d) => s + (Number.isNaN(d.amount) ? 0 : d.amount), 0);
      if (groups.reduce((s, g) => s + g[1], 0) !== n)
        bad.push(`#${i} month groups hold ${groups.reduce((s, g) => s + g[1], 0)} rows of ${n}`);
      if (Math.abs(groups.reduce((s, g) => s + g[2], 0) - all) > 0.011 * groups.length)
        bad.push(`#${i} month totals ${groups.reduce((s, g) => s + g[2], 0)} for ${all}`);
      // A range filter: dates on or after a day.
      const since = rng.date(2025, 2026);
      const after = readTable([file], {
        file: "f.xlsx",
        from: 2,
        where: [{ column: "A", op: ">=", value: since }],
      });
      if (
        after.ok &&
        (after.data as { matchedRows: number }).matchedRows !== data.filter((d) => d.date >= since).length
      )
        bad.push(
          `#${i} ">= ${since}" matched ${(after.data as { matchedRows: number }).matchedRows} for ${data.filter((d) => d.date >= since).length}`,
        );
    }
    expect(bad.slice(0, 8), `${bad.length} wrong`).toEqual([]);
  });
});
