/**
 * What the company's 1C says about how the company works: its bank accounts (and what each is used for), the
 * kinds of operation its bank documents carry, and the accounting policy register when the configuration has one.
 * Read only, with no AI: a few queries, each allowed to fail without stopping the rest. The result is set beside
 * the bank statements, so an import is looked at the way the company itself books such money: which account is
 * the main one, which holds money back (a blocked account), which is in a currency, and whether 1C has ever
 * recorded a transfer between its own accounts or a conversion, and as what.
 */
import type { RunQueryInput } from "@platform/shared";

import { type QueryOutcome, type ResolverDeps, refOf, textOf } from "../didox/resolve.js";
import { type LedgerPlan, currencyOfAccount } from "./ledger.js";

export type Direction = "out" | "in";

const OBJECT: Record<Direction, string> = {
  out: "Документ.СписаниеСРасчетногоСчета",
  in: "Документ.ПоступлениеНаРасчетныйСчет",
};

/** What a bank account is for, as far as its name, currency and ledger account tell. */
export type AccountPurpose = "main" | "blocked" | "foreign" | "other";

export interface OneCAccount {
  ref: string;
  number: string;
  name: string;
  /** The currency code 1C keeps for it (UZS, USD, RUB…), "" when none. */
  currency: string;
  /** The ledger account its postings go to (Код of СчетБУ), "" when unknown. */
  ledger: string;
  purpose: AccountPurpose;
  /** The kinds of operation its documents carry, by direction. */
  uses: Use[];
}

export interface Use {
  direction: Direction;
  kind: string;
  count: number;
  first: string;
  last: string;
}

/** A kind of operation seen in the bank documents: how often and when. */
export interface Kind extends Use {
  /** The kind is a move of money between the company's own accounts, or a conversion. */
  transfer: boolean;
}

export interface PolicyRecord {
  object: string;
  /** Field title → value, of the newest record. */
  fields: { name: string; value: string }[];
}

/** A kind of document the company actually posts: how many in the last year, and the newest. */
export interface Activity {
  object: string;
  count: number;
  last: string;
}

/** A ledger account the company's postings use (the last year): how often it is debited and credited. */
export interface Posting {
  code: string;
  debit: number;
  credit: number;
}

/** How the company books a kind of document: the account pairs its entries use, most used first (last 12 months). */
export interface Pattern {
  object: string;
  pairs: { debit: string; credit: string; count: number }[];
}

export interface Policy {
  accounts: OneCAccount[];
  kinds: Kind[];
  /** The documents the company posts (last 12 months), most first. */
  activity: Activity[];
  /** The ledger accounts its postings use (last 12 months), most used first. */
  postings: Posting[];
  /** Its entries by kind of document: what the engine copies instead of working the accounts out. */
  patterns: Pattern[];
  /** The currencies of its contracts with counterparties: how it deals with foreign currency. */
  currencies: { currency: string; contracts: number }[];
  /** The accounting policy register of the configuration, when one was found. */
  record: PolicyRecord | null;
  /** What could not be read, in a line each. */
  gaps: string[];
}

/** A kind of operation that is a move of money between the company's own accounts, or a conversion. */
export const TRANSFER_KIND =
  /перевод\s+на\s+другой|перевод\s+с\s+другого|между\s+(собственными\s+)?сч[её]т|конверт|покупк\w*\s+валют|продаж\w*\s+валют|обмен|boshqa\s+(hisob|xisob)|konvertats|valyuta\s+(sotib|sotish)/i;

/** Of those, the ones that exchange one currency for another. */
export const CONVERSION_KIND =
  /конверт|покупк\w*\s+валют|продаж\w*\s+валют|обмен|konvertats|valyuta\s+(sotib|sotish)/i;

/** Registers and catalogs where configurations keep the accounting policy, tried in this order. */
const POLICY_OBJECTS = [
  "РегистрСведений.УчетнаяПолитикаОрганизаций",
  "РегистрСведений.УчетнаяПолитика",
  "РегистрСведений.УчетнаяПолитикаБУ",
  "РегистрСведений.ПараметрыУчетнойПолитики",
  "Справочник.УчетныеПолитики",
];

/** Fields of a policy record that are plumbing, not policy. */
const PLUMBING =
  /^(ссылка|номер|код|предопределенный|признак|версия|пометка|владелец|родитель|период|организация)/i;

const MAX_POLICY_FIELDS = 40;

/** The policy goes into every request: past this size it is cut. */
const MAX_CHARS = 8000;

const rowsOf = (outcome: QueryOutcome): unknown[][] =>
  outcome.ok ? ((outcome.data as { rows?: unknown[][] }).rows ?? []) : [];

const day = (cell: unknown): string => (typeof cell === "string" ? cell.slice(0, 10) : "");

const text = (cell: unknown): string => {
  const named = textOf(cell);
  if (named) return named;
  if (typeof cell === "number" || typeof cell === "boolean") return String(cell);
  return "";
};

/** The currency as letters: 1C keeps its code (860 for the sum, 840 for the dollar) or its short name (сум). */
export function normalCurrency(code: string): string {
  const key = code.trim().toUpperCase();
  const numeric: Record<string, string> = {
    "000": "UZS",
    "860": "UZS",
    "643": "RUB",
    "840": "USD",
    "978": "EUR",
    "826": "GBP",
  };
  if (numeric[key]) return numeric[key];
  if (/^(СУМ|СЎМ|СУМА|SUM|SO'M|SOM|UZS)$/.test(key)) return "UZS";
  if (/^(РУБ|РУБ\.|РУБЛЬ|RUB)$/.test(key)) return "RUB";
  if (/^(ДОЛЛ|ДОЛЛАР|USD)$/.test(key)) return "USD";
  return key;
}

/** The currency a name stands for ("Доллар США", "USD", "840", "сум"), in letters; "" when it is none of the usual. */
export function currencyFromText(text: string): string {
  const exact = normalCurrency(text);
  if (/^[A-Z]{3}$/.test(exact)) return exact;
  if (/долл|dollar|\busd\b|aqsh/i.test(text)) return "USD";
  if (/евро|euro|\beur\b/i.test(text)) return "EUR";
  if (/рубл|rubl|\brub\b/i.test(text)) return "RUB";
  if (/сум|so['ʻ’]m|\buzs\b/i.test(text)) return "UZS";
  return "";
}

export function purposeOf(account: {
  name: string;
  currency: string;
  ledger: string;
  number: string;
}): AccountPurpose {
  if (/блок|block|bloklan|заблок|эскроу|escrow|аккредитив/i.test(account.name)) return "blocked";
  const currency = normalCurrency(account.currency) || currencyOfAccount(account.number);
  if (currency !== "" && currency !== "UZS") return "foreign";
  if (/\b(usd|rub|eur|dollar|доллар|рубл|евро)\b/i.test(account.name)) return "foreign";
  if (account.ledger.startsWith("5110") || /основн|асосий|main|расч[её]тн/i.test(account.name)) return "main";
  return "other";
}

async function readAccounts(
  deps: ResolverDeps,
  ownInn: string | undefined,
  gaps: string[],
): Promise<OneCAccount[]> {
  const select = (ledger: boolean) =>
    `ВЫБРАТЬ Т.Ссылка КАК Ссылка, Т.НомерСчета КАК Номер, Т.Наименование КАК Наименование, ` +
    `Т.ВалютаДенежныхСредств.Код КАК Валюта, ${ledger ? "Т.СчетБУ.Код" : '""'} КАК СчетБУ, Т.Владелец.ИНН КАК ИНН ` +
    `ИЗ Справочник.БанковскиеСчета КАК Т ГДЕ НЕ Т.ПометкаУдаления`;
  let outcome = await deps.query({ query: select(true), limit: 500, refs: true });
  if (!outcome.ok) outcome = await deps.query({ query: select(false), limit: 500, refs: true });
  if (!outcome.ok) {
    gaps.push(`the bank accounts catalog could not be read: ${outcome.message}`);
    return [];
  }
  const accounts: OneCAccount[] = [];
  for (const cells of rowsOf(outcome)) {
    const ref = refOf(cells[0]);
    if (!ref) continue;
    // Counterparties' accounts are in the same catalog: only the company's own are wanted.
    if (ownInn && text(cells[5]) && text(cells[5]) !== ownInn) continue;
    const account = {
      ref,
      number: text(cells[1]),
      name: text(cells[2]),
      currency: normalCurrency(text(cells[3])),
      ledger: text(cells[4]),
    };
    accounts.push({ ...account, purpose: purposeOf(account), uses: [] });
  }
  return accounts;
}

async function readUses(deps: ResolverDeps, accounts: OneCAccount[], gaps: string[]): Promise<Kind[]> {
  const byRef = new Map(accounts.map((a) => [a.ref, a]));
  const kinds = new Map<string, Kind>();
  for (const direction of ["out", "in"] as const) {
    const query: RunQueryInput = {
      query:
        `ВЫБРАТЬ Т.БанковскийСчет КАК Счет, Т.ВидОперации КАК Вид, КОЛИЧЕСТВО(*) КАК Количество, ` +
        `МИНИМУМ(Т.Дата) КАК Первый, МАКСИМУМ(Т.Дата) КАК Последний ИЗ ${OBJECT[direction]} КАК Т ` +
        `ГДЕ Т.Проведен И НЕ Т.ПометкаУдаления СГРУППИРОВАТЬ ПО Т.БанковскийСчет, Т.ВидОперации`,
      limit: 1000,
      refs: true,
    };
    const outcome = await deps.query(query);
    if (!outcome.ok) {
      gaps.push(
        `the ${direction === "out" ? "payments out" : "payments in"} documents could not be read: ${outcome.message}`,
      );
      continue;
    }
    for (const cells of rowsOf(outcome)) {
      const kind = text(cells[1]);
      const count = typeof cells[2] === "number" ? cells[2] : Number(cells[2]);
      if (!kind || !Number.isFinite(count)) continue;
      const use: Use = { direction, kind, count, first: day(cells[3]), last: day(cells[4]) };
      const account = byRef.get(refOf(cells[0]) ?? "");
      if (account) account.uses.push(use);
      const key = `${direction}|${kind}`;
      const known = kinds.get(key);
      if (known) {
        known.count += use.count;
        if (use.first && (!known.first || use.first < known.first)) known.first = use.first;
        if (use.last && use.last > known.last) known.last = use.last;
      } else kinds.set(key, { ...use, transfer: TRANSFER_KIND.test(kind) });
    }
  }
  for (const account of accounts) account.uses.sort((a, b) => b.count - a.count);
  return [...kinds.values()].sort((a, b) => b.count - a.count);
}

/** The newest record of the first policy register the configuration has, with its settings by title. */
async function readRecord(deps: ResolverDeps): Promise<PolicyRecord | null> {
  for (const object of POLICY_OBJECTS) {
    const described = await deps.describe([object]);
    if (!described.ok) continue;
    const meta = (described.data as Record<string, unknown>[])[0];
    if (!meta) continue;
    const fields = ["dimensions", "resources", "attributes"]
      .flatMap((group) => (Array.isArray(meta[group]) ? (meta[group] as Record<string, unknown>[]) : []))
      .filter((f): f is { name: string; synonym?: string } => typeof f.name === "string")
      .filter((f) => !PLUMBING.test(f.name))
      .slice(0, MAX_POLICY_FIELDS);
    if (fields.length === 0) continue;
    const select = `ВЫБРАТЬ ПЕРВЫЕ 1 ${fields.map((f, i) => `Т.${f.name} КАК П${i}`).join(", ")} ИЗ ${object} КАК Т`;
    const periodic = object.startsWith("РегистрСведений");
    let outcome = await deps.query({
      query: periodic ? `${select} УПОРЯДОЧИТЬ ПО Т.Период УБЫВ` : select,
      limit: 1,
      refs: true,
    });
    if (!outcome.ok && periodic) outcome = await deps.query({ query: select, limit: 1, refs: true });
    const row = rowsOf(outcome)[0];
    if (!row) continue;
    const values = fields.flatMap((f, i) => {
      const value = text(row[i]);
      return value ? [{ name: f.synonym || f.name, value }] : [];
    });
    if (values.length > 0) return { object, fields: values };
  }
  return null;
}

/** The documents whose use says what the company does: sales, purchases, invoices, money, journal entries, acts. */
const ACTIVITY_OBJECTS = [
  "Документ.РеализацияТоваровУслуг",
  "Документ.ПоступлениеТоваровУслуг",
  "Документ.СчетФактураВыданный",
  "Документ.СчетФактураПолученный",
  "Документ.ПоступлениеНаРасчетныйСчет",
  "Документ.СписаниеСРасчетногоСчета",
  "Документ.ПриходныйКассовыйОрдер",
  "Документ.РасходныйКассовыйОрдер",
  "Документ.АктСверкиВзаиморасчетов",
  "Документ.ОперацияБух",
  "Документ.АвансовыйОтчет",
  "Документ.ПоступлениеОС",
  "Документ.ПереоценкаВалютныхСредств",
  "Документ.ГТДИмпорт",
  "Документ.ПоступлениеДопРасходов",
];

const yearAgo = (): string => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return `${d.toISOString().slice(0, 10)}T00:00:00`;
};

async function readActivity(deps: ResolverDeps): Promise<Activity[]> {
  const since = yearAgo();
  const found = await Promise.all(
    ACTIVITY_OBJECTS.map(async (object): Promise<Activity | null> => {
      // An object this configuration does not have just fails: it is not a gap.
      const outcome = await deps.query({
        query: `ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК Количество, МАКСИМУМ(Т.Дата) КАК Последний ИЗ ${object} КАК Т ГДЕ Т.Проведен И Т.Дата >= &с`,
        params: { с: since },
        limit: 1,
      });
      const row = rowsOf(outcome)[0];
      const count = typeof row?.[0] === "number" ? row[0] : 0;
      return count > 0 ? { object: object.slice(object.indexOf(".") + 1), count, last: day(row?.[1]) } : null;
    }),
  );
  return found.flatMap((a) => (a ? [a] : [])).sort((a, b) => b.count - a.count);
}

/** The account pairs the entries of each kind of document use: the company's own formulas, learned, not guessed. */
async function readPatterns(deps: ResolverDeps, activity: Activity[]): Promise<Pattern[]> {
  const since = yearAgo();
  const found = await Promise.all(
    activity.slice(0, 12).map(async (a): Promise<Pattern | null> => {
      const outcome = await deps.query({
        query:
          "ВЫБРАТЬ ПЕРВЫЕ 6 Т.СчетДт.Код КАК Дт, Т.СчетКт.Код КАК Кт, КОЛИЧЕСТВО(*) КАК Кол ИЗ РегистрБухгалтерии.Хозрасчетный КАК Т " +
          `ГДЕ Т.Период >= &с И Т.Регистратор ССЫЛКА Документ.${a.object} ` +
          "СГРУППИРОВАТЬ ПО Т.СчетДт.Код, Т.СчетКт.Код УПОРЯДОЧИТЬ ПО Кол УБЫВ",
        params: { с: since },
        limit: 6,
      });
      const pairs = rowsOf(outcome).flatMap((cells) => {
        const debit = text(cells[0]);
        const credit = text(cells[1]);
        const count = typeof cells[2] === "number" ? cells[2] : 0;
        return count > 0 ? [{ debit, credit, count }] : [];
      });
      return pairs.length > 0 ? { object: a.object, pairs } : null;
    }),
  );
  return found.flatMap((p) => (p ? [p] : []));
}

async function readPostings(deps: ResolverDeps): Promise<Posting[]> {
  const since = yearAgo();
  const byCode = new Map<string, Posting>();
  for (const side of ["Дт", "Кт"] as const) {
    const outcome = await deps.query({
      query:
        `ВЫБРАТЬ ПЕРВЫЕ 25 Т.Счет${side}.Код КАК Код, КОЛИЧЕСТВО(*) КАК Количество ИЗ РегистрБухгалтерии.Хозрасчетный КАК Т ` +
        `ГДЕ Т.Период >= &с СГРУППИРОВАТЬ ПО Т.Счет${side}.Код УПОРЯДОЧИТЬ ПО Количество УБЫВ`,
      params: { с: since },
      limit: 25,
    });
    for (const cells of rowsOf(outcome)) {
      const code = text(cells[0]);
      const count = typeof cells[1] === "number" ? cells[1] : 0;
      if (!code || count === 0) continue;
      const known = byCode.get(code) ?? { code, debit: 0, credit: 0 };
      if (side === "Дт") known.debit += count;
      else known.credit += count;
      byCode.set(code, known);
    }
  }
  return [...byCode.values()].sort((a, b) => b.debit + b.credit - (a.debit + a.credit)).slice(0, 25);
}

async function readCurrencies(deps: ResolverDeps): Promise<Policy["currencies"]> {
  const outcome = await deps.query({
    query:
      "ВЫБРАТЬ Т.ВалютаВзаиморасчетов.Код КАК Валюта, КОЛИЧЕСТВО(*) КАК Количество ИЗ Справочник.ДоговорыКонтрагентов КАК Т " +
      "ГДЕ НЕ Т.ПометкаУдаления СГРУППИРОВАТЬ ПО Т.ВалютаВзаиморасчетов.Код",
    limit: 20,
  });
  return rowsOf(outcome)
    .flatMap((cells) => {
      const currency = normalCurrency(text(cells[0]));
      const contracts = typeof cells[1] === "number" ? cells[1] : 0;
      return currency && contracts > 0 ? [{ currency, contracts }] : [];
    })
    .sort((a, b) => b.contracts - a.contracts);
}

/** Reads what 1C says about how the company works. Never throws: what cannot be read is listed in `gaps`. */
export async function learnPolicy(deps: ResolverDeps, ownInn?: string): Promise<Policy> {
  const gaps: string[] = [];
  const accounts = await readAccounts(deps, ownInn, gaps);
  const kinds = await readUses(deps, accounts, gaps);
  const [record, activity, postings, currencies] = await Promise.all([
    readRecord(deps).catch(() => null),
    readActivity(deps).catch(() => []),
    readPostings(deps).catch(() => []),
    readCurrencies(deps).catch(() => []),
  ]);
  const patterns = await readPatterns(deps, activity).catch(() => []);
  return { accounts, kinds, activity, postings, patterns, currencies, record, gaps };
}

const HOUR = 3_600_000;

export interface Learned {
  policy: Policy | null;
  /** describePolicy of it, "" when nothing was learned. */
  text: string;
}

/**
 * What was learned, kept for a while per company: reading it takes a score of queries, and it changes slowly.
 * A learning that is under way is shared by whoever asks meanwhile. Never throws; a failed or slow learning
 * gives nothing now (or the earlier one) and is tried again soon.
 */
export class PolicyMemory {
  private readonly kept = new Map<string, { at: number; learned: Learned }>();
  private readonly pending = new Map<string, Promise<Learned>>();

  constructor(
    private readonly ttlMs = 6 * HOUR,
    private readonly waitMs = 20_000,
  ) {}

  async get(key: string, learn: () => Promise<Policy>, force = false): Promise<Learned> {
    const kept = this.kept.get(key);
    if (kept && !force && Date.now() - kept.at < this.ttlMs) return kept.learned;
    let job = this.pending.get(key);
    if (!job) {
      job = learn()
        .then((policy): Learned => {
          const learned = { policy, text: describePolicy(policy) };
          // Nothing learned (the base did not answer): not kept, so the next question tries again.
          if (policy.accounts.length > 0 || policy.activity.length > 0 || policy.postings.length > 0)
            this.kept.set(key, { at: Date.now(), learned });
          return learned;
        })
        .catch((): Learned => ({ policy: null, text: "" }))
        .finally(() => this.pending.delete(key));
      this.pending.set(key, job);
    }
    let timer: NodeJS.Timeout | undefined;
    const slow = new Promise<Learned>((resolve) => {
      timer = setTimeout(() => resolve(kept?.learned ?? { policy: null, text: "" }), this.waitMs);
    });
    try {
      return await Promise.race([job, slow]);
    } finally {
      clearTimeout(timer);
    }
  }
}

const when = (use: { first: string; last: string }) =>
  use.first && use.last ? `${use.first} – ${use.last}` : use.last || use.first || "";

const PURPOSE_NAME: Record<AccountPurpose, string> = {
  main: "main settlement account",
  blocked: "blocked / held-money account",
  foreign: "foreign-currency account",
  other: "account",
};

/** The policy as a few lines for the model: the accounts with their use, the operation kinds, the register. */
export function describePolicy(policy: Policy): string {
  // A base that answered nothing teaches nothing: no text, rather than a list of what could not be read.
  if (
    policy.accounts.length === 0 &&
    policy.kinds.length === 0 &&
    policy.activity.length === 0 &&
    policy.postings.length === 0 &&
    policy.patterns.length === 0 &&
    policy.currencies.length === 0 &&
    !policy.record
  )
    return "";
  const lines = ["How this company's 1C works, learned from its own data (read only):"];
  if (policy.accounts.length > 0) {
    lines.push("Bank accounts of the company in 1C:");
    for (const a of policy.accounts) {
      const used = a.uses
        .slice(0, 4)
        .map((u) => `${u.kind} ${u.direction === "out" ? "out" : "in"} ×${u.count}`)
        .join(", ");
      lines.push(
        `- ${a.number || "?"} «${a.name}» (${a.currency || currencyOfAccount(a.number) || "?"}${a.ledger ? `, ledger ${a.ledger}` : ""}) ${PURPOSE_NAME[a.purpose]}` +
          (used ? `; used for: ${used}` : "; no posted bank documents"),
      );
    }
  }
  const transfers = policy.kinds.filter((k) => k.transfer);
  if (transfers.length > 0) {
    lines.push(
      "Moves between its own accounts and conversions are recorded as: " +
        transfers.map((k) => `«${k.kind}» (${k.direction}, ${k.count} documents, ${when(k)})`).join("; "),
    );
  } else if (policy.kinds.length > 0) {
    lines.push(
      "1C has no posted document of a transfer between the company's own accounts or of a conversion.",
    );
  }
  if (policy.kinds.length > 0) {
    lines.push(
      "Kinds of operation in its bank documents: " +
        policy.kinds
          .slice(0, 12)
          .map((k) => `${k.kind} (${k.direction}) ×${k.count}`)
          .join("; "),
    );
  }
  if (policy.activity.length > 0) {
    lines.push(
      "Documents the company posts (last 12 months): " +
        policy.activity
          .map((a) => `${a.object} ×${a.count}${a.last ? ` (latest ${a.last})` : ""}`)
          .join("; "),
    );
  }
  if (policy.postings.length > 0) {
    lines.push(
      "Ledger accounts its postings use (last 12 months, debit/credit): " +
        policy.postings.map((p) => `${p.code} ${p.debit}/${p.credit}`).join("; "),
    );
  }
  if (policy.patterns.length > 0) {
    lines.push(
      "How its documents are booked, debit→credit ×entries (last 12 months; copy these, do not work the accounts out):",
      ...policy.patterns.map(
        (p) => `- ${p.object}: ${p.pairs.map((x) => `${x.debit}→${x.credit} ×${x.count}`).join("; ")}`,
      ),
    );
  }
  if (policy.currencies.length > 0) {
    lines.push(
      "Currency of its contracts with counterparties: " +
        policy.currencies.map((c) => `${c.currency} ×${c.contracts}`).join(", "),
    );
  }
  if (policy.record) {
    lines.push(
      `Accounting policy (${policy.record.object}): ` +
        policy.record.fields.map((f) => `${f.name} = ${f.value}`).join("; "),
    );
  } else {
    lines.push(
      "No accounting policy register was found by the usual names: the practice above is what the program learned.",
    );
  }
  for (const gap of policy.gaps) lines.push(`Not read: ${gap}.`);
  const text = lines.join("\n");
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text;
}

/**
 * The policy set against what the statements show: each statement's account found among the company's accounts in
 * 1C (a missing one is where an import stops), what the program saw about the transfers and conversions, and whether
 * 1C has ever recorded such money, and as what. Lines the accountant should know, empty when all agrees.
 */
export function reflectOnImport(policy: Policy, plan: LedgerPlan): string[] {
  const lines: string[] = [];
  if (policy.accounts.length === 0) return lines;
  const byNumber = new Map(policy.accounts.map((a) => [a.number, a]));
  for (const view of plan.accounts) {
    if (!view.account) continue;
    const found = byNumber.get(view.account);
    if (!found) {
      lines.push(
        `Account ${view.account} (${view.role}) has no bank account in 1C among the company's: it has to be created there before its payments can be entered.`,
      );
      continue;
    }
    const statementCurrency = view.currency || currencyOfAccount(view.account);
    const oneCCurrency = normalCurrency(found.currency);
    if (statementCurrency && oneCCurrency && statementCurrency !== oneCCurrency) {
      lines.push(
        `Account ${view.account} is in ${statementCurrency} by its number, but 1C keeps it in ${found.currency}: check it.`,
      );
    }
    if (found.purpose === "blocked" && view.role === "settlement") {
      lines.push(
        `Account ${view.account} «${found.name}» is the company's blocked-money account in 1C, yet the statement has ordinary payments in and out: they will be entered as usual.`,
      );
    }
  }
  const mover = plan.transfers.filter((t) => t.kind !== "unattached_own");
  const conversions = plan.transfers.filter((t) => t.kind === "conversion").length;
  const own = mover.length - conversions;
  const recorded = policy.kinds.filter((k) => k.transfer);
  if (own + conversions > 0) {
    if (recorded.length > 0) {
      lines.push(
        `Transfers between the company's own accounts (${own}) and conversions (${conversions}) are not payments to a counterparty: 1C records such money as ` +
          recorded.map((k) => `«${k.kind}»`).join(", ") +
          ". propose_bank_payments enters them as a pair of documents copied from the company's last such document.",
      );
    } else {
      lines.push(
        `Transfers between the company's own accounts (${own}) and conversions (${conversions}) are not entered: 1C has no earlier document of such money, so how the company books it is for the accountant to say.`,
      );
    }
  }
  return lines;
}
