/**
 * The ledger account of a bank account. A bank document has an attribute for it («Счет учета» on the form, «СчетБанк» in the
 * Uzbek configuration: 5110 for the settlement account, 5530 for the account of blocked funds, 5210 for a currency one) and 1C
 * posts the bank's side of the entry to it. A form fills it from the bank account's own card; a document written without the
 * form does not, and 1C then books every account to the default one: the blocked-funds account stays empty and the settlement
 * account takes its money. So every bank document the program makes gets the ledger account of the bank account it is on, read
 * from that account's card in 1C; an account whose card names none is said, never guessed.
 */
import { refOf } from "../didox/resolve.js";
import type { ChangeInput } from "@platform/shared";
import { OBJECT } from "./resolve.js";
import type { BankCache, BankDeps } from "./resolve.js";
import { ownAccountKey } from "./roles.js";
import { describeCached, newScaffoldCache } from "./scaffold.js";

const BANK_ACCOUNTS = "Справочник.БанковскиеСчета";
const CHART = "ПланСчетов.Хозрасчетный";

/** The attribute of a bank document that holds the bank's ledger account, by the names the configurations use. */
export function documentLedgerAttribute(attributes: { name: string; types: string[] }[]): string | null {
  const charted = attributes.filter((a) => a.types.some((t) => t.startsWith("ПланСчетов")));
  for (const name of ["СчетБанк", "СчетУчетаБанка", "СчетУчетаДенежныхСредств", "БанковскийСчетУчета"]) {
    if (charted.some((a) => a.name === name)) return name;
  }
  // «Счет учета» of a document that has no settlement account of its own in it.
  return charted.find((a) => a.name === "СчетУчета")?.name ?? null;
}

/** The attribute of the bank account's card that holds its ledger account. */
export function cardLedgerAttribute(attributes: { name: string; types: string[] }[]): string | null {
  const charted = attributes.filter((a) => a.types.some((t) => t.startsWith("ПланСчетов")));
  const named = charted.find((a) => /^Счет(Учета|Банк|Бух\p{L}*)?$|СчетУчета/iu.test(a.name));
  return named?.name ?? (charted.length === 1 ? (charted[0]?.name ?? null) : null);
}

export interface LedgerAccounts {
  /** A bank account of 1C (its reference) → the reference of its ledger account, null when its card names none. */
  byAccount: Map<string, string | null>;
  /** The same by the number of the account: its reference and its ledger account. */
  byNumber: Map<string, { ref: string; ledger: string | null }>;
  /** Why the accounts could not be read, when they could not. */
  why: string | null;
}

/** The ledger accounts of every bank account of 1C, read once. */
export async function ledgerAccounts(deps: BankDeps, cache: BankCache): Promise<LedgerAccounts> {
  const sc = (cache.scaffold ??= newScaffoldCache());
  if (sc.ledgerAccounts) return sc.ledgerAccounts;
  const result: LedgerAccounts = { byAccount: new Map(), byNumber: new Map(), why: null };
  const described = await describeCached(deps, sc, BANK_ACCOUNTS);
  const attribute = described ? cardLedgerAttribute(described.attributes) : null;
  if (!attribute) {
    result.why = `the card of a bank account in 1C has no attribute for its ledger account`;
  } else {
    const outcome = await deps.query({
      query: `ВЫБРАТЬ Т.Ссылка КАК Ссылка, Т.${attribute} КАК Счет, Т.НомерСчета КАК Номер ИЗ ${BANK_ACCOUNTS} КАК Т ГДЕ НЕ Т.ПометкаУдаления`,
      limit: 1000,
      refs: true,
    });
    if (!outcome.ok) result.why = `the ledger accounts of the bank accounts could not be read from 1C`;
    else
      for (const cells of (outcome.data as { rows?: unknown[][] }).rows ?? []) {
        const ref = refOf(cells[0]);
        if (!ref) continue;
        const ledger = refOf(cells[1]);
        result.byAccount.set(ref, ledger);
        const number = String(cells[2] ?? "").replace(/\D/g, "");
        if (number) result.byNumber.set(number, { ref, ledger });
      }
  }
  sc.ledgerAccounts = result;
  return result;
}

/**
 * The bank's ledger account on a bank document the program made: the one of the bank account the document is on. Notes what
 * could not be done (an account whose card names none, a document with no place for it).
 */
export async function setBankLedgerAccount(
  deps: BankDeps,
  cache: BankCache,
  change: ChangeInput,
): Promise<string[]> {
  if (change.action !== "create" && change.action !== "update") return [];
  if (change.object !== OBJECT.in && change.object !== OBJECT.out) return [];
  const fields = change.fields ?? {};
  const own = ownAccountKey(fields);
  const account = own ? refOf(fields[own]) : null;
  if (!account) return [];
  const sc = (cache.scaffold ??= newScaffoldCache());
  const described = await describeCached(deps, sc, change.object);
  const attribute = described ? documentLedgerAttribute(described.attributes) : null;
  if (!attribute) return [];
  const ledger = await ledgerAccounts(deps, cache);
  if (!ledger.byAccount.has(account)) return ledger.why ? [`bank ledger account: ${ledger.why}`] : [];
  const ref = ledger.byAccount.get(account);
  if (!ref) {
    return [
      `the bank account of this document has no ledger account on its card in 1C: the document keeps the default (usually 5110); give the account its ledger account (5530 for blocked funds, 5210 for a currency account)`,
    ];
  }
  change.fields = { ...fields, [attribute]: { type: CHART, ref } };
  return [];
}
