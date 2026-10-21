import { describe, expect, it } from "vitest";

import { QueryTemplateInput } from "./ai-policy.js";
import { SEED_TEMPLATES, seedTemplateInputs } from "./seed-templates.js";

describe("the seed template library", () => {
  it("is valid for the template form, with unique codes", () => {
    const inputs = seedTemplateInputs();
    for (const input of inputs) expect(() => QueryTemplateInput.parse(input), input.code).not.toThrow();
    expect(new Set(inputs.map((t) => t.code)).size).toBe(inputs.length);
    expect(inputs.length).toBeGreaterThanOrEqual(20);
  });

  it("reads only, and every &parameter of a query is declared (and every declared one is used)", () => {
    for (const t of SEED_TEMPLATES) {
      expect(t.query.trimStart().startsWith("ВЫБРАТЬ"), t.code).toBe(true);
      expect(/УНИЧТОЖИТЬ|ПОМЕСТИТЬ/i.test(t.query), t.code).toBe(false);
      const used = new Set([...t.query.matchAll(/&([A-Za-zА-Яа-я_][A-Za-zА-Яа-я0-9_]*)/g)].map((m) => m[1]));
      const declared = new Set(t.params.map((p) => p.name));
      expect([...used].sort(), t.code).toEqual([...declared].sort());
    }
  });

  it("has the columns its query returns, and phrases in Russian and Uzbek or English", () => {
    for (const t of SEED_TEMPLATES) {
      const selected = t.query.split(" ИЗ ")[0] ?? "";
      const aliases = [...selected.matchAll(/ КАК /g)].length;
      // A union has the columns of its first select.
      expect(t.columns.length, t.code).toBeLessThanOrEqual(Math.max(aliases, 1) + 0);
      expect(t.intents.length, t.code).toBeGreaterThanOrEqual(5);
      for (const phrase of t.intents)
        expect(phrase.trim().length, `${t.code}: ${phrase}`).toBeGreaterThanOrEqual(5);
      const text = t.intents.join(" ");
      expect(/[а-яё]/i.test(text), `${t.code} has Russian`).toBe(true);
      expect(/[a-z]/i.test(text), `${t.code} has Latin`).toBe(true);
    }
  });
});
