/**
 * The financial result (2-shakl), the balance (1-shakl), the debts by counterparty and the stock, worked out by the
 * program from what 1C holds (the ledger's turnovers and balances), with no model. Every line says which accounts it
 * came from, so the accountant can follow any figure to 1C, and every report carries its own checks: assets against
 * liabilities, unusual balances, the profit in the balance against the result.
 *
 * The NSBU (BHMS) chart of 21 accounts is read by its groups (the first two digits): 01–09 long-term assets, 10–39
 * stock, production and deferred costs, 40–49 receivables, 50–59 money, 60–69 current liabilities, 70–79 long-term
 * liabilities, 80–89 equity, 90 sales, 91 cost of sales, 92/93 other operating income and expenses, 94 period
 * expenses, 95 financial income, 96 financial expenses, 97 emergency items, 98 taxes, 99 the final result (9910).
 * The month closing moves 90, 91 and 93–98 to 9910 every month: the result is therefore worked out from entries that do
 * not touch 99xx (see reports.ts), and the balance carries the profit of the open year from 9xxx as a whole. Accounts of
 * three digits or fewer are off-balance and are left out.
 */
import { type LedgerFinding, judgeBalances } from "../ledger-check.js";

export interface AccountRow {
  code: string;
  name: string;
  /** Soums: the turnover in a period, or the balance at a date. */
  debit: number;
  credit: number;
}

export interface Source {
  account: string;
  name: string;
  amount: number;
}

export interface Line {
  key: string;
  amount: number;
  /** The accounts the figure is made of, the biggest first. */
  sources: Source[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const OFF_BALANCE_MAX = 3;
const isOnBalance = (code: string) => code.length > OFF_BALANCE_MAX && /^\d/.test(code);
const groupOf = (code: string) => Number(code.slice(0, 2));

/** One row per account: several rows of one code (by currency, by organization) are added. */
function byAccount(rows: AccountRow[]): AccountRow[] {
  const map = new Map<string, AccountRow>();
  for (const r of rows) {
    if (!isOnBalance(r.code)) continue;
    const known = map.get(r.code);
    if (known) {
      known.debit += r.debit;
      known.credit += r.credit;
    } else map.set(r.code, { ...r });
  }
  return [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/** A line made of the accounts of some groups; `sign` +1 reads debit − credit, −1 credit − debit. */
function lineOf(key: string, rows: AccountRow[], groups: (g: number) => boolean, sign: 1 | -1): Line {
  const sources = rows
    .filter((r) => groups(groupOf(r.code)))
    .map((r) => ({ account: r.code, name: r.name, amount: round2(sign * (r.debit - r.credit)) }))
    .filter((s) => Math.abs(s.amount) >= 0.005)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  return { key, amount: round2(sources.reduce((sum, s) => sum + s.amount, 0)), sources };
}

const sum = (...n: number[]) => round2(n.reduce((a, b) => a + b, 0));

// --- Financial result -----------------------------------------------------------------------------------------

export interface ResultReport {
  from: string;
  to: string;
  /** The period is not over, or not all of it has been entered: the figures are not final. */
  provisional: boolean;
  revenue: Line;
  costOfSales: Line;
  grossProfit: number;
  periodExpenses: Line;
  otherOperating: Line;
  operatingProfit: number;
  financialIncome: Line;
  financialExpenses: Line;
  emergency: Line;
  profitBeforeTax: number;
  tax: Line;
  netProfit: number;
  findings: string[];
}

export function buildResult(
  turnovers: AccountRow[],
  period: { from: string; to: string },
  today: string,
): ResultReport {
  const rows = byAccount(turnovers);
  const revenue = lineOf("revenue", rows, (g) => g === 90, -1);
  const costOfSales = lineOf("costOfSales", rows, (g) => g === 91, 1);
  const periodExpenses = lineOf("periodExpenses", rows, (g) => g === 94, 1);
  // 92 and 93 are other operating income and expenses (9300 is «Прочие доходы от основной деятельности»): each account
  // counts by its own side, credit less debit.
  const otherOperating = lineOf("otherOperating", rows, (g) => g === 92 || g === 93, -1);
  const financialIncome = lineOf("financialIncome", rows, (g) => g === 95, -1);
  const financialExpenses = lineOf("financialExpenses", rows, (g) => g === 96, 1);
  const emergency = lineOf("emergency", rows, (g) => g === 97, -1);
  const tax = lineOf("tax", rows, (g) => g === 98, 1);

  const grossProfit = round2(revenue.amount - costOfSales.amount);
  const operatingProfit = round2(grossProfit - periodExpenses.amount + otherOperating.amount);
  const profitBeforeTax = sum(
    operatingProfit,
    financialIncome.amount,
    -financialExpenses.amount,
    emergency.amount,
  );
  const netProfit = round2(profitBeforeTax - tax.amount);

  const findings: string[] = [];
  const provisional = period.to >= today.slice(0, 10);
  if (provisional) findings.push("The period is not over: the figures are provisional.");
  if (revenue.amount < 0) findings.push("Revenue is negative: returns or discounts exceed the sales.");
  if (costOfSales.amount === 0 && revenue.amount > 0)
    findings.push("There is revenue but no cost of sales: the cost may not have been calculated yet.");

  return {
    from: period.from,
    to: period.to,
    provisional,
    revenue,
    costOfSales,
    grossProfit,
    periodExpenses,
    otherOperating,
    operatingProfit,
    financialIncome,
    financialExpenses,
    emergency,
    profitBeforeTax,
    tax,
    netProfit,
    findings,
  };
}

// --- Balance ---------------------------------------------------------------------------------------------------

export interface BalanceReport {
  date: string;
  longTermAssets: Line;
  stock: Line;
  receivables: Line;
  money: Line;
  totalAssets: number;
  currentLiabilities: Line;
  longTermLiabilities: Line;
  equity: Line;
  /** Profit or loss of the open year, not yet moved to the retained earnings. */
  currentResult: Line;
  totalLiabilities: number;
  /** Assets − liabilities and equity; 0 when the books balance. */
  difference: number;
  balanced: boolean;
  findings: (LedgerFinding | { account: string; name: string; balance: number; why: string })[];
}

export function buildBalance(balances: AccountRow[], date: string, resultNet?: number): BalanceReport {
  const rows = byAccount(balances);
  const longTermAssets = lineOf("longTermAssets", rows, (g) => g >= 1 && g <= 9, 1);
  const stock = lineOf("stock", rows, (g) => g >= 10 && g <= 39, 1);
  const receivables = lineOf("receivables", rows, (g) => g >= 40 && g <= 49, 1);
  const money = lineOf("money", rows, (g) => g >= 50 && g <= 59, 1);
  const currentLiabilities = lineOf("currentLiabilities", rows, (g) => g >= 60 && g <= 69, -1);
  const longTermLiabilities = lineOf("longTermLiabilities", rows, (g) => g >= 70 && g <= 79, -1);
  const equity = lineOf("equity", rows, (g) => g >= 80 && g <= 89, -1);
  const currentResult = lineOf("currentResult", rows, (g) => g >= 90 && g <= 99, -1);
  const totalAssets = sum(longTermAssets.amount, stock.amount, receivables.amount, money.amount);
  const totalLiabilities = sum(
    currentLiabilities.amount,
    longTermLiabilities.amount,
    equity.amount,
    currentResult.amount,
  );
  const difference = round2(totalAssets - totalLiabilities);

  const findings: BalanceReport["findings"] = [];
  if (Math.abs(difference) >= 0.01)
    findings.push({
      account: "—",
      name: "assets − liabilities and equity",
      balance: difference,
      why: "the balance does not close: an account is outside the groups read here, or the ledger was read at different moments",
    });
  if (resultNet !== undefined && Math.abs(currentResult.amount - resultNet) >= 0.01)
    findings.push({
      account: "90–99",
      name: "profit in the balance against the financial result",
      balance: round2(currentResult.amount - resultNet),
      why: "the profit of the open year in the balance and the net result of the period do not agree: part of the year was closed, or the period read is not the whole year",
    });
  // The unusual balances the accountant looks at (cash in credit, a receivable in credit, a liability in debit).
  for (const f of judgeBalances(rows).findings) findings.push(f);

  return {
    date,
    longTermAssets,
    stock,
    receivables,
    money,
    totalAssets,
    currentLiabilities,
    longTermLiabilities,
    equity,
    currentResult,
    totalLiabilities,
    difference,
    balanced: Math.abs(difference) < 0.01,
    findings: findings.slice(0, 40),
  };
}

// --- Debts by counterparty ---------------------------------------------------------------------------------------

export interface PartyRow {
  party: string;
  /** Debit and credit balance of the counterparty on the settlement accounts (several accounts are added). */
  debit: number;
  credit: number;
}

export interface DebtsReport {
  kind: "receivables" | "payables";
  date: string;
  total: number;
  /** Counterparties that owe (receivables) or are owed (payables), the biggest first. */
  parties: { party: string; amount: number }[];
  /** The other side: advances received (receivables) or paid (payables), shown apart, not netted. */
  advances: { party: string; amount: number }[];
  advancesTotal: number;
  count: number;
}

export function buildDebts(kind: DebtsReport["kind"], rows: PartyRow[], date: string, top = 30): DebtsReport {
  const net = new Map<string, number>();
  for (const r of rows) {
    const party = r.party.trim() || "—";
    // Receivables: what the counterparty owes is debit; payables: what we owe is credit.
    const value = kind === "receivables" ? r.debit - r.credit : r.credit - r.debit;
    net.set(party, (net.get(party) ?? 0) + value);
  }
  const all = [...net.entries()].map(([party, amount]) => ({ party, amount: round2(amount) }));
  const debts = all.filter((p) => p.amount >= 0.005).sort((a, b) => b.amount - a.amount);
  const advances = all
    .filter((p) => p.amount <= -0.005)
    .map((p) => ({ party: p.party, amount: round2(-p.amount) }))
    .sort((a, b) => b.amount - a.amount);
  return {
    kind,
    date,
    total: sum(...debts.map((p) => p.amount)),
    parties: debts.slice(0, top),
    advances: advances.slice(0, top),
    advancesTotal: sum(...advances.map((p) => p.amount)),
    count: debts.length,
  };
}

// --- Stock -------------------------------------------------------------------------------------------------------

export interface StockRow {
  item: string;
  warehouse: string;
  qty: number;
  amount: number;
}

export interface StockReport {
  date: string;
  total: number;
  positions: number;
  top: StockRow[];
  /** The checks of the plan (stock.check): negative stock, quantity without a cost, cost without quantity. */
  negative: StockRow[];
  noCost: StockRow[];
  noQuantity: StockRow[];
  byWarehouse: { warehouse: string; amount: number }[];
}

export function buildStock(rows: StockRow[], date: string, top = 30): StockReport {
  const merged = new Map<string, StockRow>();
  for (const r of rows) {
    const key = `${r.item}\u0000${r.warehouse}`;
    const known = merged.get(key);
    if (known) {
      known.qty += r.qty;
      known.amount += r.amount;
    } else merged.set(key, { ...r });
  }
  const all = [...merged.values()]
    .map((r) => ({ ...r, qty: round2(r.qty), amount: round2(r.amount) }))
    .filter((r) => Math.abs(r.qty) >= 0.0005 || Math.abs(r.amount) >= 0.005);
  const warehouses = new Map<string, number>();
  for (const r of all) warehouses.set(r.warehouse, (warehouses.get(r.warehouse) ?? 0) + r.amount);
  return {
    date,
    total: sum(...all.map((r) => r.amount)),
    positions: all.length,
    top: [...all].sort((a, b) => b.amount - a.amount).slice(0, top),
    negative: all.filter((r) => r.qty < -0.0005 || r.amount < -0.005).slice(0, 30),
    noCost: all.filter((r) => r.qty > 0.0005 && Math.abs(r.amount) < 0.005).slice(0, 30),
    noQuantity: all.filter((r) => Math.abs(r.qty) < 0.0005 && r.amount > 0.005).slice(0, 30),
    byWarehouse: [...warehouses.entries()]
      .map(([warehouse, amount]) => ({ warehouse, amount: round2(amount) }))
      .sort((a, b) => b.amount - a.amount),
  };
}
