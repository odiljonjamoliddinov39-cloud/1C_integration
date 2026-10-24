/**
 * Which bank account of 1C a number in a statement is. A number is not always one account: a company is often in the
 * counterparties catalog too (its own name and INN, with its own accounts written there), so the same number is in the
 * catalog twice, once as the organization's account and once as a counterparty's, and the owner's INN does not tell them
 * apart. The company's account is the one the organization owns. Nothing is guessed: with two organization accounts of
 * one number, or with the number only under another owner, the answer says so, with the owners.
 */

/** The query's columns after the account itself: the owner's INN and name, and whether the owner is an organization. */
export const ACCOUNT_OWNER_COLUMNS =
  "Т.Владелец.ИНН КАК ИНН, Т.Владелец.Наименование КАК Владелец, ВЫБОР КОГДА ТИПЗНАЧЕНИЯ(Т.Владелец) = ТИП(Справочник.Организации) ТОГДА 1 ИНАЧЕ 0 КОНЕЦ КАК Своя";

export interface AccountCandidate {
  ref: string;
  /** The owner's INN, "" when 1C gave none. */
  inn: string;
  owner: string;
  /** The owner is an organization (null: 1C was not asked or did not say). */
  org: boolean | null;
}

export type AccountPick = { ok: true; ref: string } | { ok: false; why: string };

const digits = (s: string) => s.replace(/\D/g, "");

/** Candidates from the cells of the owner columns (INN, name, organization flag), at `from`. */
export function candidateOf(ref: string, cells: unknown[], from: number): AccountCandidate {
  const text = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
  const flag = cells[from + 2];
  return {
    ref,
    inn: text(cells[from]),
    owner: text(cells[from + 1]),
    org: flag === undefined || flag === null ? null : Number(flag) === 1 || flag === true,
  };
}

const describeOwners = (list: AccountCandidate[]) =>
  list
    .map((c) => `${c.owner || "?"}${c.inn ? ` (INN ${c.inn})` : ""}${c.org ? ", organization" : ""}`)
    .join("; ");

/** The company's account among the accounts of one number. */
export function pickAccount(number: string, found: AccountCandidate[], ownInn?: string): AccountPick {
  if (found.length === 0) return { ok: false, why: `1C has no bank account ${number}` };
  // The organization's own accounts, whoever else lists the number (the company as its own counterparty).
  const organizations = found.filter((c) => c.org === true);
  const pool = organizations.length > 0 ? organizations : found;
  const mine = ownInn
    ? pool.filter((c) => c.inn === "" || digits(c.inn) === digits(ownInn) || c.org === true)
    : pool;
  const [only] = mine;
  if (mine.length === 1 && only) return { ok: true, ref: only.ref };
  if (mine.length === 0)
    return {
      ok: false,
      why: `the account ${number} is in 1C only under another owner: ${describeOwners(found)}. It must be an account of the organization`,
    };
  return {
    ok: false,
    why: `${mine.length} bank accounts of the company have the number ${number} (${describeOwners(mine)}): mark the extra one for deletion in 1C`,
  };
}
