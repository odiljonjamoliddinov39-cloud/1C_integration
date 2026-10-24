/**
 * The beneficiaries of a currency account's SWIFT payments, found in 1C. The statement writes the payment to the bank's
 * own ledger line; the real counterparty is in the text (swift.ts). The bank cuts and wraps the name, so it is looked up
 * in 1C by its first word and recognised by its letters (one's beginning the other's); the payment then carries 1C's own
 * spelling of the name, and everything the resolver does by name (the counterparty, its contracts, its accounts) finds it.
 * A beneficiary 1C does not have keeps the bank's spelling and is offered for creation like any new counterparty.
 */
import { lookup, textOf } from "../didox/resolve.js";
import type { BankDeps } from "./resolve.js";
import type { BankStatement } from "./statement.js";
import { type ForeignPayee, sameForeignName, squashName, withForeignPayees } from "./swift.js";

export interface PayeeMatch {
  statement: BankStatement;
  /** Beneficiaries written to counterparties 1C has, and those it has not. */
  found: number;
  unknown: string[];
  /** Beneficiaries that several of 1C's counterparties could be: left as the bank wrote them. */
  ambiguous: { name: string; candidates: string[] }[];
}

/** The first word of a name long enough to look for. */
const firstWord = (name: string) => name.match(/[\p{L}\d]{4,}/u)?.[0] ?? "";

export async function matchPayees(deps: BankDeps, statement: BankStatement): Promise<PayeeMatch> {
  const { statement: moved, payees } = withForeignPayees(statement);
  if (payees.size === 0) return { statement, found: 0, unknown: [], ambiguous: [] };
  const names = new Map<string, ForeignPayee>();
  for (const payee of payees.values()) names.set(squashName(payee.name), payee);

  const spelling = new Map<string, string>();
  const unknown: string[] = [];
  const ambiguous: PayeeMatch["ambiguous"] = [];
  for (const [key, payee] of names) {
    const word = firstWord(payee.name);
    const rows = word
      ? await lookup(
          deps,
          (ph) =>
            `ВЫБРАТЬ Т.Наименование КАК Наименование ИЗ Справочник.Контрагенты КАК Т ГДЕ Т.Наименование ПОДОБНО ${ph.split(",")[0]} И НЕ Т.ПометкаУдаления`,
          [`%${word}%`],
        )
      : null;
    const candidates = [
      ...new Set(
        (rows ?? []).map(({ cells }) => textOf(cells[0])).filter((n) => sameForeignName(payee.name, n)),
      ),
    ];
    const [only] = candidates;
    if (candidates.length === 1 && only) spelling.set(key, only);
    else if (candidates.length > 1) ambiguous.push({ name: payee.name, candidates });
    else unknown.push(payee.name);
  }
  const payments = moved.payments.map((p) => {
    const payee = payees.get(p.row);
    const exact = payee ? spelling.get(squashName(payee.name)) : undefined;
    return exact ? { ...p, counterparty: exact } : p;
  });
  return {
    statement: { ...moved, payments },
    found: [...payees.values()].filter((p) => spelling.has(squashName(p.name))).length,
    unknown,
    ambiguous,
  };
}
