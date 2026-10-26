/**
 * What every statement line is, read before anything is written. The kind of a line is told first by the counterparty's
 * account (its first five digits, a table built from the real statements: the bank's accounts carry the commission, the
 * conversion and the SWIFT lines, so a keyword must never outvote them), then by the purpose text and the contract it names,
 * and the answer carries a confidence:
 *
 *   high    the account and the text agree (or the account alone says it): the line may be entered;
 *   medium  the account is not known, or the text points to another kind than the account does;
 *   low     no text (the purpose is empty), or a currency the account does not hold.
 *
 * Only a line of high confidence is entered. A medium or low one goes to a list for the accountant, with the reason: nothing
 * is written that was not read.
 */
import type { BankLineType } from "@platform/shared";

import { currencyOfAccount } from "./ledger.js";
import { parseAcquiring } from "./acquiring.js";
import { BANK_INTERNAL, contractMention } from "./resolve.js";
import type { BankPayment, BankStatement } from "./statement.js";
import { type TaxKind, taxKindOf, withoutVatClause } from "./tax.js";
import { personIn } from "./transit.js";

export type LineType = BankLineType;

export type Confidence = "high" | "medium" | "low";

export interface Classified {
  row: number;
  type: LineType;
  confidence: Confidence;
  /** The rule that matched: the account prefix, the text, or why it did not. */
  rule: string;
  /** In a line, for the accountant. */
  why: string;
  /** For a tax: which. */
  tax?: TaxKind | null;
}

/** One row of the table: the first five digits of the counterparty's account, what such a line is, and where it is booked. */
export interface PrefixRow {
  prefix: string;
  type: LineType;
  /** The ledger account the entry goes to, when the table says (the expense account of a fee). */
  account?: string;
  what: string;
}

/**
 * The first five digits of the counterparty's account and what such a line is (the 720 lines of the main account of the
 * Texmash Import statements fall into these and no other kinds). The accountant confirms the table once, and may change a
 * row or add one (see `effectiveTable`).
 */
const DEFAULTS: { prefixes: string[]; type: LineType; account?: string; what: string }[] = [
  {
    prefixes: ["16401", "16413"],
    type: "bank_fee",
    account: "9430",
    what: "the bank's transit accounts for commissions",
  },
  { prefixes: ["22613"], type: "conversion", what: "UZS blocked for a conversion (a block, or its return)" },
  { prefixes: ["22614"], type: "conversion", what: "the bank's currency account of a conversion" },
  { prefixes: ["17101"], type: "conversion", what: "the bank's currency purchase and sale account" },
  { prefixes: ["16103"], type: "swift", what: "the bank's SWIFT account" },
  { prefixes: ["23402"], type: "tax", what: "the treasury" },
  { prefixes: ["22628"], type: "tax", what: "the tax office, INPS" },
  { prefixes: ["29801"], type: "customs", what: "the customs duties transit" },
  { prefixes: ["23120"], type: "individual_card", what: "the transit for individuals' card top-ups" },
  {
    prefixes: ["20208", "20218", "20214", "20210", "20206", "10101", "17409", "29896"],
    type: "contract_payment",
    what: "an account of a company, an entrepreneur, an exchange, a deposit or the cash",
  },
];

/** The program's own table, row by row. */
export const DEFAULT_TABLE: PrefixRow[] = DEFAULTS.flatMap((d) =>
  d.prefixes.map((prefix) => ({
    prefix,
    type: d.type,
    ...(d.account ? { account: d.account } : {}),
    what: d.what,
  })),
);

/** The table in force: the program's own, with the rows the accountant confirmed, changed or added over it. */
export function effectiveTable(
  stored: { prefix: string; type: LineType; account?: string }[] = [],
): PrefixRow[] {
  const rows = new Map(DEFAULT_TABLE.map((r) => [r.prefix, r]));
  for (const s of stored)
    rows.set(s.prefix, {
      prefix: s.prefix,
      type: s.type,
      ...(s.account ? { account: s.account } : {}),
      what: rows.get(s.prefix)?.what ?? "a row the accountant added",
    });
  return [...rows.values()];
}

/** What the text of a purpose says it is, by words (the account decides first; these only break ties). */
const FEE_WORDS =
  /комисси|(?<!\p{L})тариф|за\s+документ\s+№|ibank|swift|обслуживани\p{L}*\s+(?:пассивн|счет|счёт)/iu;
const CONVERSION_WORDS = /конвертац/iu;
const CUSTOMS_WORDS = /таможенн\p{L}*\s+(?:пошлин|платеж|сбор)|bojxona\s+to['‘’ʻ`]lov/iu;
/** Cash to the bank (the company's own cash paid into its account), cash from the bank, and a founder's contribution. */
const CASH_IN_WORDS =
  /взнос\s+наличн|внесени\p{L}*\s+наличн|сдача\s+наличн|пополнени\p{L}*\s+(?:сч[её]та\s+)?наличн|naqd\s+pul\s+(?:kirit|topshir)|депонир\p{L}*\s+наличн/iu;
const CASH_OUT_WORDS =
  /снятие\s+наличн|получени\p{L}*\s+наличн|выдач\p{L}*\s+наличн|naqd\s+pul\s+(?:olish|yechish)|на\s+хоз\p{L}*\s+нужд|на\s+выплат\p{L}*\s+(?:заработн|зарплат)/iu;
const CAPITAL_WORDS =
  /устав\p{L}*\s+(?:капитал|фонд)|взнос\s+(?:учредител|в\s+устав)|вклад\s+(?:учредител|в\s+устав)|ustav\s+(?:kapital|fond)|ta['‘’ʻ`]sischi/iu;
const RETURN_WORDS = /возврат|vozvrat|qaytar/iu;
/** A foreign currency named with an amount or in quotes ("8000.00USD", "4165.0 'Доллар США'"). */
const FOREIGN_AMOUNT =
  /\d[\d\s.,]*\s*(?:usd|eur|rub|cny|gbp|долл\p{L}*|евро|рубл\p{L}*)(?![\p{L}])|['"«](?:доллар|евро|рубл|юань)\p{L}*/iu;

/** A current account of a legal entity or an entrepreneur (202xx) is a company's, whatever its last digits. */
const COMPANY_ACCOUNT = /^20[2-4]\d\d/;

const prefixOf = (account: string, table: PrefixRow[]): PrefixRow | undefined =>
  table.find((r) => r.prefix === account.slice(0, 5)) ??
  (COMPANY_ACCOUNT.test(account) ? table.find((r) => r.type === "contract_payment") : undefined);

export interface ClassifyContext {
  /** The statement's own account, and the number of every attached account of the company. */
  account: string;
  own: Set<string>;
  /** The table in force; the program's own when absent. */
  table?: PrefixRow[];
}

/** Words a purpose has beyond its codes: a purpose of digits and a bank code alone is no text. */
const hasText = (purpose: string) => /\p{L}{3}/u.test(purpose.replace(/\$[A-Z_]+\$\d*/g, " "));

export function classifyLine(p: BankPayment, ctx: ClassifyContext): Classified {
  const purpose = p.purpose.replace(/\s+/g, " ").trim();
  const row = p.row;
  const line = (type: LineType, confidence: Confidence, rule: string, why: string, tax?: TaxKind | null) => ({
    row,
    type,
    confidence,
    rule,
    why,
    ...(tax !== undefined ? { tax } : {}),
  });
  if (!hasText(purpose))
    return line("unknown", "low", "no text", "the purpose is empty: a line with no text is not written");

  if (p.direction === "in" && parseAcquiring(purpose, p.amount))
    return line(
      "terminal_receipt",
      "high",
      "terminal",
      "a card terminal's takings (gross and commission in the text)",
    );

  const accountCurrency = currencyOfAccount(ctx.account);
  const foreignAccount = accountCurrency !== "" && accountCurrency !== "UZS";
  const matched = prefixOf(p.account, ctx.table ?? DEFAULT_TABLE);
  // The company's own accounts, attached: a move between them. The bank's own accounts (the commission, conversion and SWIFT
  // ones) are attached too, but they say what the line is first.
  if (
    p.account &&
    p.account !== ctx.account &&
    ctx.own.has(p.account) &&
    (!matched || matched.type === "contract_payment")
  )
    return line(
      "own_transfer",
      "high",
      `own account ${p.account.slice(0, 5)}`,
      "a move between the company's own accounts",
    );
  const text = withoutVatClause(purpose);
  const taxKind = taxKindOf(purpose);

  if (matched) {
    const rule = `account ${matched.prefix}`;
    switch (matched.type) {
      case "bank_fee":
        // The prefix decides: a fee that says «в том числе НДС» is a fee, not a payment of VAT.
        return line(
          "bank_fee",
          "high",
          rule,
          `bank commission (${matched.what})${matched.account ? `, to ${matched.account}` : ""}`,
        );
      case "conversion":
      case "swift":
        return line(matched.type, "high", rule, `${matched.what}: a leg of a conversion or a SWIFT payment`);
      case "customs":
        return line("customs", "high", rule, `a customs payment (${matched.what})`);
      case "tax":
        return taxKind
          ? line("tax", "high", rule, `a payment to the budget: ${taxKind}`, taxKind)
          : line("tax", "medium", rule, "a payment to the budget whose tax the text does not name", null);
      case "individual_card": {
        const person = personIn(purpose);
        return person || contractMention(purpose)
          ? line(
              "individual_card",
              "high",
              rule,
              `a payment to an individual by card${person ? `: ${person}` : ""}`,
            )
          : line(
              "individual_card",
              "medium",
              rule,
              "a payment to an individual's card; the text names neither him nor a contract",
            );
      }
      default:
        return contractLine(rule);
    }
  }

  // A statement that gives no counterparty account for the row: the INN and the name the bank wrote say who it is, as long
  // as the name is not one of the bank's own ledger lines.
  if (
    !p.account &&
    /^\d{9,14}$/.test(p.inn) &&
    p.counterparty.trim() !== "" &&
    !BANK_INTERNAL.test(p.counterparty.trim())
  )
    return contractLine("INN and text (no account in the statement)");

  // The account is not one the table knows: the text alone, never enough to write.
  return fromText();

  /** A company's account: a payment under a contract, unless the text says it is something else. */
  function contractLine(rule: string): Classified {
    // A founder's contribution, and the company's own cash paid in or taken out, are told by the text.
    if (p.direction === "in" && CAPITAL_WORDS.test(text))
      return line(
        "charter_capital",
        /^\d{9,14}$/.test(p.inn) ? "high" : "medium",
        `${rule} + text`,
        "a founder's contribution to the charter capital (the text says so)",
      );
    if (p.direction === "in" && CASH_IN_WORDS.test(text) && !contractMention(purpose))
      return line(
        "cash_deposit",
        "high",
        `${rule} + text`,
        "cash paid into the account (two steps through 5710)",
      );
    if (p.direction === "out" && CASH_OUT_WORDS.test(text))
      return line(
        "cash_withdrawal",
        "high",
        `${rule} + text`,
        "cash taken out of the account (two steps through 5710)",
      );
    const other: string[] = [];
    if (FEE_WORDS.test(text) && !/договор|shartnoma|контракт|contract/iu.test(text)) other.push("a fee");
    if (taxKind) other.push("a tax");
    if (CONVERSION_WORDS.test(text)) other.push("a conversion");
    if (CUSTOMS_WORDS.test(text)) other.push("a customs payment");
    if (other.length > 0)
      return line(
        "contract_payment",
        "medium",
        `${rule} vs text`,
        `the account says a payment under a contract, the text says ${other.join(" and ")}`,
      );
    if (!foreignAccount && FOREIGN_AMOUNT.test(text))
      return line(
        "contract_payment",
        "low",
        "currency mismatch",
        `the text names a foreign currency on a ${accountCurrency || "soum"} account`,
      );
    const contract = contractMention(purpose);
    return line(
      "contract_payment",
      "high",
      rule,
      `a ${p.direction === "in" ? "receipt" : "payment"} under ${contract ? `contract ${contract.number}` : "a contract (none named in the text)"}${RETURN_WORDS.test(text) ? ", a return" : ""}`,
    );
  }

  function fromText(): Classified {
    const guesses: LineType[] = [];
    if (FEE_WORDS.test(text)) guesses.push("bank_fee");
    if (taxKind) guesses.push("tax");
    if (CONVERSION_WORDS.test(text)) guesses.push("conversion");
    if (CUSTOMS_WORDS.test(text)) guesses.push("customs");
    if (p.direction === "in" && CAPITAL_WORDS.test(text)) guesses.push("charter_capital");
    if (p.direction === "in" && CASH_IN_WORDS.test(text)) guesses.push("cash_deposit");
    if (p.direction === "out" && CASH_OUT_WORDS.test(text)) guesses.push("cash_withdrawal");
    const which = p.account ? p.account.slice(0, 5) : "(none)";
    if (guesses.length === 1 && guesses[0])
      return line(
        guesses[0],
        "medium",
        "text only",
        `the account ${which} is not one the program knows; the text reads as ${guesses[0]}`,
        guesses[0] === "tax" ? taxKind : undefined,
      );
    return line(
      "unknown",
      guesses.length > 1 ? "low" : "medium",
      guesses.length > 1 ? "text fits several kinds" : "unknown account",
      guesses.length > 1
        ? `the text fits more than one kind (${guesses.join(", ")})`
        : `the account ${which} is not one the program knows and the text names no kind`,
    );
  }
}

export function classifyStatement(
  statement: BankStatement,
  own: Set<string>,
  table?: PrefixRow[],
): Classified[] {
  const ctx = { account: statement.account, own, ...(table ? { table } : {}) };
  return statement.payments.map((p) => classifyLine(p, ctx));
}

/** The kinds a line may be entered as; the rest are moves between accounts, made by the transfer code, or not understood. */
export const ENTERABLE: LineType[] = [
  "bank_fee",
  "tax",
  "customs",
  "individual_card",
  "swift",
  "terminal_receipt",
  "contract_payment",
  "cash_deposit",
  "cash_withdrawal",
  "charter_capital",
];

export interface Unclassified {
  file: string;
  row: number;
  date: string;
  direction: "in" | "out";
  /** Whole tiyin. */
  amount: number;
  counterparty: string;
  purpose: string;
  type: LineType;
  confidence: Confidence;
  why: string;
}

/**
 * Of the rows a statement hands to the resolver, those that may be written (high confidence, a kind that is entered as a
 * payment) and those that go to the accountant's list.
 */
export function gate(
  statement: BankStatement,
  rows: number[],
  own: Set<string>,
  table?: PrefixRow[],
): { allowed: number[]; held: Unclassified[]; classes: Map<number, Classified> } {
  const classes = new Map(classifyStatement(statement, own, table).map((c) => [c.row, c]));
  const byRow = new Map(statement.payments.map((p) => [p.row, p]));
  const allowed: number[] = [];
  const held: Unclassified[] = [];
  for (const row of rows) {
    const c = classes.get(row);
    const p = byRow.get(row);
    if (!c || !p) continue;
    if (c.confidence === "high" && ENTERABLE.includes(c.type)) allowed.push(row);
    else
      held.push({
        file: statement.fileName,
        row,
        date: p.date,
        direction: p.direction,
        amount: p.amount,
        counterparty: p.counterparty.replace(/\s+/g, " ").trim(),
        purpose: p.purpose.replace(/\s+/g, " ").trim().slice(0, 140),
        type: c.type,
        confidence: c.confidence,
        why: c.why,
      });
  }
  return { allowed, held, classes };
}
