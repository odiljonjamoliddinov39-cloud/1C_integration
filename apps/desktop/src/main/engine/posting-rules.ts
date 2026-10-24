/**
 * The decision centre's choice of accounts for an operation (the plan's §9). Five steps, each used only when the one
 * before it has no answer, and the source of the answer is kept with it:
 *   1. rule (the table below, then the company's own rules over it), at once, free;
 *   2. history: how this company has booked the same operation before, when it is consistent;
 *   3. a small model, learned from the company's corrections (not built yet: the step answers "none");
 *   4. the AI model, only for what is left;
 *   5. the accountant decides, and the decision becomes a company rule.
 * Account codes are checked against the company's chart in 1C: an account the chart lacks is never used silently.
 */

import type { PostingOperation } from "@platform/shared";

export type OperationType = PostingOperation;

export interface RuleConditions {
  counterpartyType?: string;
  taxRegime?: string;
  vatPayer?: boolean;
  currency?: string;
}

export interface PostingRule {
  id: string;
  scope: "general" | "company";
  operation: OperationType;
  /** The 1C document that carries the entry. */
  document: string;
  debit: string;
  credit: string;
  conditions?: RuleConditions;
  /** The bigger wins; a company rule beats a general one of the same priority. */
  priority: number;
  validFrom?: string;
  validTo?: string;
}

/** The plan's example table (§9); the accounts are the NSBU chart's, confirmed against the company's own chart. */
export const GENERAL_RULES: PostingRule[] = [
  {
    id: "g-purchase-goods",
    scope: "general",
    operation: "purchase_goods",
    document: "Поступление товаров и услуг",
    debit: "2900",
    credit: "6010",
    priority: 0,
  },
  {
    id: "g-sale-products",
    scope: "general",
    operation: "sale_products",
    document: "Реализация",
    debit: "4010",
    credit: "9010",
    priority: 0,
  },
  {
    id: "g-sale-goods",
    scope: "general",
    operation: "sale_goods",
    document: "Реализация",
    debit: "4010",
    credit: "9020",
    priority: 0,
  },
  {
    id: "g-sale-services",
    scope: "general",
    operation: "sale_services",
    document: "Реализация",
    debit: "4010",
    credit: "9030",
    priority: 0,
  },
  {
    id: "g-sale-vat",
    scope: "general",
    operation: "sale_vat",
    document: "Реализация",
    debit: "4010",
    credit: "6410",
    priority: 0,
  },
  {
    id: "g-payment-from-buyer",
    scope: "general",
    operation: "payment_from_buyer",
    document: "Поступление на расчетный счет",
    debit: "5110",
    credit: "4010",
    priority: 0,
  },
  {
    id: "g-payment-to-supplier",
    scope: "general",
    operation: "payment_to_supplier",
    document: "Списание с расчетного счета",
    debit: "6010",
    credit: "5110",
    priority: 0,
  },
  // The profit tax of the period is accrued to the budget account (NSBU): the accountant posts it.
  {
    id: "g-profit-tax",
    scope: "general",
    operation: "profit_tax_accrual",
    document: "Операция",
    debit: "9810",
    credit: "6410",
    priority: 0,
  },
  // An advance is money paid or received before the invoice: the settlement accounts of advances (NSBU: 4310 advances
  // paid to suppliers, 6310 advances received from buyers).
  {
    id: "g-advance-from-buyer",
    scope: "general",
    operation: "advance_from_buyer",
    document: "Поступление на расчетный счет",
    debit: "5110",
    credit: "6310",
    priority: 0,
  },
  {
    id: "g-advance-to-supplier",
    scope: "general",
    operation: "advance_to_supplier",
    document: "Списание с расчетного счета",
    debit: "4310",
    credit: "5110",
    priority: 0,
  },
  // The fee goes to the period's expense account the company's accounting policy names; 9430 (other operating expenses, the
  // bank's services among them) is the usual one, and the one this company's accountant has posted fees to.
  {
    id: "g-bank-fee",
    scope: "general",
    operation: "bank_fee",
    document: "Списание с расчетного счета",
    debit: "9430",
    credit: "5110",
    priority: 0,
  },
];

export type DecisionSource = "rule" | "history" | "model" | "ai" | "accountant";

export interface Decision {
  source: DecisionSource;
  document?: string;
  debit?: string;
  credit?: string;
  rule?: string;
  /** The accountant confirms before it is used (an account the chart lacks, a rule not yet confirmed). */
  needsApproval: boolean;
  /** Accounts the decision names that the company's chart in 1C does not have. */
  missingAccounts: string[];
  reason: string;
}

export interface OperationFacts {
  type: OperationType;
  date?: string;
  counterpartyType?: string;
  taxRegime?: string;
  vatPayer?: boolean;
  currency?: string;
}

export interface HistoryPattern {
  operation: OperationType;
  document: string;
  debit: string;
  credit: string;
  count: number;
}

export interface Context {
  /** The company's own rules (they beat the general ones). */
  companyRules?: PostingRule[];
  generalRules?: PostingRule[];
  history?: HistoryPattern[];
  /** The account codes of the company's chart in 1C; absent: not read, nothing is checked. */
  chart?: Set<string>;
}

const matches = (rule: PostingRule, f: OperationFacts): boolean => {
  if (rule.operation !== f.type) return false;
  const day = f.date?.slice(0, 10);
  if (day && ((rule.validFrom && day < rule.validFrom) || (rule.validTo && day > rule.validTo))) return false;
  const c = rule.conditions;
  if (!c) return true;
  return (
    (c.counterpartyType === undefined || c.counterpartyType === f.counterpartyType) &&
    (c.taxRegime === undefined || c.taxRegime === f.taxRegime) &&
    (c.vatPayer === undefined || c.vatPayer === f.vatPayer) &&
    (c.currency === undefined || c.currency === f.currency)
  );
};

const specificity = (r: PostingRule) =>
  Object.values(r.conditions ?? {}).filter((v) => v !== undefined).length;

/** The best rule for the facts: higher priority, then more conditions met, then a company rule over a general one. */
export function pickRule(f: OperationFacts, ctx: Context): PostingRule | null {
  const all = [...(ctx.companyRules ?? []), ...(ctx.generalRules ?? GENERAL_RULES)].filter((r) =>
    matches(r, f),
  );
  all.sort(
    (a, b) =>
      b.priority - a.priority ||
      specificity(b) - specificity(a) ||
      Number(b.scope === "company") - Number(a.scope === "company"),
  );
  return all[0] ?? null;
}

/**
 * Of the accounts named, those the chart lacks. A group code (2900: the goods group) is found by its non-zero start
 * (29), as the chart's 2910 sits under it.
 */
export function missingIn(chart: Set<string> | undefined, accounts: string[]): string[] {
  if (!chart) return [];
  const codes = [...chart];
  return accounts.filter((a) => {
    const stem = a.replace(/0+$/, "");
    return !codes.some((c) => c === a || (stem.length < a.length && c.startsWith(stem)));
  });
}

/** History is used only when one way of booking clearly dominates: at least 3 times and 80% of the cases. */
export function pickHistory(f: OperationFacts, history: HistoryPattern[] | undefined): HistoryPattern | null {
  const same = (history ?? []).filter((h) => h.operation === f.type);
  const total = same.reduce((s, h) => s + h.count, 0);
  const top = [...same].sort((a, b) => b.count - a.count)[0];
  return top && top.count >= 3 && top.count / total >= 0.8 ? top : null;
}

export function choosePosting(f: OperationFacts, ctx: Context = {}): Decision {
  const rule = pickRule(f, ctx);
  if (rule) {
    const missing = missingIn(ctx.chart, [rule.debit, rule.credit]);
    return {
      source: "rule",
      document: rule.document,
      debit: rule.debit,
      credit: rule.credit,
      rule: rule.id,
      needsApproval: missing.length > 0,
      missingAccounts: missing,
      reason:
        missing.length > 0
          ? `rule ${rule.id}, but the company's chart has no ${missing.join(", ")}`
          : `rule ${rule.id} (${rule.scope})`,
    };
  }
  const seen = pickHistory(f, ctx.history);
  if (seen) {
    const missing = missingIn(ctx.chart, [seen.debit, seen.credit]);
    return {
      source: "history",
      document: seen.document,
      debit: seen.debit,
      credit: seen.credit,
      needsApproval: missing.length > 0,
      missingAccounts: missing,
      reason: `the company booked this ${seen.count} times the same way`,
    };
  }
  // Step 3 (a small model) has nothing yet; the AI is next, and the accountant has the last word.
  return {
    source: "ai",
    needsApproval: true,
    missingAccounts: [],
    reason: "no rule and no consistent history: the AI proposes, the accountant confirms",
  };
}

/** A rule the accountant has decided for this company: from now on step 1 answers it. */
export function companyRule(
  facts: OperationFacts,
  decision: { document: string; debit: string; credit: string },
  id: string,
): PostingRule {
  const conditions: RuleConditions = {
    ...(facts.counterpartyType ? { counterpartyType: facts.counterpartyType } : {}),
    ...(facts.currency ? { currency: facts.currency } : {}),
  };
  return {
    id,
    scope: "company",
    operation: facts.type,
    document: decision.document,
    debit: decision.debit,
    credit: decision.credit,
    ...(Object.keys(conditions).length ? { conditions } : {}),
    priority: 10,
  };
}
