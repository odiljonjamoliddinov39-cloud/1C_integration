/**
 * What the money is, and what 1C should be told to do with it. A bank statement line is a case (a bank fee, a move between
 * the company's own accounts, the paying or the receiving leg of a conversion, a payment to the budget…); what 1C is told is
 * an operation of the bank document and the account its other side is booked to. Neither is a fixed phrase of this program:
 * they are worked out in this order, and the source of the answer goes into the note beside the document.
 *
 *   1. the accountant's decision for the case (kept per company, `set_operation` of the bank_mapping tool);
 *   2. the company's own books: of the operations its posted bank documents carry, the one whose entries are the entries the
 *      case needs (an own-bank account on one side, the right kind of account on the other: families below), the most used;
 *   3. the meaning of the operation's name among the values 1C has, in the languages the configurations use;
 *   4. nothing fits: no document is made, and the card says which operations 1C has and what each posted, so the
 *      accountant can name one (and the program keeps the answer).
 *
 * An operation the program has seen post the wrong entries (verify.ts) is not chosen again for that case, whatever the
 * company's earlier documents say: a document written by a program is not a document written on a form.
 */
import { refOf, textOf } from "../didox/resolve.js";
import type { BuildKind } from "./build.js";
import type { BankCache, BankDeps } from "./resolve.js";
import type { EnumValue } from "./scaffold.js";

/** The kind of account a ledger code is, by its group (the chart of accounts of Uzbekistan; the same groups in the Russian one). */
export type Family =
  "cash" | "bank" | "transit" | "customer" | "supplier" | "tax" | "capital" | "expense" | "other";

export function familyOf(code: string): Family {
  const digits = code.replace(/\D/g, "");
  const group = digits.slice(0, 2);
  if (group === "50") return "cash";
  if (group === "51" || group === "52" || group === "55") return "bank";
  if (group === "57") return "transit";
  if (group === "40") return "customer";
  if (group === "60") return "supplier";
  if (group === "44" || group === "64" || group === "65") return "tax";
  if (group === "83") return "capital";
  if (digits.startsWith("9")) return "expense";
  return "other";
}

/** What the entries of a case look like: the company's own bank account on `own` side, one of `other` on the other. */
interface Expectation {
  own: "debit" | "credit";
  other: Family[];
}

/** For checking what was posted: a move may also go straight between two bank accounts (the form's «Перевод…»). */
export const EXPECTED: Record<BuildKind, Expectation> = {
  fee: { own: "credit", other: ["expense"] },
  transferOut: { own: "credit", other: ["transit", "bank"] },
  transferIn: { own: "debit", other: ["transit", "bank"] },
  conversionOut: { own: "credit", other: ["transit", "bank"] },
  conversionIn: { own: "debit", other: ["transit", "bank"] },
  tax: { own: "credit", other: ["tax", "supplier"] },
  cashIn: { own: "debit", other: ["cash"] },
  cashOut: { own: "credit", other: ["cash"] },
  capital: { own: "debit", other: ["capital"] },
};

/** For making a document from 1C's description: the header's account is the other side, so it must be one account, not a bank's. */
const BUILT_OTHER: Partial<Record<BuildKind, Family[]>> = {
  transferOut: ["transit"],
  transferIn: ["transit"],
  conversionOut: ["transit"],
  conversionIn: ["transit"],
};

export interface Pair {
  debit: string;
  credit: string;
  count: number;
}

/** Whether an entry (a pair of accounts) is what the case needs. */
export function fits(kind: BuildKind, pair: { debit: string; credit: string }, others?: Family[]): boolean {
  const want = EXPECTED[kind];
  const own = want.own === "debit" ? pair.debit : pair.credit;
  const other = want.own === "debit" ? pair.credit : pair.debit;
  return familyOf(own) === "bank" && (others ?? want.other).includes(familyOf(other));
}

export interface OperationProfile {
  /** The operation as 1C shows it. */
  operation: string;
  ref: string;
  /** The enumeration the operation is a value of ("Перечисление.ВидыОперацийСписания"), for writing it in a query. */
  type: string;
  pairs: Pair[];
  total: number;
}

/** What the company has decided or what a check found, kept per company (store.ts). */
export interface OperationMemory {
  choices: { case: string; operation: string }[];
  verdicts: { key: string; case: string; operation: string; good: number; bad: number; lastBad?: string }[];
}

export const EMPTY_MEMORY: OperationMemory = { choices: [], verdicts: [] };

export const verdictKey = (object: string, kind: string, operation: string) =>
  `${object}|${kind}|${operation.trim().toLowerCase()}`;

const yearsAgo = (n: number): string => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return `${d.toISOString().slice(0, 10)}T00:00:00`;
};

/**
 * What each operation of a bank document has posted in this company (two years): the pairs of accounts, grouped. Null when
 * 1C does not answer (a configuration without the join, an object it does not have): the choice then goes by meaning.
 */
export async function operationProfiles(
  deps: BankDeps,
  cache: BankCache,
  object: string,
): Promise<OperationProfile[] | null> {
  const known = (cache.profiles ??= new Map());
  if (known.has(object)) return known.get(object) ?? null;
  const outcome = await deps.query({
    query:
      "ВЫБРАТЬ Д.ВидОперации КАК Вид, Т.СчетДт.Код КАК Дт, Т.СчетКт.Код КАК Кт, КОЛИЧЕСТВО(*) КАК Количество " +
      `ИЗ РегистрБухгалтерии.Хозрасчетный КАК Т ВНУТРЕННЕЕ СОЕДИНЕНИЕ ${object} КАК Д ПО Т.Регистратор = Д.Ссылка ` +
      "ГДЕ Т.Период >= &с И Т.Активность И Д.Проведен " +
      "СГРУППИРОВАТЬ ПО Д.ВидОперации, Т.СчетДт.Код, Т.СчетКт.Код",
    params: { с: yearsAgo(2) },
    limit: 1000,
    refs: true,
  });
  if (!outcome.ok) {
    known.set(object, null);
    return null;
  }
  const byOperation = new Map<string, OperationProfile>();
  for (const cells of (outcome.data as { rows?: unknown[][] }).rows ?? []) {
    const ref = refOf(cells[0]);
    const operation = textOf(cells[0]);
    const count = typeof cells[3] === "number" ? cells[3] : 0;
    if (!ref || !operation || count <= 0) continue;
    const type = (cells[0] as { type?: unknown } | undefined)?.type;
    const profile = byOperation.get(ref) ?? {
      operation,
      ref,
      type: typeof type === "string" ? type : "",
      pairs: [],
      total: 0,
    };
    profile.pairs.push({ debit: String(cells[1] ?? ""), credit: String(cells[2] ?? ""), count });
    profile.total += count;
    byOperation.set(ref, profile);
  }
  const list = [...byOperation.values()].map((p) => ({
    ...p,
    pairs: p.pairs.sort((a, b) => b.count - a.count),
  }));
  known.set(object, list);
  return list;
}

/** The meaning of an operation's name for a case, in the languages the configurations use: a score, or null when it cannot be it. */
const MEANING: Record<BuildKind, { yes: [RegExp, number][]; no: RegExp[] }> = {
  fee: {
    yes: [
      [/проч\p{L}*\s*списан|boshqa\s+chiqim|бошқа\s+чиқим/iu, 3],
      [/комисси|услуг\p{L}*\s+банк|xizmat/iu, 2],
    ],
    no: [/перевод|конверт|валют|налог|взнос|снят|наличн|оплата|возврат|займ|кредит/iu],
  },
  transferOut: {
    yes: [
      [/проч\p{L}*\s*списан|boshqa\s+chiqim|бошқа\s+чиқим/iu, 3],
      [/перевод\s+на\s+друг|boshqa\s+(?:hisob|xisob)\p{L}*\s+o['ʻ’]?tkaz|бошқа\s+ҳисоб/iu, 2],
    ],
    no: [/конверт|валют|налог|взнос|снят|наличн|оплата|возврат|займ|кредит|комисси|продаж|покупк/iu],
  },
  transferIn: {
    yes: [
      [/проч\p{L}*\s*поступлен|boshqa\s+kirim|бошқа\s+кирим/iu, 3],
      [/перевод\s+с\s+друг|boshqa\s+(?:hisob|xisob)dan|бошқа\s+ҳисобдан/iu, 2],
    ],
    no: [/конверт|валют|налог|взнос|наличн|оплата|возврат|займ|кредит|продаж|покупк|эквайринг|взнос/iu],
  },
  conversionOut: {
    yes: [
      [/проч\p{L}*\s*списан|boshqa\s+chiqim|бошқа\s+чиқим/iu, 3],
      [/валют/iu, 2],
    ],
    no: [/налог|взнос|наличн|оплата|возврат|займ|кредит|комисси/iu],
  },
  conversionIn: {
    yes: [
      [/приобретен\p{L}*\s+(?:иностранн\p{L}*\s+)?валют|xorijiy\s+valyuta\s+(?:xarid|sotib)/iu, 5],
      [/покупк\p{L}*\s+валют|продаж\p{L}*\s+(?:иностранн\p{L}*\s+)?валют/iu, 4],
      [/проч\p{L}*\s*поступлен|boshqa\s+kirim|бошқа\s+кирим/iu, 2],
      [/перевод\s+с\s+друг/iu, 1],
    ],
    no: [/налог|взнос|наличн|оплата|возврат|займ|кредит|эквайринг/iu],
  },
  tax: {
    yes: [
      [/^\s*уплата\s+налог\p{L}*\s*$/iu, 5],
      [/уплата\s+налог|soliq\s+to['ʻ’]?lov|солиқ/iu, 3],
    ],
    no: [/третьих/iu],
  },
  cashIn: {
    yes: [[/взнос\s+наличн|внесение\s+наличн|поступлен\p{L}*\s+наличн|naqd\s+pul\s+kirim/iu, 4]],
    no: [],
  },
  cashOut: {
    yes: [[/снятие\s+наличн|получение\s+наличн|выдача\s+наличн|naqd\s+pul\s+chiqim/iu, 4]],
    no: [],
  },
  capital: {
    yes: [
      [/(?:взнос|вклад)\s+(?:учредител|в\s+уставн)|ustav\s+kapital/iu, 4],
      [/проч\p{L}*\s*поступлен/iu, 1],
    ],
    no: [],
  },
};

/**
 * `variant` tells a purchase of currency from a sale for the receiving leg of a conversion: the receipt of a purchase is
 * «Приобретение иностранной валюты», the receipt of a sale is not.
 */
export function meaningOf(kind: BuildKind, name: string, variant?: "buy" | "sell"): number | null {
  const m = MEANING[kind];
  if (m.no.some((re) => re.test(name))) return null;
  if (kind === "conversionIn" && variant === "buy" && /продаж/iu.test(name)) return null;
  if (kind === "conversionIn" && variant === "sell" && /приобретен|покупк|xarid/iu.test(name)) return null;
  const score = m.yes.reduce((best, [re, w]) => (re.test(name) ? Math.max(best, w) : best), 0);
  return score > 0 ? score : null;
}

export type Choice =
  | { ok: true; value: EnumValue; source: "accountant" | "history" | "meaning"; why: string; pairs: Pair[] }
  | { ok: false; why: string; known: string[] };

/** The operations of a move that a form fills with the other account (no header account to book through). */
const FORM_OPERATION = /перевод\s+(?:на|с)\s+друг|boshqa\s+(?:hisob|xisob)/iu;

const squash = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");

/** Whether the program has seen this operation post wrong entries for this case. */
export function avoided(
  memory: OperationMemory,
  object: string,
  kind: BuildKind,
  operation: string,
): boolean {
  const v = memory.verdicts.find((x) => x.key === verdictKey(object, kind, operation));
  return !!v && v.bad > 0 && v.bad >= v.good;
}

/** The operation to write, and where the choice came from. */
export function chooseOperation(input: {
  kind: BuildKind;
  variant?: "buy" | "sell";
  object: string;
  values: EnumValue[];
  profiles: OperationProfile[] | null;
  memory: OperationMemory;
}): Choice {
  const { kind, variant, object, values, profiles, memory } = input;
  const profileOf = (v: EnumValue) =>
    profiles?.find((p) => p.ref === v.ref || squash(p.operation) === squash(v.name)) ?? null;
  const fitting = (v: EnumValue) =>
    (profileOf(v)?.pairs ?? []).filter((p) => fits(kind, p, BUILT_OTHER[kind]));

  // 1. The accountant's decision.
  const decided = memory.choices.find((c) => c.case === kind);
  if (decided) {
    const value = values.find((v) => squash(v.name) === squash(decided.operation));
    if (value)
      return {
        ok: true,
        value,
        source: "accountant",
        why: "the accountant's decision",
        pairs: fitting(value),
      };
  }

  // 2 and 3. The company's books and the meaning of the name, together: what the books show is weighed above a name.
  const scored = values.flatMap((v) => {
    if (avoided(memory, object, kind, v.name)) return [];
    const meaning = meaningOf(kind, v.name, variant);
    const pairs = fitting(v);
    const used = pairs.reduce((n, p) => n + p.count, 0);
    // An operation of a form (the move's own «Перевод на другой счет») needs fields this program does not fill; made from the
    // description it posts to the wrong account. It is taken only when the company's books show it posting through the transit.
    if (BUILT_OTHER[kind] && FORM_OPERATION.test(v.name) && used === 0) return [];
    if (meaning === null && used === 0) return [];
    const score = (meaning ?? 0) * 10 + (used > 0 ? 5 + Math.log2(used + 1) : 0);
    return [{ value: v, meaning, pairs, used, score }];
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best) {
    const books =
      best.used > 0 ? `the company's ${best.used} posted entries of this operation are such a move` : null;
    return {
      ok: true,
      value: best.value,
      source: best.used > 0 ? "history" : "meaning",
      why: books ?? `the name of the operation says so (the company has no posted document of it to show)`,
      pairs: best.pairs,
    };
  }
  return {
    ok: false,
    why: `none of the operations of 1C is known to do this (${kind})`,
    known: values.map((v) => {
      const p = profileOf(v);
      const top = p?.pairs[0];
      return top ? `${v.name} (Dt ${top.debit} / Kt ${top.credit}, ${p?.total})` : v.name;
    }),
  };
}

/**
 * The account the other side of a move is booked to, from what the company's own documents of the chosen operation posted
 * (the most used pair that is such a move); null when the books say nothing, and the caller's prior is then tried.
 */
export function counterAccountFrom(kind: BuildKind, pairs: Pair[]): string | null {
  const want = EXPECTED[kind];
  const counts = new Map<string, number>();
  for (const p of pairs) {
    if (!fits(kind, p, BUILT_OTHER[kind])) continue;
    const other = want.own === "debit" ? p.credit : p.debit;
    counts.set(other, (counts.get(other) ?? 0) + p.count);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * An operation the company's books show doing this case and nothing else (nine entries in ten are such a move), when the
 * operation cannot be made from 1C's description: its own earlier document is then the one to copy. Null when there is none.
 */
export function specificOperation(
  kind: BuildKind,
  object: string,
  profiles: OperationProfile[] | null,
  memory: OperationMemory,
): OperationProfile | null {
  const found = (profiles ?? []).filter((p) => {
    if (p.total < 1 || avoided(memory, object, kind, p.operation)) return false;
    const fitting = p.pairs.filter((x) => fits(kind, x)).reduce((n, x) => n + x.count, 0);
    return fitting / p.total >= 0.9;
  });
  return found.sort((a, b) => b.total - a.total)[0] ?? null;
}
