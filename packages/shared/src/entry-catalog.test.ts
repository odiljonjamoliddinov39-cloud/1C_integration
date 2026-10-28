import { describe, expect, it } from "vitest";

import { EntryRule, carriesNumbers, knownPair, mayDecide, specCovers } from "./entry-catalog.js";
import { ENTRY_RULES, KNOWN_ENTRY_RULES } from "./entry-rules.js";
import { KNOWLEDGE } from "./knowledge.js";

describe("the entry catalog", () => {
  it("every rule passes the schema, and its id is unique", () => {
    for (const r of ENTRY_RULES) expect(() => EntryRule.parse(r), r.id).not.toThrow();
    const ids = ENTRY_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("K3: a rule has its row in the book, or a recorded reason it has none", () => {
    for (const r of ENTRY_RULES) expect(Boolean(r.source) || Boolean(r.noSource), r.id).toBe(true);
    // The one exception today: the first leg of cash drawn from the bank through the transit account (TD C2).
    expect(ENTRY_RULES.filter((r) => !r.source).map((r) => r.operation)).toEqual(["cash_withdrawal"]);
  });

  it("K6: no rate, limit or deadline is in the data", () => {
    for (const r of ENTRY_RULES) expect(carriesNumbers(r), r.id).toBe(false);
  });

  it("only a checked rule (or above) may decide an account; the families still to be built are parsed", () => {
    const decide = ENTRY_RULES.filter(mayDecide).map((r) => r.operation);
    expect(decide).toContain("purchase_goods");
    expect(ENTRY_RULES.find((r) => r.operation === "salary_cash")?.status).toBe("parsed");
    expect(mayDecide(ENTRY_RULES.find((r) => r.operation === "salary_cash") as EntryRule)).toBe(false);
  });

  it("cash from the bank has both variants: through 5710 and direct", () => {
    const withdrawals = ENTRY_RULES.filter((r) => r.operation === "cash_withdrawal");
    expect(withdrawals).toHaveLength(2);
    expect(withdrawals.filter((r) => r.variantOf === "cash_withdrawal")).toHaveLength(1);
  });
});

describe("account specs and known pairs", () => {
  it("a code, a range and a list cover what they name; a group code stands for the accounts under it", () => {
    expect(specCovers({ code: "5110" }, "5110")).toBe(true);
    expect(specCovers({ from: "2910", to: "2990" }, "2950")).toBe(true);
    expect(specCovers({ from: "2910", to: "2990" }, "3010")).toBe(false);
    expect(specCovers({ anyOf: ["4110", "4120"] }, "4120")).toBe(true);
    expect(specCovers({ from: "2910", to: "2990" }, "2900")).toBe(true);
    expect(specCovers({ code: "5110" }, "5010")).toBe(false);
  });

  it("a pair is known at four digits, or near at three (a finer sub-account), or unknown", () => {
    expect(knownPair(KNOWN_ENTRY_RULES, "4010", "6410")).toBe("exact");
    expect(knownPair(KNOWN_ENTRY_RULES, "2950", "6010")).toBe("exact");
    expect(knownPair(KNOWN_ENTRY_RULES, "5113", "4010")).toBe("near");
    expect(knownPair(KNOWN_ENTRY_RULES, "9810", "6430")).toBeNull();
    expect(knownPair(KNOWN_ENTRY_RULES, "5110", "9990")).toBeNull();
  });
});

describe("K4: the knowledge base against the rules", () => {
  it("C1: the VAT of a sale is Дт 4010 Кт 6410, as the book and the rule say", () => {
    const sale = KNOWLEDGE.find((k) => k.id === "entry_sale_goods");
    const text = (sale?.lines ?? []).join("\n");
    expect(text).toContain("Дт 4010 Кт 6410");
    expect(text).not.toContain("Дт 9020 Кт 6410");
    expect(knownPair(KNOWN_ENTRY_RULES, "4010", "6410")).toBe("exact");
  });
});
