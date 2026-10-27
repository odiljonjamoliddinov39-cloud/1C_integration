/**
 * Whose statement it is. A statement is an Excel file with no header that names the company, but the company's own
 * accounts appear in each other's statements as the counterparty (a fee to the bank's fee account, a block for a
 * conversion), and those lines carry the company's own INN. So an import started in another company than the
 * statement's is seen before anything is read, whichever company is selected and however many companies there are.
 */
import type { BankStatement } from "./statement.js";

export interface OwnerMismatch {
  file: string;
  /** The INN the statement's own-account lines carry, and how many lines say so. */
  statementInn: string;
  lines: number;
}

/** The INN of each statement's owner, from the lines whose other side is one of the attached statements' accounts. */
export function statementOwners(statements: BankStatement[]): Map<string, { inn: string; lines: number }> {
  const accounts = new Set(statements.map((s) => s.account).filter(Boolean));
  const owners = new Map<string, { inn: string; lines: number }>();
  for (const statement of statements) {
    const counts = new Map<string, number>();
    for (const p of statement.payments) {
      if (!p.account || p.account === statement.account || !accounts.has(p.account)) continue;
      if (!/^\d{9}$/.test(p.inn) || /^0+$/.test(p.inn)) continue;
      counts.set(p.inn, (counts.get(p.inn) ?? 0) + 1);
    }
    const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (top) owners.set(statement.fileName, { inn: top[0], lines: top[1] });
  }
  return owners;
}

/** Statements that say they are another company's than the one selected. Empty when they agree or say nothing. */
export function foreignStatements(statements: BankStatement[], ownInn: string): OwnerMismatch[] {
  if (!/^\d{9}$/.test(ownInn)) return [];
  const found: OwnerMismatch[] = [];
  for (const [file, owner] of statementOwners(statements)) {
    if (owner.inn !== ownInn) found.push({ file, statementInn: owner.inn, lines: owner.lines });
  }
  return found;
}
