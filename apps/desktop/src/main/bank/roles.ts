/**
 * Which attribute of a bank document holds what. Configurations name them differently («БанковскийСчет» in one,
 * «СчетОрганизации» in the Uzbek one), and a program that assumes one name writes documents with no bank account in
 * the other: the posting then fails with "debit account not filled" on a hundred documents. The names are read from
 * the document itself (a copied document's own fields, or 1C's description of the object), never assumed.
 */
import type { BankCache, BankDeps } from "./resolve.js";

/** Names under which a configuration keeps the company's own bank account on a bank document, the usual first. */
export const OWN_ACCOUNT_NAMES = [
  "БанковскийСчет",
  "СчетОрганизации",
  "БанковскийСчетОрганизации",
  "РасчетныйСчет",
  "СчетОрганизацииОтправитель",
];

/** Names of the counterparty's bank account on a payment. */
export const THEIR_ACCOUNT_NAMES = ["СчетКонтрагента", "БанковскийСчетКонтрагента", "СчетПолучателя"];

const BANK_ACCOUNT_TYPE = "Справочник.БанковскиеСчета";

/** An attribute that names the other side's account, never the company's. */
const OTHER_SIDE = /Контрагент|Получател|Отправител|Корреспондент|Партнер/iu;

/** The company's own bank account among a document's fields (as read from 1C), or null. */
export function ownAccountKey(fields: Record<string, unknown>): string | null {
  const named = OWN_ACCOUNT_NAMES.find((name) => name in fields);
  if (named) return named;
  for (const [name, value] of Object.entries(fields)) {
    if (OTHER_SIDE.test(name)) continue;
    if (value && typeof value === "object" && (value as { type?: unknown }).type === BANK_ACCOUNT_TYPE)
      return name;
  }
  return null;
}

/** The company's own bank account among the attributes 1C describes ({name, types}), or null. */
export function ownAccountOf(attributes: { name: string; types: string[] }[]): string | null {
  const accounts = attributes.filter((a) => a.types.includes(BANK_ACCOUNT_TYPE));
  const named = OWN_ACCOUNT_NAMES.find((name) => attributes.some((a) => a.name === name));
  if (named) return named;
  const own = accounts.filter((a) => !OTHER_SIDE.test(a.name));
  return own.length === 1
    ? (own[0]?.name ?? null)
    : (own.find((a) => /Организаци/iu.test(a.name))?.name ?? null);
}

/**
 * The attribute of a document that holds the company's own bank account, from 1C's description of the object (read
 * once). When 1C cannot describe it, the usual name, so that a base the program already worked with keeps working.
 */
export async function ownAccountAttribute(
  deps: Pick<BankDeps, "describe">,
  cache: { roles?: BankCache["roles"] },
  object: string,
): Promise<string> {
  cache.roles ??= new Map();
  const known = cache.roles.get(object);
  if (known) return known;
  let found: string | null = null;
  const outcome = await deps.describe([object]);
  if (outcome.ok) {
    const described = (outcome.data as { attributes?: { name: string; types?: string[] }[] }[])[0];
    found = ownAccountOf((described?.attributes ?? []).map((a) => ({ name: a.name, types: a.types ?? [] })));
  }
  const name = found ?? OWN_ACCOUNT_NAMES[0] ?? "БанковскийСчет";
  if (found) cache.roles.set(object, name);
  return name;
}
