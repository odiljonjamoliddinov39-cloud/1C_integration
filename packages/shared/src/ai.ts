/**
 * The AI assistant (TD §7 "AI assistant", §8 "AI proxy"). The desktop app runs the tools against
 * 1C on the PC and sends the conversation to the control system; the control system holds the
 * Claude API key, the system prompt and the tool list, and counts tokens per account.
 */
import { z } from "zod";

import {
  ChangeInput,
  DeleteMarkedInput,
  GetObjectInput,
  InvoiceReceivedDraft,
  RunQueryInput,
  SaleLookup,
} from "./platform-api.js";

const Column = z
  .string()
  .regex(/^[A-Za-z]{1,3}$/)
  .describe("A column by its letter, as in Excel: A, B, … AA");

/**
 * Reads a spreadsheet or CSV the user attached to the chat; runs on the PC, over the whole file.
 * Rows can be filtered; with group_by or sum it returns counts and totals instead of rows.
 */
export const ReadAttachmentInput = z.object({
  /** The file name as attached. */
  file: z.string().min(1).max(200),
  /** Sheet name; the first sheet when absent. */
  sheet: z.string().max(100).optional(),
  /** Row numbers (1-based, inclusive) to look at; the whole sheet when absent. */
  from: z.number().int().min(1).optional(),
  to: z.number().int().min(1).optional(),
  where: z
    .array(
      z.object({
        column: Column,
        op: z.enum(["=", "!=", "contains", ">", ">=", "<", "<=", "empty", "not_empty"]),
        value: z.string().max(200).optional(),
      }),
    )
    .max(10)
    .optional(),
  /** Groups the matching rows by a column's value, or by the day or month of a date column. */
  group_by: z.object({ column: Column, by: z.enum(["value", "day", "month"]).default("value") }).optional(),
  /** Columns to total (numbers like "1 234 567,89" are read too). */
  sum: z.array(Column).max(10).optional(),
  /** Columns to return when listing rows; all when absent. */
  columns: z.array(Column).max(30).optional(),
  /** Rows (or groups) to return, at most 5000; 200 by default. */
  limit: z.number().int().min(1).max(5000).optional(),
});
export type ReadAttachmentInput = z.infer<typeof ReadAttachmentInput>;

/** One change of a batch: what it does not share with the others (the rest comes from `defaults`). */
const BatchChange = z.object({
  action: z.enum(["create", "update", "delete", "undelete"]).optional(),
  object: z.string().trim().min(1).max(200).optional(),
  ref: z.string().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).optional(),
  post: z.boolean().optional(),
});

/**
 * What every change of a batch shares, written once instead of in each: the object and action, the
 * fields (organization, bank account, operation type, accounts…), posting, and per tabular section
 * the columns every row has (e.g. the settlement accounts of РасшифровкаПлатежа). A change's own
 * values win.
 */
const BatchDefaults = z.object({
  action: z.enum(["create", "update", "delete", "undelete"]).optional(),
  object: z.string().trim().min(1).max(200).optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  rows: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  post: z.boolean().optional(),
});
export type BatchDefaults = z.infer<typeof BatchDefaults>;

/**
 * Several changes on one card with one confirmation: a bank statement's documents, a list of
 * invoices. Each is checked by 1C first; those 1C refuses are shown and left out.
 */
export const ChangeBatchInput = z.object({
  /** What the batch does, for the card's title, e.g. "Bank statement 01–15.09: 42 documents". */
  title: z.string().trim().min(1).max(200),
  defaults: BatchDefaults.optional(),
  changes: z.array(BatchChange).min(1).max(1000),
});
export type ChangeBatchInput = z.infer<typeof ChangeBatchInput>;

/** Dry run: 1C checks a few changes as it would before a card, and nothing is shown or written. */
export const CheckChangesInput = z.object({
  defaults: BatchDefaults.optional(),
  changes: z.array(BatchChange).min(1).max(20),
});
export type CheckChangesInput = z.infer<typeof CheckChangesInput>;

/** Each change of a batch with its defaults filled in, or why it is not a valid change. */
export function expandBatch(input: {
  defaults?: BatchDefaults | undefined;
  changes: z.infer<typeof BatchChange>[];
}): ({ ok: true; change: ChangeInput } | { ok: false; message: string })[] {
  const d = input.defaults ?? {};
  return input.changes.map((c) => {
    const fields = d.fields || c.fields ? { ...d.fields, ...c.fields } : undefined;
    const tables = c.tables
      ? Object.fromEntries(
          Object.entries(c.tables).map(([name, rows]) => [
            name,
            rows.map((row) => ({ ...d.rows?.[name], ...row })),
          ]),
        )
      : undefined;
    const post = c.post ?? d.post;
    const merged = ChangeInput.safeParse({
      action: c.action ?? d.action,
      object: c.object ?? d.object,
      ...(c.ref !== undefined ? { ref: c.ref } : {}),
      ...(fields ? { fields } : {}),
      ...(tables ? { tables } : {}),
      ...(post !== undefined ? { post } : {}),
    });
    return merged.success
      ? { ok: true as const, change: merged.data }
      : {
          ok: false as const,
          message: merged.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        };
  });
}

/** Issued invoices for many sales on one card: each sale's invoice is filled by 1C from the sale. */
export const InvoicesIssuedInput = z.object({
  /** For the card's title, in the accountant's language, e.g. "Счета-фактуры за сентябрь: 78". */
  title: z.string().trim().min(1).max(200),
  sales: z.array(SaleLookup).min(1).max(1000),
});
export type InvoicesIssuedInput = z.infer<typeof InvoicesIssuedInput>;

/** Many suppliers' invoices on one card. */
export const InvoicesReceivedInput = z.object({
  title: z.string().trim().min(1).max(200),
  invoices: z.array(InvoiceReceivedDraft).min(1).max(500),
});
export type InvoicesReceivedInput = z.infer<typeof InvoicesReceivedInput>;

const Ref = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "1C reference (UUID)");

/**
 * Invoices from the Didox documents the app has read from the attached files: the app builds them
 * itself and looks the counterparty, the contract and the items up in 1C. Only what it could not
 * settle comes back to the model, and the model answers with references, never with the invoices.
 */
export const DidoxInvoicesInput = z.object({
  /** For the card's title, in the accountant's language, e.g. "Hisob-fakturalar HYDRO DRILL: 12". */
  title: z.string().trim().min(1).max(200),
  /** Documents as the summary names them ("312318957/24"); absent: every one that is ready. */
  documents: z.array(z.string().min(1).max(80)).max(500).optional(),
  /**
   * A period (YYYY-MM-DD, by the documents' own dates) to read from Didox first: the app reads the incoming documents
   * itself, applies the company's standing rules and makes the card, in one step. Absent: the documents already in the chat.
   */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** The model's answers to what the app could not settle: an item for a line, a counterparty, a contract. */
  items: z
    .array(z.object({ document: z.string().min(1).max(80), line: z.number().int().min(1), ref: Ref }))
    .max(3000)
    .optional(),
  counterparties: z
    .array(z.object({ document: z.string().min(1).max(80), ref: Ref }))
    .max(500)
    .optional(),
  contracts: z
    .array(z.object({ document: z.string().min(1).max(80), ref: Ref }))
    .max(500)
    .optional(),
  /**
   * A VAT rate the base does not have, entered under another it has: {from: 12, to: 15} writes the lines of 12% with
   * the base's 15% rate and the VAT amount the supplier's document says. Only when the accountant decided so.
   */
  vatRateMap: z
    .array(z.object({ from: z.number().min(0).max(100), to: z.number().min(0).max(100) }))
    .max(10)
    .optional(),
  /** The ledger accounts (codes) the lines are booked to: by kind, and by words in the line's name (the first rule that fits). */
  accounts: z
    .object({
      goods: z.string().trim().min(1).max(20).optional(),
      service: z.string().trim().min(1).max(20).optional(),
    })
    .optional(),
  accountRules: z
    .array(
      z.object({
        /** Words of the line's name, any of them (case does not matter): "аренда|ижара|rent". */
        match: z.string().trim().min(1).max(200),
        account: z.string().trim().min(1).max(20),
      }),
    )
    .max(40)
    .optional(),
});
export type DidoxInvoicesInput = z.infer<typeof DidoxInvoicesInput>;

/**
 * The company's own Didox documents (it is the seller) entered into 1C as sales, by the app: it reads them for the
 * period (or takes the attached ones), looks the buyer, the contract and the items up, and copies the company's last
 * sale for the accounts and the warehouse. Same answers as for the received ones; a warehouse may be given.
 */
export const DidoxSalesInput = DidoxInvoicesInput.extend({ warehouse: Ref.optional() });
export type DidoxSalesInput = z.infer<typeof DidoxSalesInput>;

const Money = z.number().finite().min(-1e15).max(1e15);
const Percent = z.number().finite().min(0).max(1000);

/**
 * Accounting arithmetic done by the program, so that no figure in an answer is the model's own sum: pick the
 * operation and give the inputs; the result is exact to the cent and its parts add up to the whole.
 */
export const AccountingCalcInput = z.discriminatedUnion("op", [
  /** VAT out of a net amount, or out of a gross one. */
  z.object({ op: z.literal("vat"), amount: Money, rate: Percent, mode: z.enum(["exclusive", "inclusive"]) }),
  /** A depreciation schedule: straight line, declining balance, sum of years' digits, or by units of output. */
  z.object({
    op: z.literal("depreciation"),
    cost: Money,
    residual: Money.optional(),
    periods: z.number().int().min(1).max(600),
    method: z.enum(["straight_line", "declining_balance", "sum_of_years", "units"]),
    /** Declining balance: 2 = double declining (default). */
    factor: z.number().min(1).max(5).optional(),
    /** Units: the output of each period. */
    units: z.array(z.number().min(0)).max(600).optional(),
  }),
  /** A loan schedule: equal instalments (annuity) or equal principal (differentiated). */
  z.object({
    op: z.literal("loan"),
    principal: Money,
    annualRate: Percent,
    months: z.number().int().min(1).max(600),
    type: z.enum(["annuity", "differentiated"]),
  }),
  /** NPV at a rate, the internal rate of return and the payback of a series of cash flows (the first is period 0). */
  z.object({ op: z.literal("npv_irr"), rate: Percent, cashflows: z.array(Money).min(2).max(200) }),
  /** Foreign-currency balances revalued at the closing rate: the exchange difference of each and in all. */
  z.object({
    op: z.literal("fx_revaluation"),
    items: z
      .array(
        z.object({
          name: z.string().max(200),
          kind: z.enum(["asset", "liability"]),
          /** The balance in the foreign currency. */
          amount: Money,
          bookRate: z.number().positive(),
          closingRate: z.number().positive(),
        }),
      )
      .min(1)
      .max(200),
  }),
  /** The cost of what is issued from stock: FIFO, LIFO or the average; what stays. */
  z.object({
    op: z.literal("costing"),
    method: z.enum(["fifo", "lifo", "average"]),
    opening: z.object({ qty: z.number().min(0), unitCost: z.number().min(0) }).optional(),
    movements: z
      .array(
        z.object({
          type: z.enum(["in", "out"]),
          qty: z.number().positive(),
          /** For a receipt. */
          unitCost: z.number().min(0).optional(),
        }),
      )
      .min(1)
      .max(1000),
  }),
  /** Gross to net (or net to gross) with the income tax, the employee's pension contribution and the employer's social tax. */
  z.object({
    op: z.literal("payroll"),
    gross: Money.optional(),
    net: Money.optional(),
    incomeTaxRate: Percent.optional(),
    inpsRate: Percent.optional(),
    employerSocialRate: Percent.optional(),
    /** The income tax is on the gross less the employee's pension contribution. */
    taxAfterInps: z.boolean().optional(),
  }),
  /** An import (GTD): customs value, duty, excise, import VAT and the landed cost of each item, costs shared exactly. */
  z.object({
    op: z.literal("landed_cost"),
    /** Soums per unit of the invoice currency. */
    rate: z.number().positive(),
    items: z
      .array(
        z.object({
          name: z.string().max(200),
          /** The invoice value in the invoice currency. */
          value: z.number().min(0),
          qty: z.number().positive().optional(),
          weight: z.number().min(0).optional(),
          dutyRate: Percent.optional(),
          exciseRate: Percent.optional(),
        }),
      )
      .min(1)
      .max(200),
    /** Freight and insurance in the invoice currency, shared by value or weight. */
    freight: z.number().min(0).optional(),
    insurance: z.number().min(0).optional(),
    allocateBy: z.enum(["value", "weight"]).optional(),
    /** In soums, shared by value. */
    customsFee: z.number().min(0).optional(),
    otherCosts: z.number().min(0).optional(),
    vatRate: Percent.optional(),
    /** False: the import VAT goes into the cost. Default true (offset against output VAT). */
    vatRecoverable: z.boolean().optional(),
  }),
  /** A penalty for late payment: per day on a principal, for days or for dates, with a cap. */
  z.object({
    op: z.literal("penalty"),
    principal: Money,
    days: z.number().int().min(0).max(36500).optional(),
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    /** Percent per day, 0.033 by default. */
    ratePerDay: z.number().min(0).max(10).optional(),
    /** The most the penalty can be, as a percent of the principal. */
    capPercent: z.number().min(0).max(1000).optional(),
  }),
  /** Liquidity, turnover days, margins, returns and cover from the figures given. */
  z.object({
    op: z.literal("ratios"),
    currentAssets: Money.optional(),
    currentLiabilities: Money.optional(),
    inventory: Money.optional(),
    cash: Money.optional(),
    receivables: Money.optional(),
    payables: Money.optional(),
    revenue: Money.optional(),
    cogs: Money.optional(),
    netIncome: Money.optional(),
    equity: Money.optional(),
    totalAssets: Money.optional(),
    totalDebt: Money.optional(),
    ebit: Money.optional(),
    interest: Money.optional(),
    /** Days in the period, 365 by default. */
    days: z.number().int().min(1).max(366).optional(),
  }),
  /** Break-even units and revenue, and for a target profit. */
  z.object({
    op: z.literal("break_even"),
    fixedCosts: Money,
    price: z.number().positive(),
    variableCost: z.number().min(0),
    targetProfit: Money.optional(),
  }),
  /** A total shared in proportion to weights, to the cent, the parts adding up exactly. */
  z.object({ op: z.literal("allocate"), total: Money, weights: z.array(z.number().min(0)).min(1).max(500) }),
]);
export type AccountingCalcInput = z.infer<typeof AccountingCalcInput>;

/**
 * What the model sends: the operation and its fields, flat. The strict shape is `AccountingCalcInput`, which the app
 * checks (a tool's input schema cannot be a union at the top level), and says what is wrong when a field is missing.
 */
export const ACCOUNTING_CALC_OPS = [
  "vat",
  "depreciation",
  "loan",
  "npv_irr",
  "fx_revaluation",
  "costing",
  "payroll",
  "landed_cost",
  "penalty",
  "ratios",
  "break_even",
  "allocate",
] as const;
export const AccountingCalcTool = z.looseObject({ op: z.enum(ACCOUNTING_CALC_OPS) });

/**
 * The accountant's standing decisions for this company, kept between chats and sent with every question: a VAT rate
 * written under another, the ledger account of a kind of expense or goods, how a kind of document is treated.
 */
export const CompanyRulesInput = z.object({
  action: z.enum(["list", "add", "remove"]),
  /** For add: one short sentence, complete in itself ("Didox lines of 12% VAT are written under the base's 15% rate"). */
  rule: z.string().trim().min(3).max(400).optional(),
  /** For remove: the rule's number in the list, or words it has. */
  which: z.union([z.number().int().min(1).max(100), z.string().trim().min(2).max(100)]).optional(),
});
export type CompanyRulesInput = z.infer<typeof CompanyRulesInput>;

/** Looks the engine's own accounting knowledge up (typical entries, formulas, procedures, tax reference). */
export const AccountingKnowledgeInput = z.object({
  /** What is asked, in the accountant's words: "how is rent booked", "импорт ГТД проводки", "month end checklist". */
  query: z.string().trim().min(2).max(300),
  /** How many entries at most, 3 by default. */
  limit: z.number().int().min(1).max(6).optional(),
});
export type AccountingKnowledgeInput = z.infer<typeof AccountingKnowledgeInput>;

/**
 * Documents read from Didox itself (its API, no files): the period by the document's own date. Reads only.
 * The incoming ones (our INN is the buyer) go into the chat the same way attached Didox files do, so
 * propose_didox_invoices enters them; the outgoing ones (our INN is the seller) are listed to be compared with 1C.
 */
export const FetchDidoxInput = z.object({
  /** YYYY-MM-DD; absent: the start of this year. */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** YYYY-MM-DD; absent: today. */
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** "incoming" by default; "both" also reads what the company issued. */
  direction: z.enum(["incoming", "outgoing", "both"]).optional(),
  /** The most documents to read, 100 by default. */
  limit: z.number().int().min(1).max(300).optional(),
});
export type FetchDidoxInput = z.infer<typeof FetchDidoxInput>;

/**
 * The 1C document a Didox document is made from. The app reads it and refuses to go on when it is not there or
 * its number or date differ: a document is applied in 1C first, and only then goes to Didox.
 */
export const OnecSource = GetObjectInput;
export type OnecSource = z.infer<typeof OnecSource>;

/**
 * A letter or another free-form document to be made in Didox as a DRAFT (not signed, not sent): the app puts
 * the text into a PDF and takes the two companies from Didox.
 */
export const DidoxDocumentInput = z.object({
  /** For the card's title, e.g. "Xat - Zarkentrade MChJ". */
  title: z.string().trim().min(1).max(200),
  type: z.enum(["letter", "contract", "payment_invoice", "work_act", "request", "specification", "other"]),
  /** The document's own number (an outgoing number of the company) and date YYYY-MM-DD. */
  number: z.string().trim().min(1).max(80),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** The recipient's INN (9 digits) or PINFL (14). */
  buyerInn: z.string().regex(/^(\d{9}|\d{14})$/),
  /** One line: what it is about, shown above the text. */
  subject: z.string().trim().min(1).max(300),
  /** The whole text of the document, plain text, paragraphs separated by a blank line. */
  text: z.string().trim().min(1).max(30000),
  /** Who signs, for the line under the text (the director's name), when known. */
  signer: z.string().trim().max(200).optional(),
  /**
   * The saved 1C document this is made from (an act, a contract, an invoice for payment ...): required for every
   * type but "letter" and "other". Its number and date must be the ones given here.
   */
  onec: OnecSource.optional(),
  contract: z
    .object({ number: z.string().trim().min(1).max(80), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
    .optional(),
});
export type DidoxDocumentInput = z.infer<typeof DidoxDocumentInput>;

/**
 * A reconciliation act (акт сверки) made in Didox as a DRAFT from the saved act in 1C
 * (Документ.АктСверкиВзаиморасчетов): the app reads its rows, contract and period itself and works every balance
 * out; only the balance at the start of the period (not kept in the 1C act) comes from the model.
 */
export const DidoxReconciliationInput = z.object({
  /** For the card's title, e.g. "Akt sverka - Zarkentrade". */
  title: z.string().trim().min(1).max(200),
  /** The saved act in 1C. */
  onec: OnecSource,
  /** The counterparty's INN (9 digits) or PINFL (14). */
  buyerInn: z.string().regex(/^(\d{9}|\d{14})$/),
  /**
   * The balance at the start of the period, in sum, from the accounts: debit and credit of the company and of the
   * counterparty. One entry for an act with one contract; with several, one per contract number. Absent: zero.
   */
  openings: z
    .array(
      z.object({
        contract: z.string().trim().max(80).optional(),
        ownerDebit: z.number().min(0).optional(),
        ownerCredit: z.number().min(0).optional(),
        partnerDebit: z.number().min(0).optional(),
        partnerCredit: z.number().min(0).optional(),
      }),
    )
    .max(50)
    .optional(),
  /** A sentence for the act's text, when the accountant wants one. */
  text: z.string().trim().max(2000).optional(),
});
export type DidoxReconciliationInput = z.infer<typeof DidoxReconciliationInput>;

/** A draft in Didox to be deleted (a wrong one: a draft is not signed, so it was never sent). */
export const DidoxDeleteDraftInput = z.object({
  /** The draft's id in Didox, as the assistant told the accountant when it made the draft. */
  id: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
});
export type DidoxDeleteDraftInput = z.infer<typeof DidoxDeleteDraftInput>;

/**
 * An invoice to be made in Didox as a DRAFT (not signed, not sent). The model reads the invoice from 1C and
 * passes what is in it; the app takes the seller and the buyer from Didox, works the sums out itself and
 * shows them on the card.
 */
export const DidoxDraftInput = z.object({
  /** For the card's title, e.g. "Hisob-faktura 1294 - Adim MChJ". */
  title: z.string().trim().min(1).max(200),
  /** The invoice number as it stands in 1C. */
  number: z.string().trim().min(1).max(80),
  /** YYYY-MM-DD. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** The buyer's INN (9 digits) or PINFL (14). */
  buyerInn: z.string().regex(/^(\d{9}|\d{14})$/),
  contract: z
    .object({ number: z.string().trim().min(1).max(80), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
    .optional(),
  /** The posted issued invoice in 1C this is made from (Документ.СчетФактураВыданный): required. */
  onec: OnecSource.optional(),
  lines: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(500),
        /** The unit as 1C names it ("шт", "кг"). */
        unit: z.string().trim().min(1).max(40),
        qty: z.number().positive(),
        /** Price without VAT, in sum. */
        price: z.number().min(0),
        /** VAT rate in percent (12, or 0). */
        vatRate: z.number().min(0).max(100),
        /** The state catalogue code (IKPU) and name of the goods or service, when 1C has them. */
        catalogCode: z.string().trim().max(40).optional(),
        catalogName: z.string().trim().max(500).optional(),
        barcode: z.string().trim().max(60).optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type DidoxDraftInput = z.infer<typeof DidoxDraftInput>;

/**
 * Payments of a bank statement the app has read from the attached file: the app builds the
 * documents itself (a copy of the counterparty's newest payment, with this payment's date, amount,
 * number and purpose). Only what it could not settle comes back, and the model answers with
 * references and sheet rows.
 */
export const BankPaymentsInput = z.object({
  /** For the card's title, in the accountant's language, e.g. "Bank ko'chirmasi 01–15.09: 42 ta to'lov". */
  title: z.string().trim().min(1).max(200),
  /**
   * One statement by its file name; absent: EVERY attached statement in one run (the program reads them together:
   * it leaves out the accounts money only passes through, enters the bank's fees, and matches the transfers between
   * the company's own accounts).
   */
  file: z.string().min(1).max(300).optional(),
  /** The period to enter, YYYY-MM-DD inclusive: the program takes the rows of it itself; do not look for them. */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Sheet rows to take (with `file`); absent: every payment of the period. */
  rows: z.array(z.number().int().min(1)).max(5000).optional(),
  /** The organization's own bank account (a reference), when the app could not find it by number. */
  ownAccount: Ref.optional(),
  counterparties: z
    .array(z.object({ row: z.number().int().min(1), file: z.string().min(1).max(300).optional(), ref: Ref }))
    .max(2000)
    .optional(),
  /**
   * Book a card (acquiring) receipt gross and its commission as a bank-fee document of its own (the
   * default); false: enter the receipt as the statement has it, net.
   */
  splitCommission: z.boolean().optional(),
  /** A posted payment document to copy for a row, when the counterparty has no earlier payment. */
  templates: z
    .array(z.object({ row: z.number().int().min(1), file: z.string().min(1).max(300).optional(), ref: Ref }))
    .max(2000)
    .optional(),
});
export type BankPaymentsInput = z.infer<typeof BankPaymentsInput>;

/**
 * The balances worth a look after an import, read and judged by the app: cash or bank accounts in credit, transit
 * accounts that do not close, liability accounts in debit, the exchange differences. No input needed.
 */
export const LedgerCheckInput = z.object({
  /** The day to read the balances at (YYYY-MM-DD); default today. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type LedgerCheckInput = z.infer<typeof LedgerCheckInput>;

/**
 * The financial statements, worked out by the app from the ledger with no model: the financial result of a period
 * (2-shakl), the balance at a date (1-shakl) with its checks, the receivables or payables by counterparty, and the
 * stock by item and warehouse. Every line says which accounts it is made of.
 */
export const FinancialReportInput = z.object({
  report: z.enum([
    "result",
    "result_explain",
    "balance",
    "receivables",
    "payables",
    "aging_receivables",
    "aging_payables",
    "stock",
    "stock_semi",
    "stock_cost",
    "tax_accrual",
    "tax_calendar",
    "tax_registers",
    "bank_reconcile",
  ]),
  /** result: the period (default: this year to today). */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** stock_cost: the item whose issues are checked, and the company's cost method (kept for the company). */
  item: z.string().trim().min(1).max(200).optional(),
  method: z.enum(["average", "fifo"]).optional(),
  /** balance, receivables, payables, stock: the day (default today). */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type FinancialReportInput = z.infer<typeof FinancialReportInput>;

/**
 * Moving stock between warehouses or writing it off: the app checks every line against the balance (nothing may take
 * the stock below zero), builds the document from the base's own description of it and shows it on a card. Nothing is
 * written without the accountant's confirmation.
 */
export const StockMovementInput = z.object({
  kind: z.enum(["transfer", "write_off"]),
  /** The day of the document (default today). */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  from_warehouse: z.string().trim().min(1).max(200),
  /** A transfer: the warehouse it goes to. */
  to_warehouse: z.string().trim().min(1).max(200).optional(),
  /** A write-off: why (damage, shortage, own use); the accountant names it. */
  reason: z.string().trim().min(1).max(300).optional(),
  lines: z
    .array(z.object({ item: z.string().trim().min(1).max(200), qty: z.number().positive() }))
    .min(1)
    .max(200),
});
export type StockMovementInput = z.infer<typeof StockMovementInput>;

export const POSTING_OPERATIONS = [
  "purchase_goods",
  "sale_products",
  "sale_goods",
  "sale_services",
  "sale_vat",
  "payment_from_buyer",
  "payment_to_supplier",
  "bank_fee",
  "profit_tax_accrual",
  "advance_from_buyer",
  "advance_to_supplier",
  "capital_contribution",
  "cash_deposit",
  "cash_withdrawal",
  "cash_to_bank_order",
  "cash_from_bank_order",
] as const;
export type PostingOperation = (typeof POSTING_OPERATIONS)[number];

/**
 * The accounts the program uses for an operation: `list` shows the table (general rules and the company's own) and what
 * each operation resolves to; `set` records the accountant's decision for this company (it wins over the general rule
 * from then on). An account the company's chart in 1C lacks is refused.
 */
export const PostingRulesInput = z.object({
  action: z.enum(["list", "set"]),
  operation: z.enum(POSTING_OPERATIONS).optional(),
  debit: z
    .string()
    .regex(/^\d{3,10}$/)
    .optional(),
  credit: z
    .string()
    .regex(/^\d{3,10}$/)
    .optional(),
  /** The 1C document that carries the entry; the general rule's one when absent. */
  document: z.string().trim().min(1).max(100).optional(),
  currency: z.string().trim().min(1).max(10).optional(),
});
export type PostingRulesInput = z.infer<typeof PostingRulesInput>;

/** What a bank statement line can be (see apps/desktop/src/main/bank/classify.ts). */
export const BANK_LINE_TYPES = [
  "bank_fee",
  "conversion",
  "own_transfer",
  "tax",
  "customs",
  "individual_card",
  "swift",
  "terminal_receipt",
  "contract_payment",
  "cash_deposit",
  "cash_withdrawal",
  "charter_capital",
  "unknown",
] as const;
export type BankLineType = (typeof BANK_LINE_TYPES)[number];

/**
 * The table that says what a line is by the first five digits of the counterparty's account (and, for a bank fee, the
 * account it is booked to). `list` shows it with what the accountant has confirmed; `confirm` records the table as it stands
 * (once, for all its rows, or for the prefixes named); `set` changes or adds one row and confirms it. A confirmed row is
 * applied from then on and never asked again.
 */
export const BankMappingInput = z.object({
  action: z.enum(["list", "set", "confirm"]),
  /** The first five digits of the counterparty's account. */
  prefix: z
    .string()
    .regex(/^\d{5}$/)
    .optional(),
  type: z.enum(BANK_LINE_TYPES).optional(),
  /**
   * With `set`: the row is the rule for this prefix's payments whose text names no tax (type contract_payment books them as a
   * payment to the Treasury under its contract, e.g. customs prepayments), the named taxes stay taxes.
   */
  untaxed: z.boolean().optional(),
  /** The ledger account the entry goes to (for a fee: the expense account). */
  account: z
    .string()
    .regex(/^\d{3,10}$/)
    .optional(),
  /** For confirm: only these prefixes; absent: the whole table. */
  prefixes: z
    .array(z.string().regex(/^\d{5}$/))
    .max(50)
    .optional(),
});
export type BankMappingInput = z.infer<typeof BankMappingInput>;

/**
 * What the month-end revaluation of currency balances has to produce, worked out by the app: for each month's end in
 * the period, the currency accounts and currency settlement accounts at the Central Bank's rate of that day against
 * what 1C carries. 1C's own «Закрытие месяца → Переоценка валютных средств» does the revaluation; this says what it
 * must give, and after it has run, whether it did (no differences left).
 */
export const RevaluationCheckInput = z.object({
  /** YYYY-MM-DD; the months from the one holding `from` to the one holding `to`, at most 36. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type RevaluationCheckInput = z.infer<typeof RevaluationCheckInput>;

/**
 * The Central Bank's exchange rates written to 1C's rate register (the one thing no change can reach), on one card.
 * The app reads the rates itself and writes only the days 1C has none for; with no currencies and no period it takes
 * the foreign-currency accounts of the attached statements and their period.
 */
export const CurrencyRatesToolInput = z.object({
  /** For the card's title, in the accountant's language, e.g. "Valyuta kurslari 2024: USD, RUB". */
  title: z.string().trim().min(1).max(200),
  /** Letter codes: "USD", "RUB", "EUR". */
  currencies: z
    .array(z.string().regex(/^[A-Z]{3}$/))
    .min(1)
    .max(4)
    .optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type CurrencyRatesToolInput = z.infer<typeof CurrencyRatesToolInput>;

/**
 * Posts the documents this chat has created and left unposted (a bank statement's payments, a batch of
 * documents): the app knows which they are, so the model sends nothing but a title.
 */
export const PostCreatedInput = z.object({
  /** For the card's title, in the accountant's language, e.g. "Bank ko'chirmasi: 15 ta hujjatni o'tkazish". */
  title: z.string().trim().min(1).max(200),
  /** Only documents of these kinds (full names, e.g. Документ.СписаниеСРасчетногоСчета); absent: all. */
  objects: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
});
export type PostCreatedInput = z.infer<typeof PostCreatedInput>;

/**
 * Takes back what the program wrote from bank statements: each document it entered (and the other leg of a conversion, which
 * is never left alone) is unposted and marked for deletion, the later one before the earlier, on one card. 1C keeps it
 * (the mark can be lifted); the statement's lines become enterable again. `last` is the newest card's documents, `all` every
 * bank document the program wrote and nobody took back, `conversion` one conversion by its id.
 */
export const UndoBankInput = z.object({
  title: z.string().trim().min(1).max(200),
  scope: z.enum(["last", "all", "conversion"]).optional(),
  conversionId: z.string().trim().min(1).max(200).optional(),
  /** Only the documents made from this statement file. */
  file: z.string().trim().min(1).max(300).optional(),
});
export type UndoBankInput = z.infer<typeof UndoBankInput>;

/**
 * Takes back the bank documents 1C has more than once. The attached statements are the truth: a bank account, a day, an
 * amount and a direction that a statement lists n times are n documents; the extra ones (the later copy, whatever the kind of
 * document) are shown and marked for deletion on ONE card. Documents no row of the statements stands behind are only reported.
 */
export const BankDuplicatesInput = z.object({
  title: z.string().trim().min(1).max(200),
  /** YYYY-MM-DD; the period of the statements by default. */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type BankDuplicatesInput = z.infer<typeof BankDuplicatesInput>;

/** One problem an audit check found. */
export const AuditFinding = z.object({
  severity: z.enum(["high", "medium", "low"]),
  title: z.string().trim().min(1).max(300),
  detail: z.string().max(2000).default(""),
  /** The money involved, in UZS, when there is an amount. */
  amount: z.number().optional(),
  date: z.string().max(40).optional(),
  counterparty: z.string().max(300).optional(),
  /** The document or item as 1C shows it, e.g. "Реализация 0000-000123 от 05.09.2026". */
  document: z.string().max(300).optional(),
});
export type AuditFinding = z.infer<typeof AuditFinding>;

/** The result of one audit check: the model's last call in it. */
export const ReportFindingsInput = z.object({
  status: z.enum(["ok", "issues", "not_applicable"]),
  /** One or two sentences: what was checked and what was found. */
  summary: z.string().trim().min(1).max(1000),
  /** One per problem, most important first; empty when the status is ok. */
  findings: z.array(AuditFinding).max(300).default([]),
});
export type ReportFindingsInput = z.infer<typeof ReportFindingsInput>;

/**
 * Tools the assistant may call; the desktop runs them through PlatformAPI. The read tools run at
 * once. The propose_* tools never write: the desktop shows the document to the user, and only the
 * user's click creates it in 1C (unposted). The tool result says what the user decided.
 */
export const AI_TOOLS = {
  list_organizations: z.object({}),
  describe_objects: z.object({
    /** Full 1C names, e.g. "Документ.СчетФактураПолученный", "РегистрБухгалтерии.Хозрасчетный". */
    objects: z.array(z.string().min(1)).min(1).max(20),
  }),
  run_query: RunQueryInput,
  get_object: GetObjectInput,
  read_attachment: ReadAttachmentInput,
  fetch_didox_documents: FetchDidoxInput,
  learn_accounting_policy: z.object({}),
  ledger_check: LedgerCheckInput,
  financial_report: FinancialReportInput,
  stock_movement: StockMovementInput,
  posting_rules: PostingRulesInput,
  bank_mapping: BankMappingInput,
  revaluation_check: RevaluationCheckInput,
  accounting_calc: AccountingCalcTool,
  company_rules: CompanyRulesInput,
  accounting_knowledge: AccountingKnowledgeInput,
  check_changes: CheckChangesInput,
  propose_change: ChangeInput,
  propose_changes: ChangeBatchInput,
  propose_invoice_issued: z.object({ sale: SaleLookup }),
  propose_invoices_issued: InvoicesIssuedInput,
  propose_invoice_received: InvoiceReceivedDraft,
  propose_invoices_received: InvoicesReceivedInput,
  propose_didox_invoices: DidoxInvoicesInput,
  propose_didox_sales: DidoxSalesInput,
  propose_didox_draft: DidoxDraftInput,
  propose_didox_document: DidoxDocumentInput,
  propose_didox_reconciliation: DidoxReconciliationInput,
  propose_didox_delete_draft: DidoxDeleteDraftInput,
  propose_bank_payments: BankPaymentsInput,
  propose_undo_bank: UndoBankInput,
  propose_bank_duplicates: BankDuplicatesInput,
  propose_currency_rates: CurrencyRatesToolInput,
  propose_post_created: PostCreatedInput,
  propose_delete_marked: DeleteMarkedInput,
  report_findings: ReportFindingsInput,
} as const;
export type AiToolName = keyof typeof AI_TOOLS;

export const AI_PROPOSAL_TOOLS = [
  "propose_change",
  "propose_changes",
  "propose_invoice_issued",
  "propose_invoices_issued",
  "propose_invoice_received",
  "propose_invoices_received",
  "propose_didox_invoices",
  "propose_didox_sales",
  "propose_didox_draft",
  "propose_didox_document",
  "propose_didox_reconciliation",
  "propose_didox_delete_draft",
  "propose_bank_payments",
  "propose_undo_bank",
  "propose_bank_duplicates",
  "propose_currency_rates",
  "propose_post_created",
  "propose_delete_marked",
] as const;
export type AiProposalTool = (typeof AI_PROPOSAL_TOOLS)[number];
/** Tools the app runs itself (over attached files, or several 1C calls), not one 1C function. */
export const AI_LOCAL_TOOLS = [
  "read_attachment",
  "fetch_didox_documents",
  "learn_accounting_policy",
  "ledger_check",
  "financial_report",
  "stock_movement",
  "posting_rules",
  "bank_mapping",
  "revaluation_check",
  "accounting_calc",
  "company_rules",
  "accounting_knowledge",
  "report_findings",
  "check_changes",
] as const;
export type AiLocalTool = (typeof AI_LOCAL_TOOLS)[number];
/** Tools that read 1C. */
export type AiReadTool = Exclude<AiToolName, AiProposalTool | AiLocalTool>;

export function isProposalTool(name: AiToolName): name is AiProposalTool {
  return (AI_PROPOSAL_TOOLS as readonly string[]).includes(name);
}

/** The tools of a chat with the accountant. */
export const CHAT_TOOLS: AiToolName[] = (Object.keys(AI_TOOLS) as AiToolName[]).filter(
  (name) => name !== "report_findings",
);
/** The tools of one audit check: it reads 1C and reports what it found. */
export const AUDIT_TOOLS: AiToolName[] = [
  "list_organizations",
  "describe_objects",
  "run_query",
  "get_object",
  "report_findings",
];

export function isAiToolName(name: string): name is AiToolName {
  return Object.hasOwn(AI_TOOLS, name);
}

/** A content block as the Claude API returns it. Passed back unchanged: thinking blocks must be. */
export const AiContentBlock = z.looseObject({ type: z.string() });
export type AiContentBlock = z.infer<typeof AiContentBlock>;

export const AiMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string().min(1), z.array(AiContentBlock).min(1)]),
});
export type AiMessage = z.infer<typeof AiMessage>;

/** Tools of the first app versions, which do not say which tools they have. */
export const LEGACY_AI_TOOLS = ["list_organizations", "describe_objects", "run_query"] as const;

/**
 * Sent as a user message when a turn reached the output limit with an unfinished answer. The proxy
 * recognizes it, so a continuation is not counted as a new question.
 */
export const CONTINUE_NOTE =
  "Your answer reached the output limit and was cut off. Continue exactly where it stopped, without " +
  "repeating what you already wrote.";

export const AiChatInput = z.object({
  /** The company the questions are about (its 1C organization name). */
  company: z.string().trim().min(1).max(200),
  /**
   * Tools this app version can run. The proxy offers the model only these, so an older app is
   * never asked to run a tool it does not have. Absent: LEGACY_AI_TOOLS.
   */
  tools: z.array(z.string().max(64)).max(50).optional(),
  /**
   * What the question is, as the app judged it: "lookup" (a simple read that may run on the cheaper
   * model, when the policy has one), else "work". Absent: "work".
   */
  task: z.enum(["lookup", "work"]).optional(),
  /**
   * "import": the question came with files to enter into 1C (documents read from archives, photos,
   * spreadsheets): mostly careful transcription, so the proxy may think less (AI_IMPORT_EFFORT).
   */
  kind: z.enum(["import"]).optional(),
  /** The app asks for the default model for this step (e.g. the user rejected the last answer). */
  escalate: z.boolean().optional(),
  /**
   * How this company works, learned by the app from its own 1C (bank accounts and what each is for, the documents it
   * posts, the accounts its postings use, the currencies of its contracts, the accounting policy): read before every
   * question, so the model follows the company's practice. Absent: nothing was learned.
   */
  policy: z.string().max(12_000).optional(),
  messages: z.array(AiMessage).min(1).max(20_000),
});
export type AiChatInput = z.infer<typeof AiChatInput>;

export const AiToolUse = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
export type AiToolUse = z.infer<typeof AiToolUse>;

/** POST /v1/ai/chat answers with one JSON event per line. */
export const AiEvent = z.discriminatedUnion("type", [
  /** A piece of the answer text, as it is generated. */
  z.object({ type: z.literal("text"), text: z.string() }),
  /** A piece of the model's progress note between tool calls ("checking September's payments…"). */
  z.object({ type: z.literal("progress"), text: z.string() }),
  /** Sent every few seconds while the model works, so a quiet connection is not taken for a dead one. */
  z.object({ type: z.literal("ping") }),
  /** The finished turn: append `content` to the conversation as the assistant message. */
  z.object({
    type: z.literal("message"),
    content: z.array(AiContentBlock),
    stopReason: z.string().nullable(),
  }),
  /** The account is close to a spend cap (AI_BUDGET_WARNING); the answer goes on. */
  z.object({ type: z.literal("warning"), code: z.string(), message: z.string() }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type AiEvent = z.infer<typeof AiEvent>;
