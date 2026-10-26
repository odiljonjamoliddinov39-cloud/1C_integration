/**
 * Bank documents 1C has more than once. The statements are the truth about what the bank did: a bank account, a day, an
 * amount and a direction that the statement lists n times are n documents in 1C, whatever the kind of each (a payment, a
 * transfer, a conversion leg, a tax entered as a payment to a supplier). When 1C has more than n, the extra ones are the
 * program's or the accountant's second entry of the same row, and they are the ones to take back. Nothing else is judged:
 * a document that no row of the statements stands behind (a fee split off a payment, an entry of another account whose
 * statement is not attached) is reported, never touched.
 *
 * Which of the documents stays: the one that carries the row's bank number, then a posted one, then the earliest (the
 * newest copy is the repeat).
 */
import { refOf, textOf } from "../didox/resolve.js";
import { rowsOfPeriod } from "../query-window.js";
import { type BankCache, type BankDeps, OBJECT } from "./resolve.js";
import { ownAccountAttribute } from "./roles.js";
import type { BankStatement } from "./statement.js";

export interface BankDoc {
  object: string;
  ref: string;
  number: string;
  day: string;
  /** Tiyin. */
  cents: number;
  posted: boolean;
  /** The operation as 1C shows it («Прочее списание», «Перевод на другой счет организации»…), "" when it could not be read. */
  kind: string;
  /** The company's bank account number the document is on, "" when 1C gave none. */
  account: string;
  /** The bank's own number of the payment the document carries. */
  incoming: string;
  counterparty: string;
  direction: "in" | "out";
  /** The bank's ledger account the document is booked to (its reference), "" when not read. */
  ledger: string;
}

const day = (iso: string) => iso.slice(0, 10);

/** The bank documents of the period, both directions. Null when 1C could not be read at all. */
export async function readBankDocs(
  deps: BankDeps,
  cache: BankCache,
  from: string,
  to: string,
  /** The attribute of the documents that holds the bank's ledger account, to read it too. */
  ledgerAttribute?: string | null,
): Promise<BankDoc[] | null> {
  const found: BankDoc[] = [];
  let readAny = false;
  for (const direction of ["out", "in"] as const) {
    const object = OBJECT[direction];
    const accountKey = await ownAccountAttribute(deps, cache, object);
    const extra = ledgerAttribute ? `, Т.${ledgerAttribute} КАК Банк` : "";
    // The richest query first; a configuration without a column gets the poorer one.
    const shapes = [
      `ВЫБРАТЬ Т.Ссылка КАК Ссылка, Т.Номер КАК Номер, Т.Дата КАК Дата, Т.СуммаДокумента КАК Сумма, Т.Проведен КАК Проведен, ПРЕДСТАВЛЕНИЕ(Т.ВидОперации) КАК Вид, Т.${accountKey}.НомерСчета КАК Счет, Т.НомерВходящегоДокумента КАК Входящий, Т.Контрагент.Наименование КАК Контрагент${extra} ИЗ ${object} КАК Т ГДЕ Т.Дата МЕЖДУ &начало И &конец И НЕ Т.ПометкаУдаления`,
      `ВЫБРАТЬ Т.Ссылка КАК Ссылка, Т.Номер КАК Номер, Т.Дата КАК Дата, Т.СуммаДокумента КАК Сумма, Т.Проведен КАК Проведен, ПРЕДСТАВЛЕНИЕ(Т.ВидОперации) КАК Вид, Т.${accountKey}.НомерСчета КАК Счет${extra} ИЗ ${object} КАК Т ГДЕ Т.Дата МЕЖДУ &начало И &конец И НЕ Т.ПометкаУдаления`,
      `ВЫБРАТЬ Т.Ссылка КАК Ссылка, Т.Номер КАК Номер, Т.Дата КАК Дата, Т.СуммаДокумента КАК Сумма, Т.Проведен КАК Проведен${extra} ИЗ ${object} КАК Т ГДЕ Т.Дата МЕЖДУ &начало И &конец И НЕ Т.ПометкаУдаления`,
    ];
    const columns = [9, 7, 5];
    let shape = 0;
    let rows: unknown[][] | null = null;
    for (; shape < shapes.length; shape += 1) {
      rows = await rowsOfPeriod(deps, shapes[shape] ?? "", day(from), day(to));
      if (rows) break;
    }
    if (!rows) continue;
    readAny = true;
    for (const cells of rows) {
      const ref = refOf(cells[0]);
      if (!ref || typeof cells[3] !== "number") continue;
      found.push({
        object,
        ref,
        number: String(cells[1] ?? ""),
        day: day(String(cells[2] ?? "")),
        cents: Math.round(cells[3] * 100),
        posted: cells[4] === true,
        kind: shape <= 1 ? textOf(cells[5]) || String(cells[5] ?? "") : "",
        account: shape <= 1 ? String(cells[6] ?? "").replace(/\D/g, "") : "",
        incoming: shape === 0 ? String(cells[7] ?? "").trim() : "",
        counterparty: shape === 0 ? textOf(cells[8]) || String(cells[8] ?? "") : "",
        direction,
        ledger: ledgerAttribute ? (refOf(cells[columns[shape] ?? 5]) ?? "") : "",
      });
    }
  }
  return readAny ? found : null;
}

export interface DuplicateGroup {
  account: string;
  direction: "in" | "out";
  day: string;
  cents: number;
  /** How many times the statements list it, and how many documents 1C has. */
  rows: number;
  documents: number;
  keep: BankDoc[];
  extra: BankDoc[];
}

export interface DuplicateReport {
  groups: DuplicateGroup[];
  /** Documents to take back: the extra ones, the newest first. */
  extra: BankDoc[];
  checked: {
    accounts: string[];
    statementRows: number;
    documents: number;
    /** Documents on an account none of the attached statements is for: not judged. */
    unjudged: number;
    /** Documents on a judged account that no row of the statements stands behind: reported, never touched. */
    withoutRow: number;
    /** Rows of the statements 1C has fewer documents for. */
    missing: number;
  };
}

/** The extra documents among the bank documents of 1C, against what the statements list. */
export function findDuplicates(statements: BankStatement[], docs: BankDoc[]): DuplicateReport {
  type Row = { number: string };
  const rows = new Map<string, Row[]>();
  const accounts = new Set<string>();
  let statementRows = 0;
  const keyOf = (account: string, direction: string, d: string, cents: number) =>
    `${account}|${direction}|${d}|${cents}`;
  for (const s of statements) {
    if (!s.account) continue;
    accounts.add(s.account);
    for (const p of s.payments) {
      statementRows += 1;
      const key = keyOf(s.account, p.direction, day(p.date), Math.round(p.amount));
      rows.set(key, [...(rows.get(key) ?? []), { number: p.number.trim() }]);
    }
  }
  const byKey = new Map<string, BankDoc[]>();
  let unjudged = 0;
  for (const doc of docs) {
    if (!doc.account || !accounts.has(doc.account)) {
      unjudged += 1;
      continue;
    }
    const key = keyOf(doc.account, doc.direction, doc.day, doc.cents);
    byKey.set(key, [...(byKey.get(key) ?? []), doc]);
  }
  const groups: DuplicateGroup[] = [];
  let withoutRow = 0;
  let missing = 0;
  for (const [key, list] of byKey) {
    const listed = rows.get(key);
    if (!listed) {
      withoutRow += list.length;
      continue;
    }
    if (list.length <= listed.length) continue;
    // The documents that carry a bank number of the row stay first, then the posted ones, then the earliest.
    const numbers = new Set(listed.map((r) => r.number).filter(Boolean));
    const ranked = [...list].sort(
      (a, b) =>
        Number(numbers.has(b.incoming)) - Number(numbers.has(a.incoming)) ||
        Number(b.posted) - Number(a.posted) ||
        a.number.localeCompare(b.number),
    );
    const [account = "", direction = "out", d = "", cents = "0"] = key.split("|");
    groups.push({
      account,
      direction: direction === "in" ? "in" : "out",
      day: d,
      cents: Number(cents),
      rows: listed.length,
      documents: list.length,
      keep: ranked.slice(0, listed.length),
      extra: ranked.slice(listed.length),
    });
  }
  for (const [key, listed] of rows)
    if ((byKey.get(key)?.length ?? 0) < listed.length)
      missing += listed.length - (byKey.get(key)?.length ?? 0);
  groups.sort((a, b) => a.day.localeCompare(b.day) || b.cents - a.cents);
  const extra = groups
    .flatMap((g) => g.extra)
    .sort((a, b) => b.number.localeCompare(a.number) || b.day.localeCompare(a.day));
  return {
    groups,
    extra,
    checked: {
      accounts: [...accounts],
      statementRows,
      documents: docs.length,
      unjudged,
      withoutRow,
      missing,
    },
  };
}
