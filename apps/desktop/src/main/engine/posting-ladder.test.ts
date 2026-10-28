import { ENTRY_RULES, KNOWN_ENTRY_RULES, knownPair, specCovers } from "@platform/shared";
import { describe, expect, it } from "vitest";

import { GENERAL_RULES, choosePosting } from "./posting-rules.js";

describe("K3: the engine's general rules against the catalog", () => {
  it("each of the 16 has a catalog rule of the same operation that covers its accounts", () => {
    expect(GENERAL_RULES).toHaveLength(16);
    for (const g of GENERAL_RULES) {
      const rows = ENTRY_RULES.filter((r) => r.operation === g.operation);
      const covered = rows.some((r) =>
        r.lines.some((l) => specCovers(l.dt, g.debit) && specCovers(l.cr, g.credit)),
      );
      expect(covered, g.id).toBe(true);
    }
  });
});

describe("K5: the ladder", () => {
  const history = (debit: string, credit: string, count: number) => [
    { operation: "bank_fee" as const, document: "Списание", debit, credit, count },
  ];

  it("the company's own rule comes first", () => {
    const own = {
      id: "c1",
      scope: "company" as const,
      operation: "bank_fee" as const,
      document: "d",
      debit: "9420",
      credit: "5110",
      priority: 10,
    };
    expect(
      choosePosting({ type: "bank_fee" }, { companyRules: [own], history: history("9430", "5110", 9) }),
    ).toMatchObject({
      source: "rule",
      debit: "9420",
    });
  });

  it("a history that books the same way as the rule leaves the rule standing", () => {
    expect(choosePosting({ type: "bank_fee" }, { history: history("9430", "5110", 9) })).toMatchObject({
      source: "rule",
      debit: "9430",
      needsApproval: false,
    });
  });

  it("a dominant history with a pair the catalog knows beats the general rule: cash from the bank direct", () => {
    const direct = [
      {
        operation: "cash_withdrawal" as const,
        document: "Списание",
        debit: "5010",
        credit: "5110",
        count: 6,
      },
    ];
    expect(choosePosting({ type: "cash_withdrawal" }, { history: direct })).toMatchObject({
      source: "history",
      debit: "5010",
      credit: "5110",
      needsApproval: false,
    });
    // Without a history the general rule decides, through 5710.
    expect(choosePosting({ type: "cash_withdrawal" })).toMatchObject({ source: "rule", debit: "5710" });
  });

  it("a habit the book never uses is not followed silently: the rule is proposed and the difference shown", () => {
    const d = choosePosting({ type: "bank_fee" }, { history: history("9999", "5110", 9) });
    expect(knownPair(KNOWN_ENTRY_RULES, "9999", "5110")).toBeNull();
    expect(d).toMatchObject({ source: "rule", debit: "9430", needsApproval: true });
    expect(d.reason).toContain("9999");
  });

  it("an account the company's chart lacks is never used silently", () => {
    const d = choosePosting({ type: "bank_fee" }, { chart: new Set(["5110"]) });
    expect(d).toMatchObject({ needsApproval: true, missingAccounts: ["9430"] });
    const seen = choosePosting(
      { type: "cash_withdrawal" },
      {
        chart: new Set(["5110"]),
        history: [{ operation: "cash_withdrawal", document: "d", debit: "5010", credit: "5110", count: 5 }],
      },
    );
    expect(seen).toMatchObject({ source: "history", needsApproval: true, missingAccounts: ["5010"] });
  });
});
