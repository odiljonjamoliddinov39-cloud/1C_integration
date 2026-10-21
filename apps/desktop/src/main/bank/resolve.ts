/**
 * Bank payments turned into 1C documents with no AI. The program finds the organization's own bank
 * account and each counterparty (by INN), then writes every payment the way this company already
 * writes that counterparty's payments: the newest posted payment document of the same kind and the
 * same counterparty is copied, and only the date, the amount, the bank document's number and the
 * payment purpose change. So the contract, the settlement accounts, the cash flow item and the
 * payment breakdown are the company's own, not a guess.
 *
 * What cannot be settled this way (no INN, no counterparty in 1C, no earlier payment to copy, a
 * foreign-currency contract) goes to the model as a short list, grouped by counterparty.
 */
import type { ChangeInput, RunQueryInput } from "@platform/shared";

import { type QueryOutcome, type ResolverDeps, lookup, refOf, textOf } from "../didox/resolve.js";
import { isAcquiringFee, parseAcquiring } from "./acquiring.js";
import { currencyFromText } from "./policy.js";
import { type TaxKind, taxKindOf, taxNameIs, taxPeriodFor } from "./tax.js";
import { BLOCKING, type BankPayment, type BankStatement } from "./statement.js";

export interface BankDeps extends ResolverDeps {
  getObject(object: string, ref: string): Promise<QueryOutcome>;
}

export interface BankCandidate {
  ref: string;
  name: string;
}

export interface BankProblem {
  /** The sheet rows it concerns. */
  rows: number[];
  code:
    | "CHECK"
    | "NO_INN"
    | "COUNTERPARTY_NOT_FOUND"
    | "COUNTERPARTY_AMBIGUOUS"
    | "NO_TEMPLATE"
    | "BAD_TEMPLATE"
    | "TAX_PAYMENT"
    | "NEW_COUNTERPARTY";
  message: string;
  /** Who it is about: the name and INN as the statement writes them. */
  counterparty?: string;
  candidates?: BankCandidate[];
}

/** Something the program decided for itself that the accountant should know, e.g. a contract it could not find. */
export interface BankNote {
  rows: number[];
  message: string;
}

/** What the model decided for what the program could not: references only. */
export interface BankOverrides {
  ownAccount?: string;
  counterparties?: { row: number; ref: string }[];
  /** A posted payment document to copy for a row: used when the counterparty has no earlier payment. */
  templates?: { row: number; ref: string }[];
}

/** A counterparty the statement names (with INN and name) that 1C does not have: the tool offers to create it. */
export interface MissingCounterparty {
  inn: string;
  name: string;
  rows: number[];
  /** How this counterparty is known in this run (see `whoOf`): what `fresh` holds once it is created. */
  key: string;
}

/** A contract of a counterparty created a moment ago, named in the purposes, that 1C does not have yet. */
export interface PendingContract {
  rows: number[];
  label: string;
  change: ChangeInput;
}

export interface BankResolved {
  /** Counterparties to create first; their payments wait for the next round. */
  missing: MissingCounterparty[];
  /** Contracts to create for counterparties created in this run; their payments wait for the next round. */
  contractsToCreate: PendingContract[];
  /** `part: "commission"`: the bank's commission of an acquiring receipt, a document of its own. */
  ready: { payment: BankPayment; change: ChangeInput; part?: "commission" }[];
  /** Payments already in 1C (same date, counterparty and amount): left out. */
  alreadyIn1c: number[];
  problems: BankProblem[];
  notes: BankNote[];
}

export interface BankCache {
  /** Posted documents of a kind, newest first: "object|INN" (or "object|*" for all) → ref and purpose. */
  lists: Map<string, { ref: string; purpose: string }[]>;
  snapshots: Map<string, Template | null>;
  /** The company's posted tax payments (newest first), read once; null when 1C could not say. */
  tax?: TaxHistory[] | null;
  /** The exchange rates read from 1C: "USD|2026-09-10" → soums per unit, null when 1C has none. */
  rates?: Map<string, number | null>;
  /** The currency items of 1C's catalog: "USD" → its ref, null when the catalog has none. */
  currencyRefs?: Map<string, string | null>;
}

export interface TaxHistory {
  ref: string;
  date: string;
  /** The tax period the document was made for ("YYYY-MM-DDT00:00:00"), "" when it has none. */
  period: string;
  tax: string;
  purpose: string;
}

export interface Template {
  object: string;
  ref: string;
  fields: Record<string, unknown>;
  tables: Record<string, Record<string, unknown>[]>;
}

export const OBJECT = {
  in: "Документ.ПоступлениеНаРасчетныйСчет",
  out: "Документ.СписаниеСРасчетногоСчета",
} as const;

/** The number of the contract made for a new counterparty when the purpose names none ("without a number"). */
const NEUTRAL_NUMBER = "б/н";

const nameKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** What the bank writes in a payment for its own fees: not a counterparty to look up or create by name. */
const BANK_FEE = /комисси|commission|komissiya/i;

/** How a payment's counterparty is looked up in 1C: by INN, or by name when the bank wrote no INN (zeros). */
export interface Who {
  key: string;
  field: "ИНН" | "Наименование";
  value: string;
}

export function whoOf(p: BankPayment): Who | null {
  // An acquiring receipt is the terminal's, not a customer's: whatever the statement writes as its payer.
  if (p.direction === "in" && parseAcquiring(p.purpose, p.amount)) return null;
  if (p.inn) return { key: p.inn, field: "ИНН", value: p.inn };
  const name = p.counterparty.trim();
  if (p.innZero !== true || name === "" || BANK_FEE.test(p.purpose)) return null;
  return { key: `name:${nameKey(name)}`, field: "Наименование", value: name };
}

/** Rows of a query on the owner of something (contract, bank account), asked by INN and by name; the key is first. */
async function lookupByWho(
  deps: BankDeps,
  payments: BankPayment[],
  text: (owner: string, placeholders: string) => string,
): Promise<{ key: string; cells: unknown[] }[]> {
  const found: { key: string; cells: unknown[] }[] = [];
  for (const field of ["ИНН", "Наименование"] as const) {
    const values = [
      ...new Set(payments.flatMap((p) => (whoOf(p)?.field === field ? [whoOf(p)?.value ?? ""] : []))),
    ];
    if (values.length === 0) continue;
    const rows = await lookup(deps, (ph) => text(`Т.Владелец.${field}`, ph), values);
    for (const { cells } of rows ?? []) {
      const first = String(cells[0] ?? "");
      found.push({ key: field === "ИНН" ? first : `name:${nameKey(first)}`, cells });
    }
  }
  return found;
}

/** Attributes the program rewrites in the copied document, by the names 1C configurations use. */
const FIELD_NAMES = {
  amount: ["СуммаДокумента"],
  purpose: ["НазначениеПлатежа", "Назначение"],
  number: ["НомерВходящегоДокумента", "НомерПлатежногоДокумента", "НомерВходящего", "НомерДокументаБанка"],
  incomingDate: ["ДатаВходящегоДокумента", "ДатаПлатежногоДокумента", "ДатаВходящего"],
  bankAccount: ["БанковскийСчет"],
  counterpartyAccount: ["СчетКонтрагента"],
  counterparty: ["Контрагент"],
  contract: ["ДоговорКонтрагента"],
  date: ["Дата", "Date"],
};

/** Standard attributes a copy must not carry over: 1C makes them itself. */
const NOT_COPIED = new Set([
  "Number",
  "Номер",
  "Posted",
  "Проведен",
  "DeletionMark",
  "ПометкаУдаления",
  "Date",
  "Дата",
]);

/** Columns of the payment breakdown that hold money and scale with the payment's amount. */
const MONEY_COLUMNS = ["СуммаПлатежа", "СуммаВзаиморасчетов", "СуммаНДС", "Сумма"];

const round2 = (n: number) => Math.round(n * 100) / 100;
const first = (keys: string[], have: Record<string, unknown>) => keys.find((k) => k in have);

/**
 * A reference as GetObject writes it, back into what a change accepts: {type, ref, name}. A reference
 * keeps its type (a field that allows several types asks for it); an enumeration is written by the
 * value's NAME, which GetObject gives as `ref` (its `name` is the presentation, "Оплата покупателя",
 * which 1C does not know as a value).
 */
export function writable(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as { type?: unknown; ref?: unknown };
    if (typeof v.ref === "string" && typeof v.type === "string") {
      return v.type.startsWith("Перечисление") ? v.ref : { type: v.type, ref: v.ref };
    }
  }
  return value;
}

/** A reference to put in a field: with the type the earlier document had there, else the usual one. */
export function refTo(existing: unknown, ref: string, fallbackType: string): { type: string; ref: string } {
  const type =
    existing && typeof existing === "object" && typeof (existing as { type?: unknown }).type === "string"
      ? (existing as { type: string }).type
      : fallbackType;
  return { type, ref };
}

const parsePositive = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : Number.NaN);

/** The rate a document row carries: 0 is a rate that was never filled in, which is how a soum payment can be left. */
const rateOfRow = (row: Record<string, unknown>) => {
  const rate = parsePositive(row["КурсВзаиморасчетов"] ?? row["Курс"] ?? 1);
  return rate === 0 ? 1 : rate;
};

/** The numeric and the letter code a currency has in 1C's catalog (it keeps one or the other). */
const CURRENCY_CODES: Record<string, string[]> = {
  USD: ["840", "USD"],
  EUR: ["978", "EUR"],
  RUB: ["643", "RUB"],
  GBP: ["826", "GBP"],
};

/** Soums per unit of a currency on a day, from 1C's exchange rates; null when 1C has none for it. */
async function rateOn(
  deps: BankDeps,
  cache: BankCache,
  currency: string,
  date: string,
): Promise<number | null> {
  cache.rates ??= new Map();
  const key = `${currency}|${date}`;
  if (cache.rates.has(key)) return cache.rates.get(key) ?? null;
  let rate: number | null = null;
  for (const code of CURRENCY_CODES[currency] ?? [currency]) {
    const outcome = await deps.query({
      query:
        "ВЫБРАТЬ ПЕРВЫЕ 1 Т.Курс КАК Курс, Т.Кратность КАК Кратность ИЗ РегистрСведений.КурсыВалют.СрезПоследних(&Дата, Валюта.Код = &Код) КАК Т",
      params: { Дата: `${date}T23:59:59`, Код: code },
      limit: 1,
    });
    if (!outcome.ok) continue;
    const row = (outcome.data as { rows?: unknown[][] }).rows?.[0];
    const value = Number(row?.[0]);
    const multiplicity = Number(row?.[1] ?? 1) || 1;
    if (Number.isFinite(value) && value > 0) {
      rate = Math.round((value / multiplicity) * 1e6) / 1e6;
      break;
    }
  }
  cache.rates.set(key, rate);
  return rate;
}

/** The currency an earlier document is in, in letters: its currency attribute, else "unknown" when a rate row says it is foreign. */
function templateCurrency(template: Template): string | null {
  const own = textOf(template.fields["ВалютаДокумента"]);
  const named = own ? currencyFromText(own) : "";
  if (named) return named;
  for (const rows of Object.values(template.tables))
    for (const row of rows) {
      const rate = rateOfRow(row);
      if (rate !== 1 && Number.isFinite(rate)) return "foreign";
    }
  return null;
}

/** Can this earlier document be copied for a payment on an account in this currency? */
function sameCurrency(template: Template, currency: string): boolean {
  const have = templateCurrency(template);
  if (currency === "UZS" || currency === "") return have === null || have === "UZS";
  return have === currency || (have === "foreign" && currency !== "UZS");
}

const refIn = (value: unknown): string | null => refOf(value);

/**
 * What kind of payment a purpose is, by its words: digits and punctuation are dropped, so
 * "00634SmartVista - Выручка … 483,610.84 сум" and the same text with other figures are one kind.
 */
export const shapeOf = (purpose: string) =>
  purpose
    .toLowerCase()
    .replace(/[\d\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30);

/** The contract a payment purpose names ("Договор 4/28 от 01.01.2026г", "по дог. № 17 от 08.01.2026"). */
export function contractMention(purpose: string): { number: string; date: string } | null {
  const found =
    /(?:догов\p{L}*|дог\.?|dog\p{L}*|шартном\p{L}*|shartnom\p{L}*)(?:\s*номер\p{L}*)?\s*(?:№|N\b|no\b)?\.?\s*([\p{L}\d][\p{L}\d\-/.]*?)\s*(?:от|dan|ot)?\s*(\d{2})\.(\d{2})\.(\d{4})/iu.exec(
      purpose,
    );
  if (!found) return null;
  return { number: found[1] ?? "", date: `${found[4]}-${found[3]}-${found[2]}` };
}

const normalNumber = (n: string) =>
  n
    .toLowerCase()
    .replace(/[\s№#]/g, "")
    .replace(/^0+/, "");

/**
 * A payment to the budget: the treasury or the tax office as the receiver, or a tax named in the purpose.
 * It is not a supplier payment. Copying the counterparty's last payment would repeat however the company
 * entered the earlier ones, and those are often «Оплата поставщику» on 4220, not «Уплата налога».
 */
export function isTaxPayment(payment: BankPayment): boolean {
  if (payment.direction !== "out") return false;
  const who =
    /(?<!\p{L})(гнк|гни|дск|dsq|gnk)(?!\p{L})|moliya\s+vazirligi|iqtisodiyot|g['‘’ʻ`]aznachilik|казначейств|давлат\s+солиқ|davlat\s+soliq|налогов|soliq\s+qo['‘’ʻ`]mitasi|министерств\p{L}*\s+(экономики|финансов)/iu;
  const what =
    /(?<!\p{L})(солиқ\p{L}*|soliq\p{L}*|налог\p{L}*|инпс|inps|ндфл|жшдс|jshds|ндс|qqs|акциз\p{L}*|aksiz\p{L}*)(?!\p{L})/iu;
  return who.test(payment.counterparty) || what.test(payment.purpose);
}

export interface CopyContext {
  /** The counterparty this payment is with, when known. */
  counterparty?: string | null;
  contract?: string | null;
  ownAccount?: string | null;
  counterpartyAccount?: string | null;
  /** Fields set last, when the earlier document has them (the tax period of a tax payment). */
  set?: Record<string, unknown>;
  /** The payment is in a foreign currency: its rate (soums per unit) on the payment's day, when 1C has it. */
  foreign?: {
    currency: string;
    rate: number | null;
    /**
     * The only earlier payment is in soums: the document is made from it in the currency (the currency item, and how
     * the contract is settled: in the same currency or in soums at the rate).
     */
    convert?: { currencyRef: string; settledIn: "same" | "soums" };
  };
}

/** The copied document with this payment's own date, amount, number and purpose, or why it cannot be made. */
export function copyTemplate(
  template: Template,
  payment: BankPayment,
  context: CopyContext | string | null = {},
): { ok: true; change: ChangeInput; notes?: string[] } | { ok: false; message: string } {
  const notes: string[] = [];
  const ctx: CopyContext = typeof context === "string" ? { ownAccount: context } : (context ?? {});
  const amountKey = first(FIELD_NAMES.amount, template.fields);
  if (!amountKey) return { ok: false, message: `${template.object} has no ${FIELD_NAMES.amount[0]} to set` };
  const oldTotal = parsePositive(template.fields[amountKey]);
  if (!(oldTotal > 0)) return { ok: false, message: "the earlier payment has no amount to copy from" };
  const amount = payment.amount / 100;

  const counterpartyKey = first(FIELD_NAMES.counterparty, template.fields);
  const templateCounterparty = counterpartyKey ? refIn(template.fields[counterpartyKey]) : null;
  const otherCounterparty = Boolean(
    ctx.counterparty && templateCounterparty && ctx.counterparty !== templateCounterparty,
  );
  if (otherCounterparty && !ctx.contract) {
    return {
      ok: false,
      message:
        "the document to copy is another counterparty's and the payment purpose names no contract of this one that 1C has",
    };
  }

  const theirAccountKey = first(FIELD_NAMES.counterpartyAccount, template.fields);
  const fields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(template.fields)) {
    // Another counterparty's bank account is worse than an empty one.
    if (NOT_COPIED.has(name) || (otherCounterparty && name === theirAccountKey)) continue;
    fields[name] = writable(value);
  }
  fields[amountKey] = amount;
  if (ctx.foreign?.convert) {
    if (!("ВалютаДокумента" in template.fields)) {
      return { ok: false, message: "the earlier payment has no document currency to set" };
    }
    fields["ВалютаДокумента"] = refTo(
      template.fields["ВалютаДокумента"],
      ctx.foreign.convert.currencyRef,
      "Справочник.Валюты",
    );
    if (ctx.foreign.rate === null) {
      return {
        ok: false,
        message: `the exchange rate of ${ctx.foreign.currency} on ${payment.date} was not found in 1C: a document in soums cannot be made into one in ${ctx.foreign.currency} without it`,
      };
    }
  }
  const purposeKey = first(FIELD_NAMES.purpose, template.fields);
  if (purposeKey && payment.purpose) fields[purposeKey] = payment.purpose;
  const numberKey = first(FIELD_NAMES.number, template.fields);
  if (numberKey && payment.number) fields[numberKey] = payment.number;
  const incomingKey = first(FIELD_NAMES.incomingDate, template.fields);
  if (incomingKey) fields[incomingKey] = payment.date;
  const accountKey = first(FIELD_NAMES.bankAccount, template.fields);
  if (accountKey && ctx.ownAccount)
    fields[accountKey] = refTo(template.fields[accountKey], ctx.ownAccount, "Справочник.БанковскиеСчета");
  if (counterpartyKey && ctx.counterparty)
    fields[counterpartyKey] = refTo(
      template.fields[counterpartyKey],
      ctx.counterparty,
      "Справочник.Контрагенты",
    );
  if (theirAccountKey && ctx.counterpartyAccount)
    fields[theirAccountKey] = refTo(
      template.fields[theirAccountKey],
      ctx.counterpartyAccount,
      "Справочник.БанковскиеСчета",
    );
  const contractKey = first(FIELD_NAMES.contract, template.fields);
  if (contractKey && ctx.contract)
    fields[contractKey] = refTo(
      template.fields[contractKey],
      ctx.contract,
      "Справочник.ДоговорыКонтрагентов",
    );
  // The date is the standard attribute: its name is the one the earlier document was read with.
  fields[first(FIELD_NAMES.date, template.fields) ?? "Дата"] = payment.date;
  for (const [name, value] of Object.entries(ctx.set ?? {}))
    if (name in template.fields) fields[name] = value;
  // A document in a currency carries the rate of its day.
  if (ctx.foreign?.rate)
    for (const name of ["КурсДокумента", "КурсВалюты"])
      if (name in template.fields) fields[name] = ctx.foreign.rate;

  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const [name, rows] of Object.entries(template.tables)) {
    if (rows.length === 0) continue;
    const moneyRows = rows.filter((row) => MONEY_COLUMNS.some((c) => c in row));
    if (moneyRows.length === 0) {
      tables[name] = rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([k, v]) => [k, writable(v)])),
      );
      continue;
    }
    // One row per contract: a payment that was split over several contracts cannot be copied for a new amount.
    if (rows.length !== 1) {
      return {
        ok: false,
        message: `the earlier payment's ${name} has ${rows.length} rows (split over contracts)`,
      };
    }
    const row = rows[0] ?? {};
    const rate = rateOfRow(row);
    if (rate !== 1 && !ctx.foreign) {
      return {
        ok: false,
        message: `the earlier payment is in a foreign currency (rate ${rate}): enter it by hand`,
      };
    }
    if (rate === 1 && ctx.foreign && !ctx.foreign.convert) {
      return {
        ok: false,
        message: `the earlier payment is in soums, the account is in ${ctx.foreign.currency}: its payment to copy must be in ${ctx.foreign.currency}`,
      };
    }
    const rowTotal = parsePositive(row["СуммаПлатежа"] ?? row["Сумма"]);
    if (!(rowTotal > 0) || Math.abs(rowTotal - oldTotal) > 0.005) {
      return { ok: false, message: `the earlier payment's ${name} does not add up to its amount` };
    }
    // Settled in soums (the settlement amount is the payment at the rate) or in the payment's own currency.
    const settlement = parsePositive(row["СуммаВзаиморасчетов"]);
    const inSoums = ctx.foreign && settlement > 0 && Math.abs(settlement - rowTotal) > rowTotal * 0.01;
    const newRate = ctx.foreign?.rate ?? null;
    const multiplicity = parsePositive(row["КратностьВзаиморасчетов"] ?? row["Кратность"] ?? 1) || 1;
    const convert = ctx.foreign?.convert;
    const scaled: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(row)) {
      if (convert && column === "СуммаВзаиморасчетов" && typeof value === "number") {
        scaled[column] =
          convert.settledIn === "soums" ? round2((amount * (newRate ?? 1)) / multiplicity) : amount;
      } else if (convert && (column === "КурсВзаиморасчетов" || column === "Курс")) {
        scaled[column] = convert.settledIn === "soums" ? newRate : 1;
      } else if (
        column === "СуммаВзаиморасчетов" &&
        inSoums &&
        newRate !== null &&
        typeof value === "number"
      ) {
        scaled[column] = round2((amount * newRate) / multiplicity);
      } else if (MONEY_COLUMNS.includes(column) && typeof value === "number") {
        scaled[column] = round2((value * amount) / oldTotal);
      } else if (ctx.foreign && newRate !== null && (column === "КурсВзаиморасчетов" || column === "Курс")) {
        scaled[column] = newRate;
      } else scaled[column] = writable(value);
    }
    if (convert) {
      notes.push(
        `${ctx.foreign?.currency} payment made from the counterparty's payment in soums (no earlier one in ${ctx.foreign?.currency}): the currency, the rate ${newRate} of ${payment.date} and the settlement (${convert.settledIn === "soums" ? "in soums at the rate" : `in ${ctx.foreign?.currency}`}) are the program's; check them on the first document`,
      );
    } else if (ctx.foreign) {
      notes.push(
        newRate === null
          ? `the exchange rate of ${ctx.foreign.currency} on ${payment.date} was not found in 1C: the earlier payment's rate (${rate}) is kept; check it`
          : `${ctx.foreign.currency} payment at the rate ${newRate} of ${payment.date}${inSoums ? " (settled in soums)" : ""}; check the rate and the settlement amounts`,
      );
    }
    if (ctx.contract && "ДоговорКонтрагента" in row)
      scaled["ДоговорКонтрагента"] = refTo(
        row["ДоговорКонтрагента"],
        ctx.contract,
        "Справочник.ДоговорыКонтрагентов",
      );
    tables[name] = [scaled];
  }
  return {
    ok: true,
    change: {
      action: "create",
      object: template.object,
      fields,
      ...(Object.keys(tables).length > 0 ? { tables } : {}),
      post: false,
    },
    ...(notes.length > 0 ? { notes } : {}),
  };
}

const day = (date: string) => date.slice(0, 10);

/** Only exact matches are "already in 1C": the same day, counterparty and amount. */
const sameKey = (date: string, counterparty: string, amount: number) =>
  `${day(date)}|${counterparty}|${Math.round(amount * 100)}`;

const label = (p: BankPayment) =>
  p.inn
    ? `${p.counterparty} (INN ${p.inn})`
    : p.innZero
      ? `${p.counterparty || "(no name)"} (the statement gives no INN)`
      : p.counterparty || "(no name)";

export async function resolvePayments(
  statement: BankStatement,
  options: {
    companyInn?: string;
    overrides?: BankOverrides;
    cache?: BankCache;
    only?: number[];
    /** Offer to create counterparties the statement names (INN and name) and 1C lacks. */
    createMissing?: boolean;
    /** INNs of counterparties created earlier in this run: they have no earlier payment to copy. */
    fresh?: Set<string>;
    /** Book an acquiring receipt gross and its commission as a document of its own (default: yes). */
    splitCommission?: boolean;
    /** The currency of the statement's account in letters ("" or "UZS": soums). */
    currency?: string;
  },
  deps: BankDeps,
): Promise<BankResolved> {
  const overrides = options.overrides ?? {};
  const cache = options.cache ?? { lists: new Map(), snapshots: new Map() };
  const currency = options.currency ?? "";
  const foreignAccount = currency !== "" && currency !== "UZS";
  const problems: BankProblem[] = [];
  const notes: BankNote[] = [];
  const alreadyIn1c: number[] = [];
  const wanted = options.only ? new Set(options.only) : null;
  let payments = statement.payments.filter((p) => !wanted || wanted.has(p.row));
  const missingByKey = new Map<string, MissingCounterparty>();
  const pendingContracts = new Map<string, PendingContract>();
  const nothing = (): BankResolved => ({
    missing: [...missingByKey.values()],
    contractsToCreate: [...pendingContracts.values()],
    ready: [],
    alreadyIn1c,
    problems,
    notes,
  });

  const grouped = new Map<string, BankProblem>();
  const addProblem = (
    p: BankPayment,
    code: BankProblem["code"],
    message: string,
    candidates?: BankCandidate[],
  ) => {
    const key = `${code}|${message}|${p.inn || p.counterparty}`;
    const existing = grouped.get(key);
    if (existing) existing.rows.push(p.row);
    else {
      const created: BankProblem = {
        rows: [p.row],
        code,
        message,
        counterparty: label(p),
        ...(candidates ? { candidates } : {}),
      };
      grouped.set(key, created);
      problems.push(created);
    }
  };
  const addNote = (rows: number[], message: string) => {
    const existing = notes.find((n) => n.message === message);
    if (existing) existing.rows.push(...rows);
    else notes.push({ rows, message });
  };

  // 1. Payments the program's own checks stop.
  const stopped = new Map<number, string[]>();
  for (const issue of statement.issues) {
    if (BLOCKING.includes(issue.code))
      stopped.set(issue.row, [...(stopped.get(issue.row) ?? []), issue.message]);
  }
  for (const p of payments.filter((x) => stopped.has(x.row))) {
    addProblem(p, "CHECK", (stopped.get(p.row) ?? []).join("; "));
  }
  payments = payments.filter((p) => !stopped.has(p.row));
  if (payments.length === 0) return nothing();

  // 2. The organization's own bank account. Not finding it is not a stop: the copied document keeps its own.
  let ownAccount: string | null = overrides.ownAccount ?? null;
  if (!ownAccount && statement.account) {
    const rows = await lookup(
      deps,
      (ph) =>
        `ВЫБРАТЬ Т.Ссылка КАК Ссылка, Т.Наименование КАК Наименование ИЗ Справочник.БанковскиеСчета КАК Т ГДЕ Т.НомерСчета В (${ph}) И НЕ Т.ПометкаУдаления`,
      [statement.account],
    );
    const found = (rows ?? []).flatMap(({ cells }) => {
      const ref = refOf(cells[0]);
      return ref ? [ref] : [];
    });
    const [only] = found;
    if (found.length === 1 && only) ownAccount = only;
    else if (rows) {
      addNote(
        payments.map((p) => p.row),
        found.length === 0
          ? `no bank account ${statement.account} in 1C: each document keeps the account of the payment it was copied from`
          : `${found.length} bank accounts have the number ${statement.account}: each document keeps the account of the payment it was copied from`,
      );
    }
  }

  // 3. Counterparties by INN, and by name where the bank wrote no INN (zeros).
  const inns = [...new Set(payments.map((p) => p.inn).filter((inn) => inn !== ""))];
  const names = [
    ...new Map(
      payments.flatMap((p) => {
        const who = whoOf(p);
        return who?.field === "Наименование" ? [[who.key, who.value] as const] : [];
      }),
    ).values(),
  ];
  const byWho = new Map<string, BankCandidate[]>();
  const counterpartyRows = inns.length
    ? await lookup(
        deps,
        (ph) =>
          `ВЫБРАТЬ Т.ИНН КАК ИНН, Т.Ссылка КАК Ссылка, Т.Наименование КАК Наименование ИЗ Справочник.Контрагенты КАК Т ГДЕ Т.ИНН В (${ph}) И НЕ Т.ПометкаУдаления`,
        inns,
      )
    : [];
  for (const { cells } of counterpartyRows ?? []) {
    const ref = refOf(cells[1]);
    if (ref)
      byWho.set(String(cells[0]), [...(byWho.get(String(cells[0])) ?? []), { ref, name: textOf(cells[2]) }]);
  }
  const nameRows = names.length
    ? await lookup(
        deps,
        (ph) =>
          `ВЫБРАТЬ Т.Наименование КАК Наименование, Т.Ссылка КАК Ссылка, Т.Наименование КАК Имя ИЗ Справочник.Контрагенты КАК Т ГДЕ Т.Наименование В (${ph}) И НЕ Т.ПометкаУдаления`,
        names,
      )
    : [];
  for (const { cells } of nameRows ?? []) {
    const ref = refOf(cells[1]);
    const key = `name:${nameKey(String(cells[0] ?? ""))}`;
    if (ref) byWho.set(key, [...(byWho.get(key) ?? []), { ref, name: textOf(cells[2]) }]);
  }

  // A payment with no INN (acquiring, bank fees) is copied from a payment of the same kind: no counterparty is needed.
  const withCounterparty: { payment: BankPayment; counterparty: string | null }[] = [];
  for (const p of payments) {
    const chosen = overrides.counterparties?.find((o) => o.row === p.row);
    if (chosen) {
      withCounterparty.push({ payment: p, counterparty: chosen.ref });
      continue;
    }
    const who = whoOf(p);
    // A payment to the budget has no counterparty to look up: it is copied from the company's payment of the same tax.
    if (!who || (isTaxPayment(p) && taxKindOf(p.purpose))) {
      withCounterparty.push({ payment: p, counterparty: null });
      continue;
    }
    if (!counterpartyRows || !nameRows) {
      addProblem(p, "COUNTERPARTY_NOT_FOUND", "1C could not be asked for the counterparty");
      continue;
    }
    const matches = byWho.get(who.key) ?? [];
    const [only] = matches;
    const named =
      who.field === "Наименование" ? `the name "${who.value}" (no INN in the statement)` : `INN ${p.inn}`;
    if (matches.length === 1 && only) withCounterparty.push({ payment: p, counterparty: only.ref });
    else if (matches.length === 0) {
      // A company's INN is 9 digits; a person's (14) is not written here, and a nameless row cannot be created. A payer known by name only
      // is created under the zeros the bank wrote, so a later statement finds it by name again.
      if (
        options.createMissing &&
        p.counterparty.trim() !== "" &&
        (who.field === "Наименование" || p.inn.length === 9)
      ) {
        const known = missingByKey.get(who.key);
        if (known) known.rows.push(p.row);
        else
          missingByKey.set(who.key, {
            inn: p.inn || "000000000",
            name: p.counterparty.trim(),
            rows: [p.row],
            key: who.key,
          });
      } else {
        addProblem(p, "COUNTERPARTY_NOT_FOUND", `no counterparty with ${named} in 1C: create it first`);
      }
    } else
      addProblem(
        p,
        "COUNTERPARTY_AMBIGUOUS",
        `${matches.length} counterparties have ${named}: choose one`,
        matches,
      );
  }
  if (withCounterparty.length === 0) return nothing();

  // 4. Payments already in 1C: the same day, counterparty and amount in the same kind of document.
  const dates = withCounterparty.map((x) => x.payment.date).sort();
  const existing = new Set<string>();
  for (const direction of ["in", "out"] as const) {
    if (!withCounterparty.some((x) => x.payment.direction === direction)) continue;
    const query: RunQueryInput = {
      query: `ВЫБРАТЬ Т.Контрагент КАК Контрагент, Т.Дата КАК Дата, Т.СуммаДокумента КАК Сумма ИЗ ${OBJECT[direction]} КАК Т ГДЕ Т.Дата МЕЖДУ &начало И &конец И НЕ Т.ПометкаУдаления`,
      params: { начало: `${dates[0]}T00:00:00`, конец: `${dates.at(-1)}T23:59:59` },
      limit: 1000,
      refs: true,
    };
    const outcome = await deps.query(query);
    if (!outcome.ok) continue;
    for (const cells of (outcome.data as { rows?: unknown[][] }).rows ?? []) {
      if (typeof cells[2] === "number")
        existing.add(`${direction}|${sameKey(String(cells[1]), refOf(cells[0]) ?? "", cells[2])}`);
    }
  }

  // 5. The contracts the purposes name, and the counterparties' bank accounts, by INN or name.
  const mentions = new Map<number, { number: string; date: string }>();
  // A counterparty created in this run whose purposes name no contract gets a neutral one, "№б/н от <its
  // earliest payment's date>", as an accountant would open it; one contract per counterparty.
  const neutralDate = new Map<string, string>();
  for (const { payment } of withCounterparty) {
    const who = whoOf(payment);
    if (!who || !options.fresh?.has(who.key) || contractMention(payment.purpose)) continue;
    const date = neutralDate.get(who.key);
    if (!date || payment.date < date) neutralDate.set(who.key, payment.date);
  }
  const neutral = new Set<number>();
  for (const { payment } of withCounterparty) {
    const who = whoOf(payment);
    if (!who) continue;
    const named = contractMention(payment.purpose);
    const date = named ? undefined : neutralDate.get(who.key);
    if (named) mentions.set(payment.row, named);
    else if (date) {
      mentions.set(payment.row, { number: NEUTRAL_NUMBER, date });
      neutral.add(payment.row);
    }
  }
  const contractsOf = new Map<string, { ref: string; number: string; date: string }[]>();
  for (const { key, cells } of await lookupByWho(
    deps,
    withCounterparty.filter(({ payment }) => mentions.has(payment.row)).map((x) => x.payment),
    (owner, ph) =>
      `ВЫБРАТЬ ${owner} КАК Ключ, Т.Ссылка КАК Ссылка, Т.Номер КАК Номер, Т.Дата КАК Дата ИЗ Справочник.ДоговорыКонтрагентов КАК Т ГДЕ ${owner} В (${ph}) И НЕ Т.ПометкаУдаления`,
  )) {
    const ref = refOf(cells[1]);
    if (ref) {
      const list = contractsOf.get(key) ?? [];
      list.push({ ref, number: String(cells[2] ?? ""), date: day(String(cells[3] ?? "")) });
      contractsOf.set(key, list);
    }
  }
  const accountsOf = new Map<string, string>();
  for (const { key, cells } of await lookupByWho(
    deps,
    withCounterparty.filter((x) => whoOf(x.payment) && x.payment.account).map((x) => x.payment),
    (owner, ph) =>
      `ВЫБРАТЬ ${owner} КАК Ключ, Т.Ссылка КАК Ссылка, Т.НомерСчета КАК НомерСчета ИЗ Справочник.БанковскиеСчета КАК Т ГДЕ ${owner} В (${ph}) И НЕ Т.ПометкаУдаления`,
  )) {
    const ref = refOf(cells[1]);
    if (ref) accountsOf.set(`${key}|${String(cells[2] ?? "").replace(/\D/g, "")}`, ref);
  }

  // 6. A copy of the counterparty's newest payment of the same kind, per payment.
  const ready: BankResolved["ready"] = [];
  for (const { payment, counterparty } of withCounterparty) {
    if (
      existing.has(`${payment.direction}|${sameKey(payment.date, counterparty ?? "", payment.amount / 100)}`)
    ) {
      alreadyIn1c.push(payment.row);
      continue;
    }
    const object = OBJECT[payment.direction];
    const asked = overrides.templates?.find((o) => o.row === payment.row);
    // A tax payment: the tax is named by the payment, and the template is the company's payment of that same tax.
    if (!asked && isTaxPayment(payment)) {
      const made = await taxPayment(deps, cache, payment, ownAccount);
      if (made.ok) {
        ready.push({ payment, change: made.change });
        addNote([payment.row], made.note);
      } else {
        addProblem(payment, "TAX_PAYMENT", made.message);
      }
      continue;
    }
    const who = whoOf(payment);
    const fresh = Boolean(counterparty && who && options.fresh?.has(who.key));
    const template = asked
      ? await snapshot(deps, cache, object, asked.ref)
      : fresh
        ? await kindTemplate(deps, cache, object, payment, currency)
        : await findTemplate(deps, cache, object, payment, who, currency);
    if (!template) {
      addProblem(
        payment,
        "NO_TEMPLATE",
        `no earlier posted ${object.replace("Документ.", "")} of this kind to copy: answer with templates (a posted document of the same kind) or enter it with propose_changes`,
      );
      continue;
    }

    let contract: string | null = null;
    const mention = mentions.get(payment.row);
    if (fresh && counterparty) {
      const list = contractsOf.get(who?.key ?? "") ?? [];
      const have = mention
        ? list.filter(
            (c) => normalNumber(c.number) === normalNumber(mention.number) && c.date === mention.date,
          )
        : [];
      if (have.length === 1 && have[0]) contract = have[0].ref;
      else if (mention) {
        // The counterparty was created a moment ago: its contract is made too, like the company's other contracts.
        const key = `${who?.key ?? ""}|${normalNumber(mention.number)}|${mention.date}`;
        const known = pendingContracts.get(key);
        if (known) known.rows.push(payment.row);
        else {
          const change = await contractChange(deps, cache, template, payment, mention, counterparty);
          if (!change) {
            addProblem(
              payment,
              "NEW_COUNTERPARTY",
              "the contract named in the purpose cannot be made from the earlier payment's contract: enter it with propose_changes",
            );
            continue;
          }
          pendingContracts.set(key, {
            rows: [payment.row],
            label: `№${mention.number} ${mention.date.split("-").reverse().join(".")} · ${payment.counterparty}`,
            change,
          });
        }
        continue;
      } else {
        addProblem(
          payment,
          "NEW_COUNTERPARTY",
          "a counterparty created in this run, and the purpose names no contract: enter the payment with propose_changes",
        );
        continue;
      }
      const whose = template.fields["Контрагент"];
      const name =
        whose && typeof whose === "object" && typeof (whose as { name?: unknown }).name === "string"
          ? (whose as { name: string }).name
          : "";
      addNote(
        [payment.row],
        `new counterparty "${payment.counterparty}": the operation, accounts and VAT come from the latest payment of the same kind${name ? ` (to "${name}")` : ""}; check them` +
          (neutral.has(payment.row)
            ? `. The purpose names no contract, so its contract is the neutral "№${NEUTRAL_NUMBER} от ${day(payment.date).split("-").reverse().join(".")}"; check its kind and expiry`
            : ""),
      );
    } else if (mention) {
      const list = contractsOf.get(who?.key ?? "") ?? [];
      const match = list.filter(
        (c) => normalNumber(c.number) === normalNumber(mention.number) && c.date === mention.date,
      );
      const [only] = match;
      if (match.length === 1 && only) contract = only.ref;
      else {
        addNote(
          [payment.row],
          `the purpose names contract ${mention.number} of ${mention.date.split("-").reverse().join(".")}, which 1C ${list.length === 0 ? "does not have for this counterparty" : `does not have (it has ${list.map((c) => `${c.number} of ${c.date.split("-").reverse().join(".")}`).join(", ")})`}: the contract of the payment it was copied from is used`,
        );
      }
    }
    // No INN in the statement: the counterparty is the earlier payment's. Say whose, so that a wrong one is seen.
    if (!who && !overrides.counterparties?.some((o) => o.row === payment.row)) {
      const whose = template.fields["Контрагент"];
      const name =
        whose && typeof whose === "object" && typeof (whose as { name?: unknown }).name === "string"
          ? (whose as { name: string }).name
          : "";
      addNote(
        [payment.row],
        `no INN in the statement for "${payment.counterparty || "?"}": the counterparty${name ? ` "${name}"` : ""} and the accounts come from the earlier payment of the same kind (${template.ref}); check that it is the right counterparty`,
      );
    }
    const context: CopyContext = {
      counterparty,
      contract,
      ownAccount,
      counterpartyAccount: accountsOf.get(`${who?.key ?? ""}|${payment.account}`) ?? null,
      // An account in a currency: the payment is in that currency, at the rate of its day.
      ...(foreignAccount
        ? { foreign: { currency, rate: await rateOn(deps, cache, currency, day(payment.date)) } }
        : {}),
    };
    // The only earlier payment is in soums: the program makes the payment in the currency from it.
    if (foreignAccount && context.foreign && !sameCurrency(template, currency)) {
      const convert = await conversionFor(
        deps,
        cache,
        currency,
        contract ?? refIn(template.fields["ДоговорКонтрагента"]),
      );
      if (convert) context.foreign.convert = convert;
    }
    // A card (acquiring) receipt: the statement has the net, the company books the gross and the bank's
    // commission as a bank-fee document of its own.
    const acquiring =
      payment.direction === "in" && options.splitCommission !== false && !foreignAccount
        ? parseAcquiring(payment.purpose, payment.amount)
        : null;
    if (acquiring) {
      const fee = await commissionTemplate(deps, cache);
      const gross = copyTemplate(template, { ...payment, amount: acquiring.gross }, context);
      const commission = fee
        ? copyTemplate(fee, { ...payment, direction: "out", amount: acquiring.commission }, { ownAccount })
        : null;
      if (gross.ok && commission?.ok) {
        ready.push({ payment, change: gross.change });
        ready.push({ payment, change: commission.change, part: "commission" });
        addNote(
          [payment.row],
          "acquiring receipt booked gross, and the bank's commission as a bank-fee document of its own, copied from the latest acquiring commission document",
        );
        continue;
      }
      addNote(
        [payment.row],
        fee
          ? "acquiring receipt: the commission document could not be made from the latest acquiring commission document; the receipt is entered net"
          : "acquiring receipt: 1C has no earlier acquiring commission document to copy, so the commission is not entered and the receipt is net",
      );
    }
    const made = copyTemplate(template, payment, context);
    if (!made.ok) {
      addProblem(payment, "BAD_TEMPLATE", made.message);
      continue;
    }
    ready.push({ payment, change: made.change });
    for (const note of made.notes ?? []) addNote([payment.row], note);
  }
  return {
    missing: [...missingByKey.values()],
    contractsToCreate: [...pendingContracts.values()],
    ready,
    alreadyIn1c,
    problems,
    notes,
  };
}

const TAX_NEEDS =
  "a payment to the budget needs the «Уплата налога» operation, the tax, its period and the tax office. Answer with templates (a posted «Уплата налога» document of the company, for the same tax) or enter it with propose_changes";

/** The company's posted tax payments, newest first, read once. */
async function loadTaxHistory(deps: BankDeps, cache: BankCache): Promise<TaxHistory[] | null> {
  if (cache.tax !== undefined) return cache.tax;
  const outcome = await deps.query({
    query:
      "ВЫБРАТЬ ПЕРВЫЕ 300 Т.Ссылка КАК Ссылка, Т.Дата КАК Дата, Т.НалоговыйПериод КАК Период, Т.Налог.Наименование КАК Налог, Т.НазначениеПлатежа КАК Назначение " +
      `ИЗ ${OBJECT.out} КАК Т ГДЕ Т.Проведен И НЕ Т.ПометкаУдаления И Т.Налог <> ЗНАЧЕНИЕ(Справочник.ВидыНалоговИПлатежейВБюджет.ПустаяСсылка) УПОРЯДОЧИТЬ ПО Т.Дата УБЫВ`,
    limit: 300,
    refs: true,
  });
  cache.tax = outcome.ok
    ? ((outcome.data as { rows?: unknown[][] }).rows ?? []).flatMap((cells) => {
        const ref = refOf(cells[0]);
        return ref
          ? [
              {
                ref,
                date: String(cells[1] ?? ""),
                period: typeof cells[2] === "string" ? cells[2] : "",
                tax: textOf(cells[3]),
                purpose: String(cells[4] ?? ""),
              },
            ]
          : [];
      })
    : null;
  return cache.tax;
}

const isKind = (row: TaxHistory, kind: TaxKind) =>
  taxNameIs(kind, row.tax) || taxKindOf(row.purpose) === kind;

/**
 * A payment to the budget made from the company's newest posted payment of the same tax: its operation, accounts,
 * tax and tax office stay, and the payment's date, amount, number, purpose and the tax period change. The period is
 * the one the purpose names, else the company's habit (how many months before the payment its earlier payments of
 * this tax were for).
 */
async function taxPayment(
  deps: BankDeps,
  cache: BankCache,
  payment: BankPayment,
  ownAccount: string | null,
): Promise<{ ok: true; change: ChangeInput; note: string } | { ok: false; message: string }> {
  const kind = taxKindOf(payment.purpose);
  if (!kind) {
    return { ok: false, message: `the purpose names no single tax: ${TAX_NEEDS}` };
  }
  const history = await loadTaxHistory(deps, cache);
  if (!history)
    return { ok: false, message: `1C could not be asked for the company's tax payments: ${TAX_NEEDS}` };
  const same = history.filter((h) => isKind(h, kind));
  const latest = same[0];
  if (!latest) {
    return {
      ok: false,
      message: `the company has no posted payment of this tax (${kind}) in 1C to copy: ${TAX_NEEDS}`,
    };
  }
  const template = await snapshot(deps, cache, OBJECT.out, latest.ref);
  if (!template) return { ok: false, message: `the payment ${latest.ref} could not be read: ${TAX_NEEDS}` };
  const period = taxPeriodFor(
    payment.purpose,
    day(payment.date),
    same.map((h) => ({ date: day(h.date), period: h.period ? day(h.period) : "" })),
  );
  const made = copyTemplate(template, payment, {
    ownAccount,
    ...(period ? { set: { НалоговыйПериод: period.value } } : {}),
  });
  if (!made.ok) return { ok: false, message: made.message };
  const from = `${template.fields["Номер"] ?? latest.ref} of ${day(latest.date)}`;
  const note =
    `tax payment (${latest.tax || kind}) copied from the company's latest payment of the same tax, ${from}; ` +
    (period
      ? period.source === "purpose"
        ? `the tax period is ${period.value.slice(0, 7)}, as the purpose says`
        : `the tax period is ${period.value.slice(0, 7)}: the company's earlier payments of this tax were for ${period.lag === 1 ? "the month before" : `${period.lag} months before`} the payment month`
      : "the tax period and the tax office are the earlier payment's: the purpose names no period and no habit could be read") +
    "; check the amount of the tax and its period";
  return { ok: true, change: made.change, note };
}

export async function snapshot(
  deps: BankDeps,
  cache: BankCache,
  object: string,
  ref: string,
): Promise<Template | null> {
  const key = `${object}|${ref}`;
  if (cache.snapshots.has(key)) return cache.snapshots.get(key) ?? null;
  const outcome = await deps.getObject(object, ref);
  let template: Template | null = null;
  if (outcome.ok) {
    const data = outcome.data as {
      fields?: Record<string, unknown>;
      tables?: Record<string, Record<string, unknown>[]>;
    };
    template = { object, ref, fields: data.fields ?? {}, tables: data.tables ?? {} };
  }
  cache.snapshots.set(key, template);
  return template;
}

/** Documents of a kind, the posted ones first and then the newest (one the program itself made a moment ago is a template too, in a base with no posted one), with their purposes: of one counterparty (by INN or name), or the newest of all. */
async function loadList(
  deps: BankDeps,
  cache: BankCache,
  object: string,
  who: Who | null,
): Promise<{ ref: string; purpose: string }[]> {
  const key = `${object}|${who?.key ?? "*"}`;
  const cached = cache.lists.get(key);
  if (cached) return cached;
  const outcome = await deps.query({
    query: who
      ? `ВЫБРАТЬ ПЕРВЫЕ 20 Т.Ссылка КАК Ссылка, Т.НазначениеПлатежа КАК Назначение ИЗ ${object} КАК Т ГДЕ НЕ Т.ПометкаУдаления И Т.Контрагент.${who.field} = &${who.field === "ИНН" ? "инн" : "имя"} УПОРЯДОЧИТЬ ПО Т.Проведен УБЫВ, Т.Дата УБЫВ`
      : `ВЫБРАТЬ ПЕРВЫЕ 300 Т.Ссылка КАК Ссылка, Т.НазначениеПлатежа КАК Назначение ИЗ ${object} КАК Т ГДЕ НЕ Т.ПометкаУдаления УПОРЯДОЧИТЬ ПО Т.Проведен УБЫВ, Т.Дата УБЫВ`,
    ...(who ? { params: { [who.field === "ИНН" ? "инн" : "имя"]: who.value } } : {}),
    limit: who ? 20 : 300,
    refs: true,
  });
  const list = outcome.ok
    ? ((outcome.data as { rows?: unknown[][] }).rows ?? []).flatMap((cells) => {
        const ref = refOf(cells[0]);
        return ref ? [{ ref, purpose: String(cells[1] ?? "") }] : [];
      })
    : [];
  cache.lists.set(key, list);
  return list;
}

/** The currency item of 1C's catalog for a currency in letters (it keeps the numeric or the letter code). */
async function currencyRef(deps: BankDeps, cache: BankCache, currency: string): Promise<string | null> {
  cache.currencyRefs ??= new Map();
  if (cache.currencyRefs.has(currency)) return cache.currencyRefs.get(currency) ?? null;
  let found: string | null = null;
  for (const code of CURRENCY_CODES[currency] ?? [currency]) {
    const outcome = await deps.query({
      query: "ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ Справочник.Валюты КАК Т ГДЕ Т.Код = &Код",
      params: { Код: code },
      limit: 1,
      refs: true,
    });
    const cell = outcome.ok ? (outcome.data as { rows?: unknown[][] }).rows?.[0]?.[0] : null;
    found = refOf(cell);
    if (found) break;
  }
  cache.currencyRefs.set(currency, found);
  return found;
}

/**
 * What a payment in a currency needs when the counterparty's only earlier payment is in soums: the currency item and
 * how its contract is settled. Null when 1C cannot say (no such currency item, a contract in a third currency).
 */
async function conversionFor(
  deps: BankDeps,
  cache: BankCache,
  currency: string,
  contract: string | null,
): Promise<NonNullable<CopyContext["foreign"]>["convert"] | null> {
  const item = await currencyRef(deps, cache, currency);
  if (!item) return null;
  let settledIn: "same" | "soums" = "soums";
  if (contract) {
    const read = await deps.getObject("Справочник.ДоговорыКонтрагентов", contract);
    const fields = read.ok ? (read.data as { fields?: Record<string, unknown> }).fields : undefined;
    const named = fields ? textOf(fields["ВалютаВзаиморасчетов"]) : "";
    const code = named ? currencyFromText(named) : "";
    if (code === currency) settledIn = "same";
    else if (code !== "" && code !== "UZS") return null;
  }
  return { currencyRef: item, settledIn };
}

/** How many of the newest payments are read to find one that can be copied for a new counterparty. */
const KIND_TEMPLATE_CANDIDATES = 50;

/** A made-up reference, to test that a template can be copied before any counterparty or contract exists. */
const DUMMY = "00000000-0000-4000-8000-000000000000";

/**
 * For a counterparty with no earlier payment: the newest posted payment of the same kind that has a
 * contract and can be copied (one breakdown row, in сум). Its operation, accounts and VAT are the
 * company's usual ones for such a payment.
 */
async function kindTemplate(
  deps: BankDeps,
  cache: BankCache,
  object: string,
  payment: BankPayment,
  currency = "",
): Promise<Template | null> {
  const list = await loadList(deps, cache, object, null);
  const foreign = currency !== "" && currency !== "UZS";
  // Newest first, until one can be copied; a bound keeps a base with no usable payment from being read whole.
  for (const candidate of list.slice(0, KIND_TEMPLATE_CANDIDATES)) {
    const template = await snapshot(deps, cache, object, candidate.ref);
    if (!template || !refOf(template.fields["ДоговорКонтрагента"]) || !sameCurrency(template, currency))
      continue;
    const ctx: CopyContext = {
      counterparty: DUMMY,
      contract: DUMMY,
      ...(foreign ? { foreign: { currency, rate: 1 } } : {}),
    };
    if (copyTemplate(template, payment, ctx).ok) return template;
  }
  // A currency account and no payment in that currency to copy: a payment in soums can be made into one.
  if (foreign && (await currencyRef(deps, cache, currency))) {
    for (const candidate of list.slice(0, KIND_TEMPLATE_CANDIDATES)) {
      const template = await snapshot(deps, cache, object, candidate.ref);
      if (!template || !refOf(template.fields["ДоговорКонтрагента"])) continue;
      const ctx: CopyContext = {
        counterparty: DUMMY,
        contract: DUMMY,
        foreign: { currency, rate: 1, convert: { currencyRef: DUMMY, settledIn: "soums" } },
      };
      if (copyTemplate(template, payment, ctx).ok) return template;
    }
  }
  return null;
}

/**
 * The company's latest acquiring commission document (a bank fee whose purpose says it is for the
 * terminals), read once: what an acquiring receipt's commission is copied from.
 */
async function commissionTemplate(deps: BankDeps, cache: BankCache): Promise<Template | null> {
  const object = OBJECT.out;
  const key = `${object}|commission`;
  if (cache.snapshots.has(key)) return cache.snapshots.get(key) ?? null;
  const list = await loadList(deps, cache, object, null);
  const found = list.find((c) => isAcquiringFee(c.purpose));
  const template = found ? await snapshot(deps, cache, object, found.ref) : null;
  cache.snapshots.set(key, template);
  return template;
}

/** Fields of a directory item that 1C makes or that belong to this one item, never copied from another. */
const NOT_COPIED_ITEM = new Set([
  "Код",
  "Code",
  "Наименование",
  "Description",
  "Владелец",
  "Owner",
  "Родитель",
  "Parent",
  "ЭтоГруппа",
  "IsFolder",
  "ПометкаУдаления",
  "DeletionMark",
  "Предопределенный",
  "Predefined",
  "ИмяПредопределенныхДанных",
  "Номер",
  "Дата",
  "СрокДействия",
]);

/**
 * A new counterparty's contract, as the company makes its contracts: the contract of the template
 * payment is copied (its kind, currency, settlement rules), and the owner, the number, the date and
 * the name are this one's. The expiry date is left empty (the statement does not know it).
 */
async function contractChange(
  deps: BankDeps,
  cache: BankCache,
  template: Template,
  payment: BankPayment,
  mention: { number: string; date: string },
  owner: string,
): Promise<ChangeInput | null> {
  const contractRef = refOf(template.fields["ДоговорКонтрагента"]);
  if (!contractRef) return null;
  const earlier = await snapshot(deps, cache, "Справочник.ДоговорыКонтрагентов", contractRef);
  if (!earlier) return null;
  const fields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(earlier.fields)) {
    if (!NOT_COPIED_ITEM.has(name)) fields[name] = writable(value);
  }
  const [y, m, d] = mention.date.split("-");
  // The kind follows the direction of the money, whichever contract the template payment had.
  const kind = earlier.fields["ВидДоговора"];
  const kindName = kind && typeof kind === "object" ? (kind as { ref?: unknown }).ref : null;
  if (kindName === "СПокупателем" || kindName === "СПоставщиком") {
    fields["ВидДоговора"] = payment.direction === "in" ? "СПокупателем" : "СПоставщиком";
  }
  fields["Владелец"] = refTo(earlier.fields["Владелец"], owner, "Справочник.Контрагенты");
  fields["Номер"] = mention.number;
  fields["Дата"] = mention.date;
  fields["Наименование"] = `№${mention.number} от ${d}.${m}.${y}`;
  return { action: "create", object: "Справочник.ДоговорыКонтрагентов", fields };
}

/**
 * The document to copy for a payment. With an INN: the counterparty's newest posted payment of the
 * same kind, preferring one whose purpose says the same kind of thing (a fee, not a refund). With
 * none (acquiring, bank fees): the newest posted payment whose purpose has the same words.
 */
async function findTemplate(
  deps: BankDeps,
  cache: BankCache,
  object: string,
  payment: BankPayment,
  who: Who | null,
  currency = "",
): Promise<Template | null> {
  const list = await loadList(deps, cache, object, who);
  const shape = shapeOf(payment.purpose);
  const same = shape.length >= 8 ? list.find((c) => shapeOf(c.purpose) === shape) : undefined;
  const chosen = same ?? (who ? list[0] : undefined);
  if (!chosen) return null;
  const first = await snapshot(deps, cache, object, chosen.ref);
  if (!first || sameCurrency(first, currency)) return first;
  // The newest payment is in another currency than the account: the counterparty's newest in this one is the template.
  for (const candidate of list.filter((c) => c.ref !== chosen.ref).slice(0, 8)) {
    const template = await snapshot(deps, cache, object, candidate.ref);
    if (template && sameCurrency(template, currency)) return template;
  }
  return first;
}
