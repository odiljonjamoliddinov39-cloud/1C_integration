/**
 * Money moved between the company's own accounts, entered as 1C documents by the program. A move is two documents,
 * one on each account's side (a debit of the paying account, a receipt on the other), and the company already has a
 * way of recording them: its earlier posted documents of the operation «Перевод на другой счёт организации»,
 * «Перевод с другого счёта», or a conversion. The newest such document is copied, as for any payment, and only the
 * date, the amount, the bank document's number, the purpose and the two accounts change. A leg whose statement is not
 * attached is not entered (it will be, with its own statement); one already in 1C (the same account, day and amount)
 * is left out.
 */
import type { ChangeInput } from "@platform/shared";

import { type QueryOutcome, lookup, refOf, textOf } from "../didox/resolve.js";
import type { Transfer } from "./ledger.js";
import { CONVERSION_KIND, TRANSFER_KIND } from "./policy.js";
import {
  type BankCache,
  type BankDeps,
  OBJECT,
  type Template,
  copyTemplate,
  refTo,
  snapshot,
} from "./resolve.js";
import type { BankPayment, BankStatement } from "./statement.js";

export interface TransferDoc {
  transfer: Transfer;
  side: "out" | "in";
  file: string;
  row: number;
  change: ChangeInput;
}

export interface TransferProblem {
  file: string;
  row: number;
  side: "out" | "in";
  message: string;
}

export interface TransfersResolved {
  ready: TransferDoc[];
  problems: TransferProblem[];
  notes: string[];
  /** Legs already in 1C: left out. */
  alreadyIn1c: { file: string; row: number }[];
}

const day = (iso: string) => iso.slice(0, 10);
const cents = (n: number) => Math.round(n);

/** The attributes of a transfer document that hold the other account, by the names configurations use. */
const OTHER_ACCOUNT = [
  "БанковскийСчетПолучатель",
  "СчетПолучатель",
  "БанковскийСчетОтправитель",
  "СчетОтправитель",
  "БанковскийСчетКорреспондент",
  "СчетКонтрагента",
  "СчетОрганизации",
];

/** Posted documents of the transfer kind (or the conversion kind), newest first. */
async function transferList(
  deps: BankDeps,
  cache: BankCache,
  object: string,
  conversion: boolean,
): Promise<string[]> {
  const key = `${object}|transfer:${conversion ? "conversion" : "own"}`;
  const cached = cache.lists.get(key);
  if (cached) return cached.map((c) => c.ref);
  const kinds = await deps.query({
    query: `ВЫБРАТЬ Т.ВидОперации КАК Вид, МАКСИМУМ(Т.Дата) КАК Последний ИЗ ${object} КАК Т ГДЕ Т.Проведен И НЕ Т.ПометкаУдаления СГРУППИРОВАТЬ ПО Т.ВидОперации`,
    limit: 100,
    refs: true,
  });
  const found: { value: string; last: string }[] = [];
  if (kinds.ok) {
    for (const cells of (kinds.data as { rows?: unknown[][] }).rows ?? []) {
      const cell = cells[0] as { type?: unknown; ref?: unknown } | undefined;
      const name = textOf(cell);
      if (!cell || typeof cell.type !== "string" || typeof cell.ref !== "string") continue;
      if (!TRANSFER_KIND.test(name) || CONVERSION_KIND.test(name) !== conversion) continue;
      found.push({ value: `${cell.type}.${cell.ref}`, last: String(cells[1] ?? "") });
    }
  }
  found.sort((a, b) => b.last.localeCompare(a.last));
  const refs: string[] = [];
  for (const kind of found.slice(0, 2)) {
    const list = await deps.query({
      query: `ВЫБРАТЬ ПЕРВЫЕ 20 Т.Ссылка КАК Ссылка ИЗ ${object} КАК Т ГДЕ Т.Проведен И НЕ Т.ПометкаУдаления И Т.ВидОперации = ЗНАЧЕНИЕ(${kind.value}) УПОРЯДОЧИТЬ ПО Т.Дата УБЫВ`,
      limit: 20,
      refs: true,
    });
    if (!list.ok) continue;
    for (const cells of (list.data as { rows?: unknown[][] }).rows ?? []) {
      const ref = refOf(cells[0]);
      if (ref) refs.push(ref);
    }
  }
  cache.lists.set(
    key,
    refs.map((ref) => ({ ref, purpose: "" })),
  );
  return refs;
}

/** The attribute of a transfer document that names the other account. */
function otherAccountKey(template: Template): string | null {
  const bankAccount = "БанковскийСчет";
  const isAccount = (v: unknown) =>
    Boolean(v) && typeof v === "object" && (v as { type?: unknown }).type === "Справочник.БанковскиеСчета";
  const candidates = Object.entries(template.fields).filter(([k, v]) => k !== bankAccount && isAccount(v));
  return OTHER_ACCOUNT.find((k) => candidates.some(([name]) => name === k)) ?? candidates[0]?.[0] ?? null;
}

const refText = (value: unknown): string => refOf(value) ?? "";

/** The earlier document to copy: the same pair of accounts if the company has moved money so before, else the newest. */
async function pickTemplate(
  deps: BankDeps,
  cache: BankCache,
  object: string,
  conversion: boolean,
  own: string,
  other: string,
): Promise<Template | null> {
  const refs = await transferList(deps, cache, object, conversion);
  let newest: Template | null = null;
  let sameAccount: Template | null = null;
  for (const ref of refs.slice(0, 8)) {
    const template = await snapshot(deps, cache, object, ref);
    if (!template) continue;
    newest ??= template;
    if (refText(template.fields["БанковскийСчет"]) !== own) continue;
    const key = otherAccountKey(template);
    if (key && refText(template.fields[key]) === other) return template;
    sameAccount ??= template;
  }
  return sameAccount ?? newest;
}

interface Leg {
  transfer: Transfer;
  side: "out" | "in";
  file: string;
  row: number;
  /** The account number on this leg's own statement, and the other account's. */
  own: string;
  other: string;
}

export async function resolveTransfers(
  transfers: Transfer[],
  statements: BankStatement[],
  options: { ownInn?: string; cache?: BankCache; files: Set<string>; done?: Set<string> },
  deps: BankDeps,
): Promise<TransfersResolved> {
  const cache = options.cache ?? { lists: new Map(), snapshots: new Map() };
  const result: TransfersResolved = { ready: [], problems: [], notes: [], alreadyIn1c: [] };
  const key = (file: string, row: number) => `${file}#${row}`;

  const legs: Leg[] = [];
  for (const transfer of transfers) {
    for (const side of ["out", "in"] as const) {
      const at = transfer[side];
      if (!at || !options.files.has(at.file) || options.done?.has(key(at.file, at.row))) continue;
      legs.push({
        transfer,
        side,
        file: at.file,
        row: at.row,
        own: side === "out" ? transfer.fromAccount : transfer.toAccount,
        other: side === "out" ? transfer.toAccount : transfer.fromAccount,
      });
    }
  }
  if (legs.length === 0) return result;
  const fail = (leg: Leg, message: string) =>
    result.problems.push({ file: leg.file, row: leg.row, side: leg.side, message });

  // The company's bank accounts in 1C, by number.
  const numbers = [...new Set(legs.flatMap((l) => [l.own, l.other]).filter((n) => /^\d{20}$/.test(n)))];
  const rows = numbers.length
    ? await lookup(
        deps,
        (ph) =>
          `ВЫБРАТЬ Т.НомерСчета КАК Номер, Т.Ссылка КАК Ссылка, Т.Владелец.ИНН КАК ИНН ИЗ Справочник.БанковскиеСчета КАК Т ГДЕ Т.НомерСчета В (${ph}) И НЕ Т.ПометкаУдаления`,
        numbers,
      )
    : [];
  if (!rows) {
    for (const leg of legs) fail(leg, "1C could not be asked for the company's bank accounts");
    return result;
  }
  const accountRef = new Map<string, string>();
  for (const { cells } of rows) {
    const ref = refOf(cells[1]);
    const inn = textOf(cells[2]) || String(cells[2] ?? "");
    if (!ref || (options.ownInn && inn && inn !== options.ownInn)) continue;
    const number = String(cells[0] ?? "").replace(/\D/g, "");
    // Two accounts with one number cannot be told apart: neither is used.
    accountRef.set(number, accountRef.has(number) ? "" : ref);
  }

  // Legs already in 1C: the same account, day and amount.
  const existing = new Set<string>();
  const dates = legs.map((l) => l.transfer.date).sort();
  for (const side of ["out", "in"] as const) {
    if (!legs.some((l) => l.side === side)) continue;
    const outcome: QueryOutcome = await deps.query({
      query: `ВЫБРАТЬ Т.БанковскийСчет КАК Счет, Т.Дата КАК Дата, Т.СуммаДокумента КАК Сумма ИЗ ${OBJECT[side]} КАК Т ГДЕ Т.Дата МЕЖДУ &начало И &конец И НЕ Т.ПометкаУдаления`,
      params: { начало: `${dates[0]}T00:00:00`, конец: `${dates.at(-1)}T23:59:59` },
      limit: 2000,
      refs: true,
    });
    if (!outcome.ok) continue;
    for (const cells of (outcome.data as { rows?: unknown[][] }).rows ?? []) {
      if (typeof cells[2] === "number")
        existing.add(`${side}|${refOf(cells[0]) ?? ""}|${day(String(cells[1]))}|${cents(cells[2] * 100)}`);
    }
  }

  for (const leg of legs) {
    const statement = statements.find((s) => s.fileName === leg.file);
    const payment: BankPayment | undefined = statement?.payments.find((p) => p.row === leg.row);
    if (!payment) {
      fail(leg, "the row is not in the statement");
      continue;
    }
    const ownRef = accountRef.get(leg.own) || null;
    const otherRef = accountRef.get(leg.other) || null;
    if (!ownRef) {
      fail(leg, `no bank account ${leg.own || "(none)"} of the company in 1C`);
      continue;
    }
    if (!otherRef) {
      fail(
        leg,
        leg.other
          ? `the other account ${leg.other} is not among the company's bank accounts in 1C (or two have its number)`
          : "the statement does not say the other account",
      );
      continue;
    }
    if (existing.has(`${leg.side}|${ownRef}|${day(payment.date)}|${cents(payment.amount)}`)) {
      result.alreadyIn1c.push({ file: leg.file, row: leg.row });
      continue;
    }
    const object = OBJECT[leg.side];
    const template = await pickTemplate(
      deps,
      cache,
      object,
      leg.transfer.kind === "conversion",
      ownRef,
      otherRef,
    );
    if (!template) {
      fail(
        leg,
        `1C has no posted ${object.replace("Документ.", "")} of the operation «transfer to/from another account of the company»${leg.transfer.kind === "conversion" ? " (conversion)" : ""} to copy: the accountant says how the company books it`,
      );
      continue;
    }
    const otherKey = otherAccountKey(template);
    if (!otherKey) {
      fail(leg, `the document to copy (${template.ref}) has no attribute for the other account`);
      continue;
    }
    const made = copyTemplate(template, payment, { ownAccount: ownRef });
    if (!made.ok) {
      fail(leg, made.message);
      continue;
    }
    made.change.fields = {
      ...made.change.fields,
      [otherKey]: refTo(template.fields[otherKey], otherRef, "Справочник.БанковскиеСчета"),
    };
    const from = `${template.fields["Номер"] ?? template.ref} of ${day(String(template.fields["Дата"] ?? ""))}`;
    const note = `${leg.transfer.kind === "conversion" ? "conversion" : "transfer between own accounts"} copied from the company's ${from}; check the accounts and the operation`;
    if (!result.notes.includes(note)) result.notes.push(note);
    result.ready.push({
      transfer: leg.transfer,
      side: leg.side,
      file: leg.file,
      row: leg.row,
      change: made.change,
    });
  }
  return result;
}
