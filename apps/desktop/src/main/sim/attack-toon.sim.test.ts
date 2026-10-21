/**
 * Attack: what 1C returns is not tidy — names with commas, quotes, newlines, brackets, numbers written as text,
 * "null" as a name. The table the model reads must give back exactly what 1C said, so that no figure or name is ever
 * read as another.
 */
import { describe, expect, it } from "vitest";

import { decodeTable, encodeTable } from "../ai/toon.js";
import { cases, Rng, seed } from "./rng.js";

const TRICKY = [
  "",
  " ",
  "  ",
  "null",
  "true",
  "false",
  "00123",
  "007",
  "1e5",
  "-5",
  "-",
  "+5",
  "5.",
  ".5",
  "0x10",
  "Infinity",
  "NaN",
  "1,5",
  '"quoted"',
  'a"b',
  "a\\b",
  "line\nbreak",
  "tab\there",
  "cr\rhere",
  "}:",
  "rows[1]{a}:",
  "{",
  "}",
  "[",
  "]",
  "a,b,c",
  " lead",
  "trail ",
  "Ё",
  "ўзбек",
  "😀",
  "ООО «Ромашка», Плюс",
  "2026-09-01",
  "2026-09-01T10:00:00",
  "-",
  "--",
  "- 5",
  "1 000,50",
  " ",
  "\u0001",
];

function randomCell(rng: Rng): unknown {
  switch (rng.int(0, 7)) {
    case 0:
      return rng.pick(TRICKY);
    case 1:
      return rng.money(-1e9, 1e9, rng.chance(0.5));
    case 2:
      return rng.int(-100, 100);
    case 3:
      return rng.chance(0.5);
    case 4:
      return null;
    case 5:
      return `${rng.date()}T00:00:00`;
    case 6:
      return Array.from({ length: rng.int(1, 12) }, () =>
        rng.pick(["a", ",", '"', " ", "1", "é", "\n", "}", "{", ":"]),
      ).join("");
    default:
      return rng.pick(TRICKY) + rng.pick(TRICKY);
  }
}

describe("attack: the table the model reads", () => {
  it("gives back exactly what was put in, whatever the strings look like", () => {
    const rng = new Rng(seed(280));
    const bad: string[] = [];
    for (let i = 0; i < cases(4000); i++) {
      const width = rng.int(1, 6);
      const columns = Array.from({ length: width }, () =>
        String(rng.pick([...TRICKY, "Сумма", "Счет", "A"])),
      );
      const rows = Array.from({ length: rng.int(0, 8) }, () =>
        Array.from({ length: width }, () => randomCell(rng)),
      );
      const text = encodeTable(columns, rows);
      const back = decodeTable(text);
      if (!back) {
        bad.push(`not read back: ${JSON.stringify(text).slice(0, 120)}`);
        continue;
      }
      // A midnight date is written without its time; nothing else may change.
      const norm = (v: unknown) =>
        typeof v === "string" ? v.replace(/^(\d{4}-\d{2}-\d{2})T00:00:00$/, "$1") : v;
      if (JSON.stringify(back.columns) !== JSON.stringify(columns))
        bad.push(`columns ${JSON.stringify(back.columns)} ≠ ${JSON.stringify(columns)}`);
      if (back.rows.length !== rows.length) {
        bad.push(`${back.rows.length} rows for ${rows.length}: ${JSON.stringify(text).slice(0, 160)}`);
        continue;
      }
      rows.forEach((row, r) =>
        row.forEach((v, c) => {
          if (JSON.stringify(back.rows[r]?.[c]) !== JSON.stringify(norm(v)))
            bad.push(`[${r}][${c}] ${JSON.stringify(back.rows[r]?.[c])} ≠ ${JSON.stringify(norm(v))}`);
        }),
      );
    }
    expect(bad.slice(0, 8), `${bad.length} wrong`).toEqual([]);
  });
});
