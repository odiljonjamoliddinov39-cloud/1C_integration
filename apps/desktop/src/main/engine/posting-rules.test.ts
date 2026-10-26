import { describe, expect, it } from "vitest";

import { newOperation } from "./journal.js";
import { GENERAL_RULES, choosePosting, companyRule, missingIn, pickHistory } from "./posting-rules.js";

const chart = new Set(["2910", "4010", "5110", "6010", "6410", "9010", "9020", "9030", "9420", "9430"]);

describe("choosing the accounts", () => {
  it("takes the plan's table first: purchase of goods is Dt 2900 Kt 6010", () => {
    const d = choosePosting({ type: "purchase_goods" });
    expect(d).toMatchObject({
      source: "rule",
      debit: "2900",
      credit: "6010",
      document: "Поступление товаров и услуг",
    });
  });

  it("covers every operation of the plan's table", () => {
    for (const type of GENERAL_RULES.map((r) => r.operation)) {
      expect(choosePosting({ type }).source).toBe("rule");
    }
    expect(GENERAL_RULES).toHaveLength(11); // the plan's eight, the profit tax accrual and the two advances
  });

  it("checks the accounts against the company's chart and asks for confirmation when one is missing", () => {
    // 2900 is a group; the company's chart has 2910 under it: found by the prefix.
    expect(choosePosting({ type: "purchase_goods" }, { chart })).toMatchObject({ needsApproval: false });
    const d = choosePosting({ type: "sale_products" }, { chart: new Set(["4010"]) });
    expect(d.needsApproval).toBe(true);
    expect(d.missingAccounts).toEqual(["9010"]);
    expect(missingIn(undefined, ["9999"])).toEqual([]);
  });

  it("the company's own rule beats the general one, and a rule with conditions beats one without", () => {
    const own = companyRule(
      { type: "sale_goods", currency: "USD" },
      { document: "Реализация", debit: "4030", credit: "9020" },
      "c1",
    );
    expect(choosePosting({ type: "sale_goods", currency: "USD" }, { companyRules: [own] })).toMatchObject({
      debit: "4030",
      rule: "c1",
    });
    // Another currency: the general rule still answers.
    expect(choosePosting({ type: "sale_goods", currency: "UZS" }, { companyRules: [own] })).toMatchObject({
      debit: "4010",
    });
  });

  it("a rule is not used outside its dates", () => {
    const own = {
      ...companyRule({ type: "bank_fee" }, { document: "d", debit: "9420", credit: "5110" }, "c2"),
      validFrom: "2027-01-01",
    };
    expect(choosePosting({ type: "bank_fee", date: "2026-05-01" }, { companyRules: [own] }).debit).toBe(
      "9430",
    );
    expect(choosePosting({ type: "bank_fee", date: "2027-05-01" }, { companyRules: [own] }).debit).toBe(
      "9420",
    );
  });

  it("falls to the company's history only when it is consistent, then to the AI", () => {
    const rules = { generalRules: [] };
    const history = [
      { operation: "bank_fee" as const, document: "Списание", debit: "9430", credit: "5110", count: 9 },
      { operation: "bank_fee" as const, document: "Списание", debit: "9420", credit: "5110", count: 1 },
    ];
    expect(choosePosting({ type: "bank_fee" }, { ...rules, history })).toMatchObject({
      source: "history",
      debit: "9430",
    });
    const mixed = [
      { operation: "bank_fee" as const, document: "d", debit: "9430", credit: "5110", count: 5 },
      { operation: "bank_fee" as const, document: "d", debit: "9420", credit: "5110", count: 4 },
    ];
    expect(pickHistory({ type: "bank_fee" }, mixed)).toBeNull();
    expect(choosePosting({ type: "bank_fee" }, { ...rules, history: mixed })).toMatchObject({
      source: "ai",
      needsApproval: true,
    });
  });
});

describe("the journal of operations", () => {
  it("makes every operation the same way, with the source of each step", () => {
    const op = newOperation(
      "Bank statement 2026",
      [{ function: "propose_bank_payments", decision: "rule", durationMs: 12 }],
      "done",
      new Date("2026-10-22T10:00:00Z"),
      "id1",
    );
    expect(op).toEqual({
      id: "id1",
      intent: "Bank statement 2026",
      steps: [{ function: "propose_bank_payments", decision: "rule", durationMs: 12 }],
      status: "done",
      createdAt: "2026-10-22T10:00:00.000Z",
    });
  });
});
