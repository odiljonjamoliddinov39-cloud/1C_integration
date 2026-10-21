/**
 * The balances an accountant looks at after entering a year of bank documents, read once and judged by the program:
 * a cash or bank account in credit, a transit account that does not close, a liability account in debit (a payment with
 * no accrual behind it), the exchange differences. The model used to read the registers again and again to find the
 * same things, a step (and its tokens) at a time.
 */

export interface BalanceRow {
  code: string;
  name: string;
  /** Soums, end of the day. */
  debit: number;
  credit: number;
}

export interface LedgerFinding {
  account: string;
  name: string;
  /** Positive: debit; negative: credit. */
  balance: number;
  why: string;
}

const CASH = /^5[0-5]/;
const TRANSIT = /^57/;
const LIABILITY = /^6[0-9]/;
const RECEIVABLE = /^4[0-9]/;
const EXCHANGE_INCOME = /^95/;
const EXCHANGE_EXPENSE = /^96/;

const round2 = (n: number) => Math.round(n * 100) / 100;

export function judgeBalances(rows: BalanceRow[]): {
  accounts: number;
  findings: LedgerFinding[];
  exchangeDifferences: { income: number; expense: number };
} {
  const net = new Map<string, { name: string; balance: number }>();
  for (const r of rows) {
    const known = net.get(r.code);
    net.set(r.code, { name: known?.name ?? r.name, balance: (known?.balance ?? 0) + r.debit - r.credit });
  }
  const findings: LedgerFinding[] = [];
  let transit = 0;
  let income = 0;
  let expense = 0;
  for (const [code, { name, balance }] of net) {
    const value = round2(balance);
    if (EXCHANGE_INCOME.test(code)) income += -value;
    if (EXCHANGE_EXPENSE.test(code)) expense += value;
    // The transit accounts are judged together: the two legs of a move sit on two of them and must cancel.
    if (TRANSIT.test(code)) transit += value;
    if (Math.abs(value) < 0.005) continue;
    const add = (why: string) => findings.push({ account: code, name, balance: value, why });
    if (CASH.test(code) && value < 0)
      add("a cash or bank account in credit: more was paid out than it ever held");
    else if (TRANSIT.test(code)) continue;
    else if (LIABILITY.test(code) && value > 0 && !/^(631|632)/.test(code))
      add("a liability account in debit: paid with no accrual behind it, or an advance on the wrong account");
    else if (RECEIVABLE.test(code) && value < 0)
      add(
        "a receivable account in credit: received with no sale behind it, or an advance on the wrong account",
      );
  }
  if (Math.abs(transit) >= 0.005)
    findings.push({
      account: "57xx",
      name: "transit accounts together",
      balance: round2(transit),
      why: "the transit accounts do not close: the two legs of a transfer or conversion differ (a different rate on each leg, or a leg not entered)",
    });
  findings.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
  return {
    accounts: net.size,
    findings: findings.slice(0, 30),
    exchangeDifferences: { income: round2(income), expense: round2(expense) },
  };
}
