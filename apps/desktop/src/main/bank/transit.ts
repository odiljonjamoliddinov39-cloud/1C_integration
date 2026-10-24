/**
 * Payments the statement writes to one of the bank's own transit accounts, with the real payee in the text:
 *
 *   «транзитный счет для зач на ПК физ лиц налич ср-в» … «Оплата по договору TI-FB-05 от 18.12.2024г с Qodirov Farruh
 *   Bozorovich на поставку …»   money to an individual (an entrepreneur) by his card: the payee is the person;
 *   «Транзитный счёт МУНИС для юридических лиц» … «Оплата таможенных пошлин …»   money to the customs: the payee is the
 *   customs, which the company's 1C already has as a counterparty (a payment to a government body goes only to a
 *   counterparty already in the base; none is made up).
 *
 * The bank's INN and its transit account are the bank's bookkeeping, not the company's counterparty, so the row is
 * written to the real payee instead, as the resolver then treats any payment (the counterparty, its contract named in the
 * text, the earlier documents to copy). The person is found among the counterparties 1C has by his letters (an entrepreneur
 * is «ИП»/«YTT» in one place and bare in another), or taken from his other rows in the attached statements; a person 1C
 * lacks keeps the spelling of the text and is offered for creation like any new counterparty.
 */
import { lookup, textOf } from "../didox/resolve.js";
import type { BankDeps } from "./resolve.js";
import type { BankPayment, BankStatement } from "./statement.js";
import { squashName } from "./swift.js";

/** The bank's transit account for money credited to an individual's card. */
export const PERSON_TRANSIT = /транзитн\p{L}*\s+сч[её]т\s+для\s+зач/iu;

/** The bank's transit account for the customs payment system, and what the purpose of such a payment says. */
export const CUSTOMS_TRANSIT = /мунис|munis/iu;
const CUSTOMS_PURPOSE = /таможенн\p{L}*\s+(?:пошлин|платеж|сбор)|bojxona|божхона/iu;

/** The names of a customs office as 1C may spell them: the counterparty is looked up by any of these words. */
const CUSTOMS_WORDS = ["таможен", "божхон", "bojxona", "customs"];

/** A word of a name: a capital letter, then letters (a name is written Capitalised or in capitals). */
const WORD = "\\p{Lu}[\\p{L}'ʻ’`-]{2,}";
const PERSON = new RegExp(
  `(?:(?<![\\p{L}])(?:[Сс]|[Оо]плата|[Оо]т|[Дд]ля|[Кк]ому)|\\bto)\\s+(${WORD}(?:\\s+${WORD}){1,3})(?=\\s+(?:по|на|за|согласно|от|договор\\p{L}*)(?![\\p{L}])|[.,;]|$)`,
  "u",
);

/** The person a payment through the transit account names ("… с Qodirov Farruh Bozorovich на поставку …"), or null. */
export function personIn(purpose: string): string | null {
  return PERSON.exec(purpose.replace(/\s+/g, " "))?.[1] ?? null;
}

/** An entrepreneur is written with a legal-form word in front in one place and without it in another. */
const FORM = /^(?:y\.?\s?t\.?\s?t\.?|я\.?\s?т\.?\s?т\.?|и\.?\s?п\.?|yatt|ip)\s+/iu;
export const personKey = (name: string) => squashName(name.trim().replace(FORM, ""));
/** A payer written as an individual entrepreneur ("YTT …", "ИП …"): a person who is in business, created like a counterparty. */
export const isEntrepreneur = (name: string) => FORM.test(name.trim());

export interface TransitResult {
  statement: BankStatement;
  /** Individuals the payments are written to: found among 1C's counterparties, and those 1C lacks. */
  persons: { found: number; unknown: string[]; rows: number };
  /** Customs payments: written to 1C's customs counterparty; "none" or "several" when 1C cannot say which. */
  customs: { rows: number; counterparty: string | null; problem: string | null };
}

const surname = (name: string) => name.match(/[\p{L}\d]{4,}/u)?.[0] ?? "";

async function oneCNames(deps: BankDeps, word: string): Promise<string[]> {
  if (!word) return [];
  const rows = await lookup(
    deps,
    (ph) =>
      `ВЫБРАТЬ Т.Наименование КАК Наименование ИЗ Справочник.Контрагенты КАК Т ГДЕ Т.Наименование ПОДОБНО ${ph.split(",")[0]} И НЕ Т.ПометкаУдаления`,
    [`%${word}%`],
  );
  return [...new Set((rows ?? []).map(({ cells }) => textOf(cells[0])).filter(Boolean))];
}

export async function matchTransit(
  deps: BankDeps,
  statement: BankStatement,
  all: BankStatement[],
): Promise<TransitResult> {
  const none: TransitResult = {
    statement,
    persons: { found: 0, unknown: [], rows: 0 },
    customs: { rows: 0, counterparty: null, problem: null },
  };
  const personRows = new Map<number, string>();
  const customsRows = new Set<number>();
  for (const p of statement.payments) {
    if (p.direction !== "out") continue;
    if (PERSON_TRANSIT.test(p.counterparty)) {
      const person = personIn(p.purpose);
      if (person) personRows.set(p.row, person);
    } else if (
      CUSTOMS_TRANSIT.test(p.counterparty) ||
      (CUSTOMS_PURPOSE.test(p.purpose) && /транзит/iu.test(p.counterparty))
    ) {
      customsRows.add(p.row);
    }
  }
  if (personRows.size === 0 && customsRows.size === 0) return none;

  // The people the other rows of the attached statements name, with the INN the bank wrote for them.
  const known = new Map<string, { name: string; inn: string }>();
  for (const s of all)
    for (const p of s.payments) {
      if (!p.inn || PERSON_TRANSIT.test(p.counterparty) || CUSTOMS_TRANSIT.test(p.counterparty)) continue;
      const key = personKey(p.counterparty);
      if (key.length >= 10 && !known.has(key)) known.set(key, { name: p.counterparty.trim(), inn: p.inn });
    }

  // Each person among 1C's counterparties, by his letters.
  const spelled = new Map<string, string | null>();
  const unknown: string[] = [];
  const people = new Map([...personRows.values()].map((person) => [personKey(person), person]));
  for (const [key, person] of people) {
    const candidates = (await oneCNames(deps, surname(person))).filter((n) => personKey(n) === key);
    const [only] = candidates;
    spelled.set(key, candidates.length === 1 && only ? only : null);
    if (candidates.length !== 1) unknown.push(person);
  }

  let customs: TransitResult["customs"] = { rows: customsRows.size, counterparty: null, problem: null };
  if (customsRows.size > 0) {
    const names = new Set<string>();
    for (const word of CUSTOMS_WORDS) for (const n of await oneCNames(deps, word)) names.add(n);
    const [only] = [...names];
    customs =
      names.size === 1 && only
        ? { rows: customsRows.size, counterparty: only, problem: null }
        : {
            rows: customsRows.size,
            counterparty: null,
            problem:
              names.size === 0
                ? "1C has no counterparty for the customs: a payment to a government body goes only to a counterparty already in the base, so none is made up (add the customs as a counterparty, then run again)"
                : `${names.size} counterparties of 1C could be the customs (${[...names].slice(0, 4).join(", ")}): the accountant says which`,
          };
  }

  const payments = statement.payments.map((p): BankPayment => {
    const person = personRows.get(p.row);
    if (person) {
      const key = personKey(person);
      const inOneC = spelled.get(key) ?? null;
      const other = known.get(key);
      // 9 digits is a tax number 1C finds; a person's 14 digits are not written in the base, the name is.
      const inn = other && other.inn.length === 9 && !inOneC ? other.inn : "";
      const name = inOneC ?? other?.name ?? person;
      const { innZero: _drop, ...rest } = p;
      void _drop;
      return inn
        ? { ...rest, counterparty: name, inn }
        : { ...rest, counterparty: name, inn: "", innZero: true };
    }
    if (customsRows.has(p.row) && customs.counterparty) {
      const { innZero: _drop, ...rest } = p;
      void _drop;
      return { ...rest, counterparty: customs.counterparty, inn: "", innZero: true };
    }
    return p;
  });
  return {
    statement: { ...statement, payments },
    persons: {
      found: [...personRows.values()].filter((person) => spelled.get(personKey(person))).length,
      unknown,
      rows: personRows.size,
    },
    customs,
  };
}
