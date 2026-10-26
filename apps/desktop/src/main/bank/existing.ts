/**
 * What 1C already has of the payments a statement lists, so that a second run (or a second statement, or a payment entered by
 * hand, or one entered as another kind of document) enters nothing twice. A document is the same payment when it is on the same
 * bank account, the same day, for the same amount, and either carries the same bank number or is to the same counterparty
 * (a payment with no counterparty of its own, a tax or a fee, matches by the account, the day and the amount). Each document
 * of 1C stands for one row of the statement: two equal rows of the statement need two documents. A period with more
 * documents than one query returns is read in parts (see query-window.ts), so that none is hidden.
 */
import { refOf } from "../didox/resolve.js";
import { rowsOfPeriod } from "../query-window.js";
import type { BankCache, BankDeps } from "./resolve.js";
import { OBJECT } from "./resolve.js";
import { ownAccountAttribute } from "./roles.js";

export interface ExistingDoc {
  /** The company's bank account (ref), "" when the document names none. */
  account: string;
  day: string;
  /** Tiyin. */
  cents: number;
  counterparty: string;
  number: string;
}

const day = (iso: string) => iso.slice(0, 10);

export async function existingDocs(
  deps: BankDeps,
  cache: BankCache,
  direction: "in" | "out",
  from: string,
  to: string,
): Promise<ExistingDoc[] | null> {
  const object = OBJECT[direction];
  const accountKey = await ownAccountAttribute(deps, cache, object);
  const ask = (numberColumn: boolean) =>
    `ВЫБРАТЬ Т.${accountKey} КАК Счет, Т.Контрагент КАК Контрагент, Т.Дата КАК Дата, Т.СуммаДокумента КАК Сумма${numberColumn ? ", Т.НомерВходящегоДокумента КАК Номер" : ""} ИЗ ${object} КАК Т ГДЕ Т.Дата МЕЖДУ &начало И &конец И НЕ Т.ПометкаУдаления`;
  let withNumber = true;
  let rows = await rowsOfPeriod(deps, ask(true), day(from), day(to));
  if (!rows) {
    withNumber = false;
    rows = await rowsOfPeriod(deps, ask(false), day(from), day(to));
  }
  if (!rows) return null;
  const found: ExistingDoc[] = [];
  for (const cells of rows) {
    if (typeof cells[3] !== "number") continue;
    found.push({
      account: refOf(cells[0]) ?? "",
      counterparty: refOf(cells[1]) ?? "",
      day: day(String(cells[2] ?? "")),
      cents: Math.round(cells[3] * 100),
      number: withNumber ? String(cells[4] ?? "").trim() : "",
    });
  }
  return found;
}

/** The documents 1C has, each used up by the first row of the statement it matches. */
export class ExistingPool {
  private readonly byKey = new Map<string, ExistingDoc[]>();

  constructor(docs: ExistingDoc[]) {
    for (const doc of docs) {
      const key = `${doc.day}|${doc.cents}`;
      this.byKey.set(key, [...(this.byKey.get(key) ?? []), doc]);
    }
  }

  /** True (and the document is used up) when 1C already has this row. */
  take(row: {
    account: string | null;
    day: string;
    cents: number;
    number?: string;
    counterparty?: string | null;
  }): boolean {
    const list = this.byKey.get(`${row.day}|${row.cents}`);
    if (!list) return false;
    const onAccount = list.filter((d) => !row.account || !d.account || d.account === row.account);
    const wanted = (row.number ?? "").trim();
    const byNumber = wanted ? onAccount.find((d) => d.number === wanted) : undefined;
    const match =
      byNumber ??
      onAccount.find((d) => !row.counterparty || !d.counterparty || d.counterparty === row.counterparty);
    if (!match) return false;
    list.splice(list.indexOf(match), 1);
    return true;
  }
}
