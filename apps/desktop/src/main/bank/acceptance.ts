/**
 * The acceptance run: the statements read-only, every line classified, and the totals the statements themselves must agree
 * with. Nothing is written anywhere. It answers, before any automatic writing is allowed: what is each line, how sure is it,
 * do the rows add up to the statement's own footer, does the money that passes through the bank's accounts end at zero, and
 * does the money blocked for conversions equal what was sold and what came back.
 */
import { ENTERABLE, type LineType, type Unclassified, classifyStatement, gate } from "./classify.js";
import { currencyOfAccount, planLedger } from "./ledger.js";
import type { BankStatement } from "./statement.js";

export interface AccountReport {
  account: string;
  currency: string;
  lines: number;
  /** "type/confidence" → lines. */
  kinds: Record<string, number>;
  /** The statement's own balances, and whether its rows add up to them (null: the statement prints none). */
  opening: number | null;
  closing: number | null;
  balancesAgree: boolean | null;
}

export interface Acceptance {
  accounts: AccountReport[];
  fees: { lines: number; sum: number };
  budget: { lines: number; sum: number; vat: { lines: number; sum: number } };
  conversions: { pairs: number; notAgreeing: number };
  /** For each account that holds money blocked for a conversion: blocked = sold + returned, and the account ends at zero. */
  blocked: {
    account: string;
    blocked: number;
    sold: number;
    returned: number;
    agrees: boolean;
    endsAtZero: boolean | null;
  }[];
  /** Lines the program would enter, and those it holds back with the reason. */
  toEnter: number;
  held: Unclassified[];
}

const sum = (list: { amount: number }[]) => list.reduce((n, p) => n + p.amount, 0);

export function acceptance(statements: BankStatement[], options: { ownInn?: string } = {}): Acceptance {
  const own = new Set(statements.map((s) => s.account).filter(Boolean));
  const plan = planLedger(statements, options);
  const accounts: AccountReport[] = [];
  const held: Unclassified[] = [];
  let toEnter = 0;
  let feeLines = 0;
  let feeSum = 0;
  let taxLines = 0;
  let taxSum = 0;
  let vatLines = 0;
  let vatSum = 0;
  for (const s of statements) {
    const classes = classifyStatement(s, own);
    const kinds: Record<string, number> = {};
    for (const c of classes)
      kinds[`${c.type}/${c.confidence}`] = (kinds[`${c.type}/${c.confidence}`] ?? 0) + 1;
    const byRow = new Map(s.payments.map((p) => [p.row, p]));
    // The bank's fees and the payments to the budget are counted on the account the company pays from, once.
    const passThrough = plan.accounts.find((a) => a.account === s.account)?.role === "pass_through";
    if (!passThrough) {
      for (const c of classes) {
        const p = byRow.get(c.row);
        if (!p || p.direction !== "out" || c.confidence !== "high") continue;
        if (c.type === "bank_fee") {
          feeLines++;
          feeSum += p.amount;
        }
        if (c.type === "tax") {
          taxLines++;
          taxSum += p.amount;
          if (c.tax === "vat") {
            vatLines++;
            vatSum += p.amount;
          }
        }
      }
      const gated = gate(s, plan.rows.get(s.fileName) ?? [], own);
      toEnter += gated.allowed.length;
      held.push(...gated.held);
    }
    const credit = sum(s.payments.filter((p) => p.direction === "in"));
    const debit = sum(s.payments.filter((p) => p.direction === "out"));
    accounts.push({
      account: s.account,
      currency: currencyOfAccount(s.account),
      lines: s.payments.length,
      kinds,
      opening: s.balances?.opening ?? null,
      closing: s.balances?.closing ?? null,
      balancesAgree: s.balances ? s.balances.opening + credit - debit === s.balances.closing : null,
    });
  }

  const blocked: Acceptance["blocked"] = [];
  for (const s of statements) {
    if (!s.account.startsWith("22613")) continue;
    const taken = sum(s.payments.filter((p) => p.direction === "in"));
    const sold = sum(s.payments.filter((p) => p.direction === "out" && p.account.startsWith("17101")));
    const returned = sum(s.payments.filter((p) => p.direction === "out" && !p.account.startsWith("17101")));
    blocked.push({
      account: s.account,
      blocked: taken,
      sold,
      returned,
      agrees: taken === sold + returned,
      endsAtZero: s.balances ? s.balances.closing === 0 : null,
    });
  }
  return {
    accounts,
    fees: { lines: feeLines, sum: feeSum },
    budget: { lines: taxLines, sum: taxSum, vat: { lines: vatLines, sum: vatSum } },
    conversions: {
      pairs: plan.transfers.filter((t) => t.fx).length,
      notAgreeing: plan.mismatched.length,
    },
    blocked,
    toEnter,
    held,
  };
}

const money = (tiyin: number) =>
  (tiyin / 100)
    .toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .replace(/,/g, " ");

/** The report as text, for the accountant and for the log. */
export function acceptanceText(a: Acceptance): string {
  const lines: string[] = [];
  for (const r of a.accounts) {
    lines.push(
      `${r.account} (${r.currency || "?"}): ${r.lines} lines` +
        (r.balancesAgree === null
          ? ""
          : `; rows ${r.balancesAgree ? "agree" : "DO NOT agree"} with the statement's balances (${money(r.opening ?? 0)} → ${money(r.closing ?? 0)})`),
    );
    lines.push(
      "   " +
        Object.entries(r.kinds)
          .sort((x, y) => y[1] - x[1])
          .map(([k, n]) => `${k}=${n}`)
          .join("  "),
    );
  }
  lines.push(`Bank commissions: ${a.fees.lines} lines, ${money(a.fees.sum)} (all to 9430)`);
  lines.push(
    `Payments to the budget: ${a.budget.lines} lines, ${money(a.budget.sum)}; of them VAT ${a.budget.vat.lines} lines, ${money(a.budget.vat.sum)}`,
  );
  lines.push(
    `Conversions paired by the bank's words: ${a.conversions.pairs}; not agreeing with their rate: ${a.conversions.notAgreeing}`,
  );
  for (const b of a.blocked)
    lines.push(
      `Blocked on ${b.account}: ${money(b.blocked)} = sold ${money(b.sold)} + returned ${money(b.returned)}: ${b.agrees ? "agrees" : "DOES NOT AGREE"}; ends at zero: ${b.endsAtZero === null ? "not printed" : b.endsAtZero ? "yes" : "NO"}`,
    );
  lines.push(`Would be entered: ${a.toEnter} lines; held back for the accountant: ${a.held.length}`);
  const why = new Map<string, number>();
  for (const h of a.held)
    why.set(`${h.type}/${h.confidence}: ${h.why}`, (why.get(`${h.type}/${h.confidence}: ${h.why}`) ?? 0) + 1);
  for (const [k, n] of why) lines.push(`   held ${n} × ${k}`);
  return lines.join("\n");
}

export const WRITTEN_KINDS: LineType[] = ENTERABLE;
