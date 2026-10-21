/**
 * Simulation: the engine's seeded database is consistent. Every knowledge entry is found by its own topics (in a
 * sentence a person would write) and by nothing absurd; every seeded query is well formed, its parameters are all
 * declared and used, and no phrase of two templates is the same question.
 */
import {
  ACCOUNTING_CALC_OPS,
  KNOWLEDGE,
  searchKnowledge,
  seedTemplateInputs,
  SEED_TEMPLATES,
} from "@platform/shared";
import { describe, expect, it } from "vitest";

import { cases, Rng, seed } from "./rng.js";

const FRAME = [
  "как",
  "что",
  "покажи",
  "how to",
  "расскажи про",
  "savol:",
  "",
  "нужно знать",
  "please explain",
];

describe("simulation: the knowledge base answers what it knows", () => {
  it("each entry is among the first three for a question made of its own topics", () => {
    const rng = new Rng(seed(100));
    const lost: string[] = [];
    for (let i = 0; i < cases(4000); i++) {
      const entry = rng.pick(KNOWLEDGE);
      const topic = rng.pick(entry.topics);
      const question = `${rng.pick(FRAME)} ${topic}${rng.chance(0.3) ? "?" : ""}`.trim();
      const found = searchKnowledge(question, 3);
      if (!found.some((f) => f.id === entry.id))
        lost.push(`${entry.id} ← "${question}" → ${found.map((f) => f.id).join(",")}`);
    }
    // A topic shared by two or three entries ("НДС") may put another first, but the entry must stay in sight.
    expect(lost.slice(0, 10), `${lost.length} lost`).toEqual([]);
  });

  it("nonsense finds nothing, and no question breaks the search", () => {
    const rng = new Rng(seed(101));
    const junk = [
      "ёлка",
      "банан",
      "zebra",
      "lorem",
      "ipsum",
      "qwerty",
      "",
      " ",
      "?!",
      "😀",
      "1234",
      "x".repeat(500),
    ];
    for (let i = 0; i < cases(2000); i++) {
      const q = Array.from({ length: rng.int(0, 6) }, () => rng.pick(junk)).join(" ");
      expect(() => searchKnowledge(q, rng.int(1, 6))).not.toThrow();
    }
    expect(searchKnowledge("ёлка банан zebra", 3)).toEqual([]);
  });

  it("entries are unique, complete and name only real calculators", () => {
    const ids = new Set<string>();
    for (const e of KNOWLEDGE) {
      expect(ids.has(e.id), e.id).toBe(false);
      ids.add(e.id);
      expect(e.title.length, e.id).toBeGreaterThan(1);
      expect(e.lines.length, e.id).toBeGreaterThan(0);
      expect(e.topics.length, e.id).toBeGreaterThan(1);
      if (e.calc) expect(ACCOUNTING_CALC_OPS as readonly string[], e.id).toContain(e.calc);
      for (const a of e.accounts ?? []) expect(a, e.id).toMatch(/^\d{4}$/);
    }
  });
});

describe("simulation: the seeded queries are well formed", () => {
  const params = (query: string) => [
    ...new Set([...query.matchAll(/&([\p{L}_][\p{L}\p{N}_]*)/gu)].map((m) => m[1]!)),
  ];

  it("every parameter is declared, every declared one is used, quotes and brackets are balanced", () => {
    for (const t of SEED_TEMPLATES) {
      const used = params(t.query);
      const declared = t.params.map((p) => p.name);
      // The month window passes the end of the month as the closing date inside the query.
      for (const u of used) expect(declared, `${t.code} uses &${u}`).toContain(u);
      for (const d of declared)
        if (t.params.find((p) => p.name === d)?.type !== "counterparty")
          expect(used, `${t.code} declares ${d}`).toContain(d);
      expect((t.query.match(/"/g) ?? []).length % 2, `${t.code} quotes`).toBe(0);
      expect((t.query.match(/\(/g) ?? []).length, `${t.code} brackets`).toBe(
        (t.query.match(/\)/g) ?? []).length,
      );
      expect(t.query.toUpperCase(), t.code).toMatch(/^ВЫБРАТЬ/);
      // A seeded query only reads.
      expect(t.query, t.code).not.toMatch(/\b(УДАЛИТЬ|УНИЧТОЖИТЬ|ПОМЕСТИТЬ)\b/i);
      expect(t.columns.length, t.code).toBeGreaterThan(0);
    }
  });

  it("no two templates own the same phrase", () => {
    const owner = new Map<string, string>();
    for (const t of seedTemplateInputs()) {
      for (const phrase of t.intents) {
        const key = phrase.split(" ").filter(Boolean).sort().join(" ");
        const other = owner.get(key);
        expect(other === undefined || other === t.code, `"${phrase}" in ${other} and ${t.code}`).toBe(true);
        owner.set(key, t.code);
      }
    }
  });
});
