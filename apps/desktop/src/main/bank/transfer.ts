/**
 * Money moved between the company's own accounts, entered as 1C documents by the program. A move is two documents,
 * one on each account's side (a debit of the paying account, a receipt on the other), and the company already has a
 * way of recording them: its earlier posted documents of the operation «Перевод на другой счёт организации»,
 * «Перевод с другого счёта», or a conversion. The newest such document is copied, as for any payment, and only the
 * date, the amount, the bank document's number, the purpose and the two accounts change. A leg whose statement is not
 * attached is not entered (it will be, with its own statement); one already in 1C (the same account, day and amount)
 * is left out.
 */
import type { ChangeInput } from "@platform/shared";

import { lookup, refOf, textOf } from "../didox/resolve.js";
import type { Context } from "../engine/posting-rules.js";
import { contractFromDescription } from "./contract.js";
import { ExistingPool, existingDocs } from "./existing.js";
import { ACCOUNT_OWNER_COLUMNS, type AccountCandidate, candidateOf, pickAccount } from "./accounts.js";
import { type BuildKind, buildBankDocument } from "./build.js";
import { type Transfer, currencyOfAccount } from "./ledger.js";
import { CONVERSION_KIND, TRANSFER_KIND } from "./policy.js";
import { ownAccountKey } from "./roles.js";
import {
  type BankCache,
  type BankDeps,
  CURRENCY_CODES,
  type CopyContext,
  type MissingCounterparty,
  OBJECT,
  type Template,
  contractCurrency,
  conversionFor,
  copyTemplate,
  currencyRef,
  rateOn,
  refTo,
  sameCurrency,
  snapshot,
} from "./resolve.js";
import { EMPTY_MEMORY, type OperationProfile, operationProfiles, specificOperation } from "./operations.js";
import { newScaffoldCache, soumRef } from "./scaffold.js";
import type { BankPayment, BankStatement } from "./statement.js";

export interface TransferDoc {
  transfer: Transfer;
  side: "out" | "in";
  file: string;
  row: number;
  change: ChangeInput;
}

export interface TransferProblem {
  file: string;
  row: number;
  side: "out" | "in";
  message: string;
}

export interface TransfersResolved {
  /** The banks of conversions that 1C lacks as counterparties: made on a card, then the legs are entered. */
  missing: MissingCounterparty[];
  /** Contracts the conversions need (the bank's «Прочее» per currency) and 1C lacks: made on a card, then the legs are entered. */
  contractsToCreate: { rows: number[]; label: string; change: ChangeInput }[];
  ready: TransferDoc[];
  problems: TransferProblem[];
  notes: string[];
  /** Legs already in 1C: left out. */
  alreadyIn1c: { file: string; row: number }[];
}

const day = (iso: string) => iso.slice(0, 10);
const cents = (n: number) => Math.round(n);

/** The attributes of a transfer document that hold the other account, by the names configurations use. */
const OTHER_ACCOUNT = [
  "БанковскийСчетПолучатель",
  "СчетПолучатель",
  "БанковскийСчетОтправитель",
  "СчетОтправитель",
  "БанковскийСчетКорреспондент",
  "СчетКонтрагента",
  "СчетОрганизации",
];

/**
 * The operations the documents are copied from. A move between two accounts of one currency is a transfer pair (or a
 * conversion pair, by the operation's name). A move between a soum and a currency account cannot be a transfer pair:
 * 1C refuses «Перевод на другой счёт» when the receiving account is in another currency. The company books it as
 * «Прочее списание» (to the transit account) on the paying side and «Перевод с другого счёта» on the receiving one.
 */
type TemplateKind = "own" | "conversion" | "writeOff" | "transferIn";

const OTHER_WRITE_OFF = /проч\p{L}*\s+списан|boshqa\s+chiqim/iu;

const KIND_TEST: Record<TemplateKind, (name: string) => boolean> = {
  own: (n) => TRANSFER_KIND.test(n) && !CONVERSION_KIND.test(n),
  conversion: (n) => TRANSFER_KIND.test(n) && CONVERSION_KIND.test(n),
  writeOff: (n) => OTHER_WRITE_OFF.test(n),
  transferIn: (n) => TRANSFER_KIND.test(n),
};

/** Documents of an operation kind, the posted ones and then the newest. */
async function transferList(
  deps: BankDeps,
  cache: BankCache,
  object: string,
  kindName: TemplateKind,
): Promise<string[]> {
  const key = `${object}|transfer:${kindName}`;
  const cached = cache.lists.get(key);
  if (cached) return cached.map((c) => c.ref);
  const kinds = await deps.query({
    query: `ВЫБРАТЬ Т.ВидОперации КАК Вид, МАКСИМУМ(Т.Дата) КАК Последний ИЗ ${object} КАК Т ГДЕ Т.Проведен И НЕ Т.ПометкаУдаления СГРУППИРОВАТЬ ПО Т.ВидОперации`,
    limit: 100,
    refs: true,
  });
  const found: { value: string; last: string }[] = [];
  if (kinds.ok) {
    for (const cells of (kinds.data as { rows?: unknown[][] }).rows ?? []) {
      const cell = cells[0] as { type?: unknown; ref?: unknown } | undefined;
      const name = textOf(cell);
      if (!cell || typeof cell.type !== "string" || typeof cell.ref !== "string") continue;
      if (!KIND_TEST[kindName](name)) continue;
      found.push({ value: `${cell.type}.${cell.ref}`, last: String(cells[1] ?? "") });
    }
  }
  found.sort((a, b) => b.last.localeCompare(a.last));
  const refs: string[] = [];
  for (const kind of found.slice(0, 2)) {
    const list = await deps.query({
      query: `ВЫБРАТЬ ПЕРВЫЕ 20 Т.Ссылка КАК Ссылка ИЗ ${object} КАК Т ГДЕ НЕ Т.ПометкаУдаления И Т.ВидОперации = ЗНАЧЕНИЕ(${kind.value}) УПОРЯДОЧИТЬ ПО Т.Проведен УБЫВ, Т.Дата УБЫВ`,
      limit: 20,
      refs: true,
    });
    if (!list.ok) continue;
    for (const cells of (list.data as { rows?: unknown[][] }).rows ?? []) {
      const ref = refOf(cells[0]);
      if (ref) refs.push(ref);
    }
  }
  cache.lists.set(
    key,
    refs.map((ref) => ({ ref, purpose: "" })),
  );
  return refs;
}

/** The attribute of a transfer document that names the other account. */
function otherAccountKey(template: Template): string | null {
  const bankAccount = ownAccountKey(template.fields);
  const isAccount = (v: unknown) =>
    Boolean(v) && typeof v === "object" && (v as { type?: unknown }).type === "Справочник.БанковскиеСчета";
  const candidates = Object.entries(template.fields).filter(([k, v]) => k !== bankAccount && isAccount(v));
  return OTHER_ACCOUNT.find((k) => candidates.some(([name]) => name === k)) ?? candidates[0]?.[0] ?? null;
}

const refText = (value: unknown): string => refOf(value) ?? "";

/**
 * The earlier document to copy: the same pair of accounts if the company has moved money so before, else the newest;
 * with a currency, one in that currency comes before one that would have to be converted.
 */
async function pickTemplate(
  deps: BankDeps,
  cache: BankCache,
  object: string,
  kindName: TemplateKind,
  own: string,
  other: string,
  currency = "",
): Promise<Template | null> {
  const refs = await transferList(deps, cache, object, kindName);
  let newest: Template | null = null;
  let sameAccount: Template | null = null;
  let inCurrency: Template | null = null;
  for (const ref of refs.slice(0, 8)) {
    const template = await snapshot(deps, cache, object, ref);
    if (!template) continue;
    newest ??= template;
    const fits = currency === "" || sameCurrency(template, currency);
    if (fits) inCurrency ??= template;
    const ownKey = ownAccountKey(template.fields);
    if (!ownKey || refText(template.fields[ownKey]) !== own) continue;
    const key = otherAccountKey(template);
    if (fits && key && refText(template.fields[key]) === other) return template;
    if (fits) sameAccount ??= template;
  }
  return sameAccount ?? inCurrency ?? newest;
}

/** The newest posted document of an operation (the company's own), to copy. */
async function sampleOf(
  deps: BankDeps,
  cache: BankCache,
  object: string,
  operation: OperationProfile,
): Promise<Template | null> {
  if (!operation.type) return null;
  const list = await deps.query({
    query: `ВЫБРАТЬ ПЕРВЫЕ 8 Т.Ссылка КАК Ссылка ИЗ ${object} КАК Т ГДЕ Т.Проведен И НЕ Т.ПометкаУдаления И Т.ВидОперации = ЗНАЧЕНИЕ(${operation.type}.${operation.ref}) УПОРЯДОЧИТЬ ПО Т.Дата УБЫВ`,
    limit: 8,
    refs: true,
  });
  if (!list.ok) return null;
  for (const cells of (list.data as { rows?: unknown[][] }).rows ?? []) {
    const ref = refOf(cells[0]);
    const template = ref ? await snapshot(deps, cache, object, ref) : null;
    if (template) return template;
  }
  return null;
}

interface BankParty {
  bank?: { counterparty: string | null; contract: string | null };
  message?: string;
  /** The bank is not a counterparty of 1C: it is made on a card (its name is the one 1C's bank classifier has for the MFO). */
  createBank?: { inn: string; name: string };
  /** The bank's contract «Прочее» in the currency is not in 1C: it is made on a card, then the legs are entered. */
  create?: { label: string; change: ChangeInput };
}

/** The bank's own ledger lines, which the program or an accountant may have made counterparties of: not the bank. */
const BANK_LINE =
  /головн|получению|транзит|комисс|депозит|продажа\s+иностр|покупка\s+иностр|валют|казначей|физ\.?\s|конвертац/iu;

/** The soum, whichever code 1C's catalog keeps it under; and the letters of a currency item's code. */
const SOUM_CODES = ["860", "UZS", "000", "сўм", "сум"];
const codeMatches = (code: string, currency: string) =>
  currency === "UZS" ? SOUM_CODES.includes(code) : (CURRENCY_CODES[currency] ?? [currency]).includes(code);

/**
 * The bank of a conversion and its contract of kind «Прочее» in the leg's currency: the conversion passes through the
 * bank on both legs, a contract per currency (the method's setup rule). Said exactly when 1C lacks either.
 */
async function bankFor(
  deps: BankDeps,
  bankCache: BankCache,
  cache: Map<string, BankParty>,
  payment: BankPayment,
  currency: string,
  organization: string | null,
  firstDay: Map<string, string>,
): Promise<BankParty> {
  const inn = payment.inn;
  const key = `${inn || payment.counterparty}|${currency}`;
  const known = cache.get(key);
  if (known) return known;
  const answer = async (): Promise<BankParty> => {
    if (!inn)
      return { message: "the conversion's bank has no INN in the statement: the bank cannot be found in 1C" };
    const rows = await lookup(
      deps,
      (ph) =>
        `ВЫБРАТЬ Т.Ссылка КАК Ссылка, Т.Наименование КАК Наименование ИЗ Справочник.Контрагенты КАК Т ГДЕ Т.ИНН В (${ph}) И НЕ Т.ПометкаУдаления`,
      [inn],
    );
    if (!rows) return { message: "1C could not be asked for the conversion's bank" };
    const banks = rows.flatMap(({ cells }) => {
      const ref = refOf(cells[0]);
      const name = textOf(cells[1]);
      return ref && !BANK_LINE.test(name) ? [{ ref, name }] : [];
    });
    const [only] = banks;
    if (banks.length === 0) {
      // The bank's name as 1C's own classifier of banks spells it (by the MFO the statement gives), never a guess.
      const name = payment.mfo ? await bankNameOf(deps, payment.mfo) : null;
      const why = `1C has no counterparty for the bank (INN ${inn}) apart from the bank's own ledger lines: a conversion is with the bank on both legs`;
      return name
        ? {
            message: `${why}; it is made on a card (${name}), then this leg is entered`,
            createBank: { inn, name },
          }
        : {
            message: `${why}, so create the bank as a counterparty first (the statement does not give its name)`,
          };
    }
    if (banks.length !== 1 || !only) {
      return {
        message:
          banks.length === 0
            ? `1C has no counterparty for the bank (INN ${inn}) apart from the bank's own ledger lines: a conversion is with the bank on both legs, so create the bank as a counterparty first`
            : `${banks.length} counterparties could be the conversion's bank (INN ${inn}): ${banks.map((b) => b.name).join(", ")}; the accountant says which`,
      };
    }
    const contracts = await lookup(
      deps,
      (ph) =>
        `ВЫБРАТЬ Т.Владелец КАК Владелец, Т.Ссылка КАК Ссылка, Т.ВидДоговора КАК Вид, Т.ВалютаВзаиморасчетов.Код КАК Код, Т.Дата КАК Дата ИЗ Справочник.ДоговорыКонтрагентов КАК Т ГДЕ Т.Владелец.ИНН В (${ph}) И НЕ Т.ПометкаУдаления`,
      [inn],
    );
    if (!contracts) return { message: "1C could not be asked for the bank's contracts" };
    const other = contracts
      .filter(
        ({ cells }) =>
          refOf(cells[0]) === only.ref &&
          /проч|other/iu.test(`${textOf(cells[2])} ${(cells[2] as { ref?: string } | null)?.ref ?? ""}`) &&
          codeMatches(String(cells[3] ?? ""), currency),
      )
      .sort((a, b) => String(b.cells[4] ?? "").localeCompare(String(a.cells[4] ?? "")));
    const contract = refOf(other[0]?.cells[1]);
    if (!contract) {
      const sc = (bankCache.scaffold ??= newScaffoldCache());
      const made = await contractFromDescription(deps, bankCache, {
        owner: only.ref,
        mention: { number: `FX-${currency}`, date: firstDay.get(currency) ?? day(payment.date) },
        direction: "out",
        currency,
        currencyRef:
          currency === "UZS"
            ? (sc.soum ??= await soumRef(deps))
            : await currencyRef(deps, bankCache, currency),
        organization,
        kind: "other",
      });
      const why = `${only.name} has no contract of kind «Прочее» in ${currency}: the conversion method needs one contract with the bank per currency`;
      return made.ok
        ? {
            message: `${why}; it is made on a card, then this leg is entered`,
            create: { label: `${only.name} · «Прочее» ${currency}`, change: made.change },
          }
        : { message: `${why}, and it cannot be made: ${made.message}` };
    }
    return { bank: { counterparty: only.ref, contract } };
  };
  const result = await answer();
  cache.set(key, result);
  return result;
}

/** The name of a bank in 1C's classifier of banks, by its MFO; null when the classifier has none or not exactly one. */
async function bankNameOf(deps: BankDeps, mfo: string): Promise<string | null> {
  const outcome = await deps.query({
    query:
      "ВЫБРАТЬ ПЕРВЫЕ 2 Т.Наименование КАК Наименование ИЗ Справочник.Банки КАК Т ГДЕ Т.Код = &код И НЕ Т.ПометкаУдаления",
    params: { код: mfo },
    limit: 2,
    refs: true,
  });
  const names = outcome.ok
    ? ((outcome.data as { rows?: unknown[][] }).rows ?? []).map((cells) => String(cells[0] ?? "").trim())
    : [];
  const [only] = names;
  return names.length === 1 && only ? only : null;
}

/** One line for the accountant: the two legs of a conversion as they will be entered, and where the rates come from. */
function conversionPreview(t: Transfer, official: number | null, change: ChangeInput): string {
  const fx = t.fx;
  if (!fx) return "";
  const account = (change.fields ?? {})["СчетУчетаРасчетовСКонтрагентом"];
  void account;
  const gap =
    official === null ? "" : `, the gap to the Central Bank's rate (${official}) is the bank's: 9690`;
  return `conversion ${fx.id}: ${fx.direction === "buy" ? "bought" : "sold"} ${fx.amount} ${fx.currency} at the bank's rate ${fx.rate}; two linked documents through the conversion account ${fx.direction === "buy" ? "5730" : "5740"}, the paying one first${gap}; the account must close to zero`;
}

interface Leg {
  transfer: Transfer;
  side: "out" | "in";
  file: string;
  row: number;
  /** The account number on this leg's own statement, and the other account's. */
  own: string;
  other: string;
  /** The leg is made from the other side's row: that statement is not attached (see MIRROR). */
  mirror?: boolean;
}

/**
 * A move between two of the company's accounts is two documents. When only one of the two statements is attached, the
 * other side is made from the same row, mirrored (the same day, amount and purpose on the other account), so that both sides
 * are in 1C; when the other statement is read later, its row is found in 1C already. Its row number is the real one plus this.
 */
export const MIRROR = 1_000_000;

export async function resolveTransfers(
  transfers: Transfer[],
  statements: BankStatement[],
  options: {
    ownInn?: string;
    cache?: BankCache;
    files: Set<string>;
    done?: Set<string>;
    /** The company's organization in 1C and its account rules: for a document made with no earlier one to copy. */
    organization?: string | null;
    posting?: Context;
  },
  deps: BankDeps,
): Promise<TransfersResolved> {
  const cache: BankCache = options.cache ?? { lists: new Map(), snapshots: new Map() };
  const result: TransfersResolved = {
    missing: [],
    contractsToCreate: [],
    ready: [],
    problems: [],
    notes: [],
    alreadyIn1c: [],
  };
  // The first day of a conversion in each currency: the date of the bank's contract made for it.
  const firstDay = new Map<string, string>();
  for (const t of transfers) {
    if (!t.fx) continue;
    for (const currency of [t.fx.currency, "UZS"]) {
      const known = firstDay.get(currency);
      if (!known || t.date < known) firstDay.set(currency, day(t.date));
    }
  }
  const bankCache = new Map<string, BankParty>();
  const key = (file: string, row: number) => `${file}#${row}`;

  const legs: Leg[] = [];
  for (const transfer of transfers) {
    for (const side of ["out", "in"] as const) {
      const at = transfer[side];
      if (!at || !options.files.has(at.file) || options.done?.has(key(at.file, at.row))) continue;
      legs.push({
        transfer,
        side,
        file: at.file,
        row: at.row,
        own: side === "out" ? transfer.fromAccount : transfer.toAccount,
        other: side === "out" ? transfer.toAccount : transfer.fromAccount,
      });
    }
  }
  // The side whose statement is not attached: a plain move between two soum accounts is made from the attached side's row.
  for (const transfer of transfers) {
    if (transfer.fx || transfer.kind === "unattached_own") continue;
    const [present, missing] =
      transfer.out && !transfer.in
        ? (["out", "in"] as const)
        : transfer.in && !transfer.out
          ? (["in", "out"] as const)
          : [null, null];
    const at = present ? transfer[present] : null;
    if (!present || !missing || !at || !options.files.has(at.file)) continue;
    if (currencyOfAccount(transfer.fromAccount) !== "UZS" || currencyOfAccount(transfer.toAccount) !== "UZS")
      continue;
    if (options.done?.has(key(at.file, at.row + MIRROR))) continue;
    legs.push({
      transfer,
      side: missing,
      file: at.file,
      row: at.row + MIRROR,
      own: missing === "out" ? transfer.fromAccount : transfer.toAccount,
      other: missing === "out" ? transfer.toAccount : transfer.fromAccount,
      mirror: true,
    });
  }
  // A side made from the other side's row is dropped when a real row of the statements already stands for it in this run (the
  // same account, direction and amount within a few days): the same move read twice must be entered once.
  const dayOf = (leg: Leg): number => {
    const file = statements.find((s) => s.fileName === leg.file);
    const row = leg.mirror ? leg.row - MIRROR : leg.row;
    return Date.parse(day(file?.payments.find((p) => p.row === row)?.date ?? leg.transfer.date));
  };
  for (let i = legs.length - 1; i >= 0; i--) {
    const mirror = legs[i];
    if (!mirror?.mirror) continue;
    const real = legs.some(
      (l) =>
        !l.mirror &&
        l.own === mirror.own &&
        l.side === mirror.side &&
        l.transfer.amount === mirror.transfer.amount &&
        Math.abs(dayOf(l) - dayOf(mirror)) <= 3 * 86_400_000,
    );
    if (real) legs.splice(i, 1);
  }
  if (legs.length === 0) return result;
  const fail = (leg: Leg, message: string) =>
    result.problems.push({ file: leg.file, row: leg.row, side: leg.side, message });

  // The company's bank accounts in 1C, by number: the organization's own (the company may be a counterparty of itself too).
  const numbers = [...new Set(legs.flatMap((l) => [l.own, l.other]).filter((n) => /^\d{20}$/.test(n)))];
  const rows = numbers.length
    ? await lookup(
        deps,
        (ph) =>
          `ВЫБРАТЬ Т.НомерСчета КАК Номер, Т.Ссылка КАК Ссылка, ${ACCOUNT_OWNER_COLUMNS} ИЗ Справочник.БанковскиеСчета КАК Т ГДЕ Т.НомерСчета В (${ph}) И НЕ Т.ПометкаУдаления`,
        numbers,
      )
    : [];
  if (!rows) {
    for (const leg of legs) fail(leg, "1C could not be asked for the company's bank accounts");
    return result;
  }
  const accountRef = new Map<string, string>();
  const accountWhy = new Map<string, string>();
  const byNumber = new Map<string, AccountCandidate[]>();
  for (const { cells } of rows) {
    const ref = refOf(cells[1]);
    if (!ref) continue;
    const number = String(cells[0] ?? "").replace(/\D/g, "");
    const list = byNumber.get(number) ?? [];
    list.push(candidateOf(ref, cells, 2));
    byNumber.set(number, list);
  }
  for (const number of numbers) {
    const picked = pickAccount(number, byNumber.get(number) ?? [], options.ownInn);
    if (picked.ok) accountRef.set(number, picked.ref);
    else accountWhy.set(number, picked.why);
  }

  // Legs already in 1C: the same account, day and amount; each document of 1C stands for one leg (see existing.ts).
  const pools: Partial<Record<"in" | "out", ExistingPool>> = {};
  const dates = legs.map((l) => l.transfer.date).sort();
  for (const side of ["out", "in"] as const) {
    if (!legs.some((l) => l.side === side)) continue;
    const docs = await existingDocs(deps, cache, side, dates[0] ?? "", dates.at(-1) ?? "");
    if (docs) pools[side] = new ExistingPool(docs);
  }

  // A conversion is two legs on two statements, in two currencies. The currency leg is booked at the conversion's own
  // rate (the soums paid ÷ the currency received), not the Central Bank's, so that the two sides close each other in
  // the transit accounts; only the difference to the Central Bank's rate is an exchange difference, and 1C finds it
  // when the month is revalued. At the bank's rate of the day the transit accounts keep a residue of each conversion.
  const paymentOf = (leg: Leg): BankPayment | undefined => {
    const statement = statements.find((s) => s.fileName === leg.file);
    if (!leg.mirror) return statement?.payments.find((p) => p.row === leg.row);
    const source = statement?.payments.find((p) => p.row === leg.row - MIRROR);
    // The same row seen from the other account: the other direction, the first account as the counterparty's.
    return source
      ? { ...source, row: leg.row, direction: leg.side, account: leg.other, counterparty: "", inn: "" }
      : undefined;
  };
  const isCross = (leg: Leg) => {
    const a = currencyOfAccount(leg.own);
    const b = currencyOfAccount(leg.other);
    return a !== "" && b !== "" && a !== b;
  };
  const conversionRate = new Map<Leg, { rate: number; bank: number | null }>();
  const soumLegs = legs.filter((l) => isCross(l) && currencyOfAccount(l.own) === "UZS");
  const taken = new Set<Leg>();
  for (const foreign of legs.filter((l) => isCross(l) && currencyOfAccount(l.own) !== "UZS")) {
    const fp = paymentOf(foreign);
    if (!fp || !(fp.amount > 0)) continue;
    const bank = await rateOn(deps, cache, currencyOfAccount(foreign.own), day(fp.date));
    let best: { soum: Leg; rate: number; score: number } | null = null;
    for (const soum of soumLegs) {
      if (taken.has(soum) || soum.own !== foreign.other || soum.other !== foreign.own) continue;
      const sp = paymentOf(soum);
      if (!sp) continue;
      const gap = Math.abs(Date.parse(day(sp.date)) - Date.parse(day(fp.date))) / 86_400_000;
      if (gap > 3) continue;
      const rate = sp.amount / fp.amount;
      if (bank !== null && Math.abs(rate / bank - 1) > 0.1) continue;
      const score = gap * 1000 + (bank !== null ? Math.abs(rate / bank - 1) : 0);
      if (!best || score < best.score) best = { soum, rate, score };
    }
    if (best) {
      taken.add(best.soum);
      conversionRate.set(foreign, { rate: Math.round(best.rate * 1e6) / 1e6, bank });
    }
  }

  for (const leg of legs) {
    const payment: BankPayment | undefined = paymentOf(leg);
    if (!payment) {
      fail(leg, "the row is not in the statement");
      continue;
    }
    const ownCurrency = currencyOfAccount(leg.own);
    const cross =
      ownCurrency !== "" &&
      currencyOfAccount(leg.other) !== "" &&
      ownCurrency !== currencyOfAccount(leg.other);
    const ownRef = accountRef.get(leg.own) || null;
    const otherRef = accountRef.get(leg.other) || null;
    if (!ownRef) {
      fail(leg, accountWhy.get(leg.own) ?? `no bank account ${leg.own || "(none)"} of the company in 1C`);
      continue;
    }
    if (!otherRef && !leg.transfer.fx) {
      fail(
        leg,
        leg.other
          ? `the other account ${leg.other} cannot be used: ${accountWhy.get(leg.other) ?? "it is not among the company's bank accounts in 1C"}`
          : "the statement does not say the other account",
      );
      continue;
    }
    if (
      pools[leg.side]?.take({
        account: ownRef,
        day: day(payment.date),
        cents: cents(payment.amount),
        number: leg.mirror ? "" : payment.number,
      })
    ) {
      result.alreadyIn1c.push({ file: leg.file, row: leg.row });
      continue;
    }
    // A purchase or a sale of currency is one conversion of two linked legs through the conversion account.
    if (leg.transfer.fx) {
      const fx = leg.transfer.fx;
      const legCurrency = ownCurrency || "UZS";
      const foreignLeg = legCurrency !== "UZS";
      const official = foreignLeg ? await rateOn(deps, cache, fx.currency, day(payment.date)) : null;
      const bank = await bankFor(
        deps,
        cache,
        bankCache,
        payment,
        legCurrency,
        options.organization ?? null,
        firstDay,
      );
      if (bank.createBank && !result.missing.some((m) => m.key === bank.createBank?.inn))
        result.missing.push({ ...bank.createBank, rows: [], key: bank.createBank.inn });
      if (bank.create && !result.contractsToCreate.some((c) => c.label === bank.create?.label))
        result.contractsToCreate.push({ rows: [], ...bank.create });
      if (bank.message) {
        fail(leg, bank.message);
        continue;
      }
      // The contract of a leg is settled in the leg's own currency: a document with a ruble contract on a dollar account is
      // never written, in any company (when 1C cannot say the contract's currency, the lookup's own filter stands).
      if (bank.bank?.contract) {
        const settled = await contractCurrency(deps, cache, bank.bank.contract);
        if (settled && settled !== legCurrency) {
          fail(
            leg,
            `the contract chosen for this ${legCurrency} leg is settled in ${settled}: it is not written; the accountant says which contract the bank's ${legCurrency} conversions go under`,
          );
          continue;
        }
      }
      const built = await buildBankDocument(deps, cache, {
        kind: leg.side === "out" ? "conversionOut" : "conversionIn",
        payment,
        organization: options.organization ?? null,
        ownAccount: ownRef,
        currency: legCurrency,
        currencyRef: foreignLeg ? await currencyRef(deps, cache, legCurrency) : null,
        rate: official,
        ...(options.posting ? { posting: options.posting } : {}),
        conversion: { id: fx.id, direction: fx.direction, leg: leg.side, bank: bank.bank },
      });
      if (!built.ok) {
        fail(leg, built.message);
        continue;
      }
      for (const n of built.notes) if (!result.notes.includes(n)) result.notes.push(n);
      const preview = conversionPreview(leg.transfer, official, built.change);
      if (!result.notes.includes(preview)) result.notes.push(preview);
      result.ready.push({
        transfer: leg.transfer,
        side: leg.side,
        file: leg.file,
        row: leg.row,
        change: built.change,
      });
      continue;
    }
    // Past the conversion, a leg has its other account (the check above let only a conversion leg go without).
    if (!otherRef) continue;
    const object = OBJECT[leg.side];
    const kindName: TemplateKind = cross
      ? leg.side === "out"
        ? "writeOff"
        : "transferIn"
      : leg.transfer.kind === "conversion"
        ? "conversion"
        : "own";
    // A move between two accounts of one currency is first made by the program from 1C's description (see build.ts and
    // operations.ts: the operation and the account the company's own books show). A document of a form's operation («Перевод на
    // другой счет») written without the form posts to the wrong account or not at all, so it is not copied while the move can
    // be made another way; only when it cannot, the company's own operation that does nothing but this is copied.
    let template = cross
      ? await pickTemplate(deps, cache, object, kindName, ownRef, otherRef, ownCurrency)
      : null;
    if (!template) {
      // Nothing to copy (a new base, or its documents were deleted): the document is made from 1C's own description.
      const buildKind: BuildKind = cross
        ? leg.side === "out"
          ? "conversionOut"
          : "conversionIn"
        : leg.side === "out"
          ? "transferOut"
          : "transferIn";
      const foreignLeg = ownCurrency !== "" && ownCurrency !== "UZS";
      const paired = conversionRate.get(leg);
      const built = await buildBankDocument(deps, cache, {
        kind: buildKind,
        payment,
        organization: options.organization ?? null,
        ownAccount: ownRef,
        otherAccount: otherRef,
        currency: ownCurrency || "UZS",
        currencyRef: foreignLeg ? await currencyRef(deps, cache, ownCurrency) : null,
        rate: foreignLeg
          ? (paired?.rate ?? (await rateOn(deps, cache, ownCurrency, day(payment.date))))
          : null,
        ...(options.posting ? { posting: options.posting } : {}),
      });
      if (built.ok) {
        for (const n of built.notes) if (!result.notes.includes(n)) result.notes.push(n);
        if (paired) {
          const note = `${ownCurrency} leg of a conversion booked at the conversion's own rate (the soums paid ÷ the ${ownCurrency} received), so that the two sides close each other in the transit accounts; the Central Bank's rate of the day is only for revaluing at the month's end`;
          if (!result.notes.includes(note)) result.notes.push(note);
        }
        result.ready.push({
          transfer: leg.transfer,
          side: leg.side,
          file: leg.file,
          row: leg.row,
          change: built.change,
        });
        continue;
      }
      if (!cross) {
        const profiles = await operationProfiles(deps, cache, object);
        const own = specificOperation(buildKind, object, profiles, cache.memory ?? EMPTY_MEMORY);
        if (own) {
          template = await sampleOf(deps, cache, object, own);
          if (template) {
            const note = `the move is copied from the company's own earlier document of «${own.operation}» (${own.total} posted entries, all such moves): it could not be made from 1C's description (${built.message})`;
            if (!result.notes.includes(note)) result.notes.push(note);
          }
        }
      }
      if (!template) {
        fail(
          leg,
          built.message +
            (cross
              ? `. Between accounts of two currencies 1C refuses «Перевод на другой счёт»: the paying leg is «Прочее списание» and the receiving one «Перевод с другого счёта»`
              : ""),
        );
        continue;
      }
    }
    const otherKey = otherAccountKey(template);
    if (!otherKey && kindName !== "writeOff") {
      fail(leg, `the document to copy (${template.ref}) has no attribute for the other account`);
      continue;
    }
    const context: CopyContext = { ownAccount: ownRef };
    if (cross && ownCurrency !== "UZS") {
      const paired = conversionRate.get(leg);
      context.foreign = {
        currency: ownCurrency,
        rate: paired?.rate ?? (await rateOn(deps, cache, ownCurrency, day(payment.date))),
      };
      if (paired) {
        const note = `${ownCurrency} leg of a conversion booked at the conversion's own rate (the soums paid ÷ the ${ownCurrency} received), so that the two sides close each other in the transit accounts; the Central Bank's rate of the day is only for revaluing at the month's end`;
        if (!result.notes.includes(note)) result.notes.push(note);
      }
      if (!sameCurrency(template, ownCurrency)) {
        const convert = await conversionFor(deps, cache, ownCurrency, null);
        if (!convert) {
          fail(
            leg,
            `1C has no currency ${ownCurrency} in its catalog: the document in ${ownCurrency} cannot be made`,
          );
          continue;
        }
        context.foreign.convert = convert;
      }
    } else if (cross && !sameCurrency(template, "UZS")) {
      fail(
        leg,
        "the earlier document to copy is in a currency, the account is in soums: enter this one with the accountant",
      );
      continue;
    }
    const made = copyTemplate(template, payment, context);
    if (!made.ok) {
      fail(leg, made.message);
      continue;
    }
    if (otherKey) {
      made.change.fields = {
        ...made.change.fields,
        [otherKey]: refTo(template.fields[otherKey], otherRef, "Справочник.БанковскиеСчета"),
      };
    }
    for (const n of made.notes ?? []) if (!result.notes.includes(n)) result.notes.push(n);
    const from = `${template.fields["Номер"] ?? template.ref} of ${day(String(template.fields["Дата"] ?? ""))}`;
    const note = cross
      ? `conversion between ${ownCurrency} and ${currencyOfAccount(leg.other)} accounts: each leg is its own document in its own currency (${leg.side === "out" ? "«Прочее списание»" : "«Перевод с другого счёта»"}), copied from the company's ${from}; the difference between the bank's rate and the Central Bank's is left in 1C: check it`
      : `${leg.transfer.kind === "conversion" ? "conversion" : "transfer between own accounts"} copied from the company's ${from}; check the accounts and the operation`;
    if (!result.notes.includes(note)) result.notes.push(note);
    result.ready.push({
      transfer: leg.transfer,
      side: leg.side,
      file: leg.file,
      row: leg.row,
      change: made.change,
    });
  }
  // Entered in date order, the paying leg of a conversion before its receiving one: the conversion account must not run negative.
  const dateOf = (d: TransferDoc) => String(d.change.fields?.["Дата"] ?? "");
  result.ready.sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
  return result;
}
