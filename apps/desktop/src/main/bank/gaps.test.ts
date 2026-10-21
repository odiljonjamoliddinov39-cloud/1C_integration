import { describe, expect, it } from "vitest";

import { gapsOf, gapsText } from "./gaps.js";

const resolved = {
  missing: [
    { key: "inn:310495297", name: "SAM ACTIVE GROUP", inn: "310495297", rows: [4] },
    { key: "name:BOBUR", name: "BOBUR", inn: "", rows: [7] },
  ],
  contractsToCreate: [{ label: "№183 от 15.10.2026", rows: [4] }],
  problems: [
    { rows: [9, 10], code: "NO_TEMPLATE", message: "No earlier payment to copy" },
    { rows: [12], code: "NO_TEMPLATE", message: "No earlier payment to copy" },
  ],
  ready: [{}, {}, {}],
} as never;

describe("bank gaps", () => {
  it("collects what is missing, once each", () => {
    expect(gapsOf([resolved, resolved])).toEqual({
      ready: 6,
      counterparties: ["SAM ACTIVE GROUP (310495297)", "BOBUR"],
      contracts: ["№183 от 15.10.2026"],
      problems: [{ message: "No earlier payment to copy", rows: 6 }],
    });
  });

  it("says it in the language of the accountant", () => {
    const gaps = gapsOf([resolved]);
    expect(gapsText("uz", gaps)).toContain("Kontragentlar (2): SAM ACTIVE GROUP (310495297), BOBUR");
    expect(gapsText("ru", gaps)).toContain("Договоры (1)");
    expect(gapsText("en", gaps)).toContain("Rows the program cannot settle (3)");
  });

  it("says nothing when nothing is missing", () => {
    expect(gapsText("uz", { ready: 5, counterparties: [], contracts: [], problems: [] })).toBe("");
  });

  it("does not promise a card when only rows are unsettled", () => {
    const text = gapsText("en", {
      ready: 1,
      counterparties: [],
      contracts: [],
      problems: [{ message: "x", rows: 1 }],
    });
    expect(text).not.toContain("card");
  });
});
