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
      unclassified: [],
      transfers: [],
    });
  });

  it("tells the moves between own accounts the program could not enter, with the reason", () => {
    const gaps = gapsOf(
      [],
      [],
      [{ message: "no attribute for the other account" }, { message: "no attribute for the other account" }],
    );
    expect(gaps.transfers).toEqual([{ message: "no attribute for the other account", rows: 2 }]);
    expect(gapsText("en", gaps)).toContain("between own accounts the program could not enter (2)");
  });

  it("lists the lines held back, by reason, apart from the unsettled ones", () => {
    const gaps = gapsOf([], [{ why: "the purpose is empty" }, { why: "the purpose is empty" }, { why: "x" }]);
    expect(gaps.unclassified).toEqual([
      { why: "the purpose is empty", rows: 2 },
      { why: "x", rows: 1 },
    ]);
    expect(gapsText("en", gaps)).toContain("not written");
  });

  it("says it in the language of the accountant", () => {
    const gaps = gapsOf([resolved]);
    expect(gapsText("uz", gaps)).toContain("Kontragentlar (2): SAM ACTIVE GROUP (310495297), BOBUR");
    expect(gapsText("ru", gaps)).toContain("Договоры (1)");
    expect(gapsText("en", gaps)).toContain("Rows the program cannot settle (3)");
  });

  it("says nothing when nothing is missing", () => {
    expect(
      gapsText("uz", {
        ready: 5,
        counterparties: [],
        contracts: [],
        problems: [],
        unclassified: [],
        transfers: [],
      }),
    ).toBe("");
  });

  it("does not promise a card when only rows are unsettled", () => {
    const text = gapsText("en", {
      ready: 1,
      counterparties: [],
      contracts: [],
      problems: [{ message: "x", rows: 1 }],
      unclassified: [],
      transfers: [],
    });
    expect(text).not.toContain("card");
  });
});
