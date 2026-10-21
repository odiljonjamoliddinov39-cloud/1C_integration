/**
 * The account ledger of a bank import: what the attached statements of one company say about each other.
 * A company's bank accounts are not separate worlds: money moves between them (a settlement account, a special
 * account for blocked funds, a transit account the bank passes its fees through), and each such movement is in
 * two statements. Read statement by statement, a bank import enters it twice, or as a payment to a counterparty
 * that is the company itself. This reads them together, in whole tiyin, with no AI:
 *
 *  - a statement the money only passes through (it opens and closes at zero, takes in only from the company's
 *    own accounts and pays out the same) is left out: its real payments are in the statement it passes them to;
 *  - a payment to such a pass-through account is the bank's fee: it is entered as a fee, with no counterparty;
 *  - a payment between two of the company's own accounts is matched with its other leg and reported as one
 *    transfer, not entered as a payment;
 *  - a statement of a foreign-currency account is entered in its currency (the payments are in dollars, euros…, with the
 *    rate of the payment's day); a move between accounts of two currencies is a conversion, reported with its legs;
 *  - everything else is a payment to hand to the resolver, inside the period asked for.
 */
import { parseAcquiring } from "./acquiring.js";
import type { BankPayment, BankStatement } from "./statement.js";

/** ISO 4217 numeric currency codes as banks write them in an account number; "000" is the national currency. */
const CURRENCIES: Record<string, string> = {
  "000": "UZS",
  "643": "RUB",
  "840": "USD",
  "978": "EUR",
  "826": "GBP",
};

/** The currency of a 20-digit Uzbek account: digits 6 to 8 are the currency code. */
export function currencyOfAccount(account: string): string {
  if (!/^\d{20}$/.test(account)) return "";
  const code = account.slice(5, 8);
  return CURRENCIES[code] ?? code;
}

export interface LedgerOptions {
  /** YYYY-MM-DD, inclusive. */
  from?: string | undefined;
  to?: string | undefined;
  /** The company's INN: a payment to it from an account that is not attached is a transfer to look at. */
  ownInn?: string | undefined;
}

export type AccountRole =
  /** Payments are entered from it. */
  | "settlement"
  /** Money only passes through it; its payments are in other statements. */
  | "pass_through"
  /** A foreign-currency account: its payments are entered in the currency. */
  | "foreign_currency"
  /** No payments in the period asked for. */
  | "empty";

export interface AccountView {
  file: string;
  account: string;
  currency: string;
  role: AccountRole;
  /** Why this role, in a line. */
  reason: string;
  /** Payments in the file, and those inside the period. */
  payments: number;
  inPeriod: number;
  /** Of those inside the period: handed on as payments, bank fees among them, and transfers between own accounts. */
  toEnter: number;
  fees: number;
  transfers: number;
}

/** What a pass-through account passes: the bank's fees, a currency conversion, or something else. */
export type PassKind = "fees" | "conversion" | "other";

export interface Transfer {
  /** Between two attached accounts, to a pass-through account of a currency conversion, or to the company's own account that is not attached. */
  kind: "own_account" | "conversion" | "unattached_own";
  date: string;
  /** Whole tiyin. */
  amount: number;
  fromAccount: string;
  toAccount: string;
  purpose: string;
  /** The row on the paying statement and on the receiving one (null: that statement is not attached). */
  out: { file: string; row: number } | null;
  in: { file: string; row: number } | null;
}

/** What an account paid into a pass-through account against what that account says it took in, whole period. */
export interface PassThroughCheck {
  from: string;
  to: string;
  /** Whole tiyin. */
  paid: number;
  took: number;
}

export interface LedgerPlan {
  accounts: AccountView[];
  /** The two sides of every payment into a pass-through account, compared. */
  checks: PassThroughCheck[];
  /** Rows each statement hands to the resolver (payments and bank fees), by file name. */
  rows: Map<string, number[]>;
  /** Of those rows: the ones that are the bank's fee to a pass-through account (no counterparty). */
  fees: Map<string, Set<number>>;
  /** Transfers between the company's own accounts (or to itself from an account not attached). */
  transfers: Transfer[];
  /** Counts of what was left out, for the report. */
  outsidePeriod: number;
  inPassThrough: number;
}

const FEE_WORDS = /комисси|тариф|commission|tariff|swift|ibank|за\s+документ/i;
const CONVERSION_WORDS = /валют|конверт|currency|convert|блокировк/i;

/** What a pass-through account passes, by the names and purposes of the payments it makes to others. */
function passKind(s: BankStatement, own: Set<string>): PassKind {
  const legs = s.payments.filter((p) => p.direction === "out" && !own.has(p.account));
  if (legs.length === 0) return "other";
  const share = (words: RegExp) =>
    legs.filter((p) => words.test(`${p.counterparty} ${p.purpose}`)).length / legs.length;
  if (share(FEE_WORDS) >= 0.5) return "fees";
  if (share(CONVERSION_WORDS) >= 0.5) return "conversion";
  return "other";
}

const inRange = (p: BankPayment, o: LedgerOptions) =>
  (!o.from || p.date >= o.from) && (!o.to || p.date <= o.to);

const sumOf = (payments: BankPayment[]) => payments.reduce((n, p) => n + p.amount, 0);

export function planLedger(statements: BankStatement[], options: LedgerOptions = {}): LedgerPlan {
  const byAccount = new Map<string, BankStatement>();
  for (const s of statements) if (s.account) byAccount.set(s.account, s);
  const own = new Set(byAccount.keys());

  // Pass-through statements: closed at zero, in only from own accounts, in equal to out.
  const passThrough = new Set<string>();
  for (const s of statements) {
    if (!s.account || s.payments.length === 0) continue;
    const incoming = s.payments.filter((p) => p.direction === "in");
    const outgoing = s.payments.filter((p) => p.direction === "out");
    const closedAtZero = !s.balances || (s.balances.opening === 0 && s.balances.closing === 0);
    const onlyOwnIn =
      incoming.length > 0 && incoming.every((p) => p.account !== s.account && own.has(p.account));
    // With printed balances the zero at both ends says it; a file missing rows is told apart by the checks below.
    const balanced = s.balances !== undefined || sumOf(incoming) === sumOf(outgoing);
    if (closedAtZero && onlyOwnIn && balanced) passThrough.add(s.account);
  }

  const passKinds = new Map<string, PassKind>();
  for (const account of passThrough) {
    const statement = byAccount.get(account);
    if (statement) passKinds.set(account, passKind(statement, own));
  }

  // The two statements must agree on what went into a pass-through account: a difference is a missing row.
  const checks: PassThroughCheck[] = [];
  for (const through of passThrough) {
    const receiver = byAccount.get(through);
    if (!receiver) continue;
    for (const source of statements) {
      if (!source.account || source.account === through) continue;
      const paid = sumOf(source.payments.filter((p) => p.direction === "out" && p.account === through));
      const took = sumOf(
        receiver.payments.filter((p) => p.direction === "in" && p.account === source.account),
      );
      if (paid > 0 || took > 0) checks.push({ from: source.account, to: through, paid, took });
    }
  }

  const plan: LedgerPlan = {
    checks,
    accounts: [],
    rows: new Map(),
    fees: new Map(),
    transfers: [],
    outsidePeriod: 0,
    inPassThrough: 0,
  };
  // A leg already matched with its other leg.
  const used = new Set<string>();
  const key = (file: string, row: number) => `${file}#${row}`;

  for (const s of statements) {
    const currency = currencyOfAccount(s.account);
    const inPeriod = s.payments.filter((p) => inRange(p, options));
    plan.outsidePeriod += s.payments.length - inPeriod.length;
    const view: AccountView = {
      file: s.fileName,
      account: s.account,
      currency,
      role: "settlement",
      reason: "",
      payments: s.payments.length,
      inPeriod: inPeriod.length,
      toEnter: 0,
      fees: 0,
      transfers: 0,
    };
    plan.accounts.push(view);
    if (s.account && passThrough.has(s.account)) {
      view.role = "pass_through";
      view.reason =
        `money only passes through it (opens and closes at zero, takes in only from the company's own accounts, pays out the same; ` +
        `${passKinds.get(s.account) === "fees" ? "the bank's fees" : passKinds.get(s.account) === "conversion" ? "a currency conversion" : "other payments"}): ` +
        "its rows are the other legs of payments in the other statements";
      plan.inPassThrough += inPeriod.length;
      continue;
    }
    const foreign = currency !== "" && currency !== "UZS";
    if (foreign) {
      view.role = "foreign_currency";
      view.reason = `an account in ${currency}: its payments are entered in ${currency}, with the rate of the payment's day`;
    }
    if (inPeriod.length === 0) {
      view.role = "empty";
      view.reason =
        s.payments.length === 0 ? "no payments in the file" : "no payments in the period asked for";
      continue;
    }

    const rows: number[] = [];
    const fees = new Set<number>();
    for (const p of inPeriod) {
      const toOwn = p.account !== "" && p.account !== s.account && own.has(p.account);
      // The terminals' takings arrive from the bank's own accounts under the company's INN, but they are receipts
      // to enter (gross, with the commission), not a move between the company's accounts.
      const terminal = p.direction === "in" && parseAcquiring(p.purpose, p.amount) !== null;
      const toSelfUnknown =
        !toOwn &&
        !terminal &&
        options.ownInn !== undefined &&
        p.inn === options.ownInn &&
        p.account !== s.account;
      // The bank's fee: a payment to an account the bank passes its fees through (attached, or one of the
      // company's own that is not attached but whose payments read as fees).
      const feeAccount =
        (toOwn && passKinds.get(p.account) === "fees") || (toSelfUnknown && FEE_WORDS.test(p.purpose));
      if (feeAccount && p.direction === "out") {
        rows.push(p.row);
        fees.add(p.row);
        view.fees += 1;
        continue;
      }
      if (!toOwn && !toSelfUnknown) {
        rows.push(p.row);
        continue;
      }
      view.transfers += 1;
      if (used.has(key(s.fileName, p.row))) continue;
      used.add(key(s.fileName, p.row));
      // The other leg: the same day and amount, the other way, on the statement of the other account.
      const other = toOwn ? byAccount.get(p.account) : undefined;
      const leg = other?.payments.find(
        (q) =>
          !used.has(key(other.fileName, q.row)) &&
          q.date === p.date &&
          q.amount === p.amount &&
          q.direction !== p.direction &&
          q.account === s.account,
      );
      if (other && leg) used.add(key(other.fileName, leg.row));
      const here = { file: s.fileName, row: p.row };
      const there = other && leg ? { file: other.fileName, row: leg.row } : null;
      plan.transfers.push({
        kind: !toOwn
          ? "unattached_own"
          : passKinds.get(p.account) === "conversion"
            ? "conversion"
            : "own_account",
        date: p.date,
        amount: p.amount,
        fromAccount: p.direction === "out" ? s.account : p.account,
        toAccount: p.direction === "out" ? p.account : s.account,
        purpose: p.purpose,
        out: p.direction === "out" ? here : there,
        in: p.direction === "out" ? there : here,
      });
    }
    plan.rows.set(s.fileName, rows);
    plan.fees.set(s.fileName, fees);
    view.toEnter = rows.length;
  }
  return plan;
}

const money = (tiyin: number) =>
  (tiyin / 100)
    .toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .replace(/,/g, " ");

/** What the model is told about the accounts of an import, in a few lines: the roles, the counts, the transfers. */
export function describeLedger(plan: LedgerPlan, options: LedgerOptions = {}): string {
  const period = options.from || options.to ? ` for ${options.from ?? "…"} – ${options.to ?? "…"}` : "";
  const lines = [`Bank accounts of this import${period}, read together by the program:`];
  for (const a of plan.accounts) {
    lines.push(
      `- ${a.account || a.file} (${a.currency || "?"}) ${a.role}: ${a.inPeriod} of ${a.payments} payments in the period` +
        (a.role === "settlement" || a.role === "foreign_currency"
          ? `; ${a.toEnter} to enter (${a.fees} bank fees)${a.transfers > 0 ? `, ${a.transfers} transfers between own accounts` : ""}`
          : `; ${a.reason}`),
    );
  }
  if (plan.transfers.length > 0) {
    const total = plan.transfers.reduce((n, t) => n + t.amount, 0);
    const unpaired = plan.transfers.filter((t) => !t.out || !t.in).length;
    lines.push(
      `Transfers between the company's own accounts: ${plan.transfers.length}, ${money(total)} in all` +
        (unpaired > 0
          ? `, ${unpaired} with no other leg in the attached statements`
          : ", each matched with its other leg") +
        ". They are not payments to a counterparty: propose_bank_payments enters each as a pair of documents (one on each account) copied from the company's own earlier transfers, and says what it could not.",
    );
  }
  const off = plan.checks.filter((c) => c.paid !== c.took);
  if (plan.checks.length > 0) {
    lines.push(
      off.length === 0
        ? `What was paid into the pass-through accounts equals what they took in (${plan.checks.length} pairs, the whole statements).`
        : "A pass-through account does not agree with the account that paid into it (a row is missing in one statement, tell the accountant): " +
            off.map((c) => `${c.from} paid ${money(c.paid)}, ${c.to} took in ${money(c.took)}`).join("; "),
    );
  }
  lines.push(
    "Enter with propose_bank_payments (title, from, to; no file, no rows): the program takes the period, the bank fees and the " +
      "payments itself. Do not read the file to find the rows.",
  );
  return lines.join("\n");
}
