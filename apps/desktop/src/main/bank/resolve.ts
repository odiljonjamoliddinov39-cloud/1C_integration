/**
 * Bank payments turned into 1C documents with no AI. The program finds the organization's own bank
 * account and each counterparty (by INN), then writes every payment the way this company already
 * writes that counterparty's payments: the newest posted payment document of the same kind and the
 * same counterparty is copied, and only the date, the amount, the bank document's number and the
 * payment purpose change. So the contract, the settlement accounts, the cash flow item and the
 * payment breakdown are the company's own, not a guess.
 *
 * What cannot be settled this way (no INN, no counterparty in 1C, no earlier payment to copy, a
 * foreign-currency contract) goes to the model as a short list, grouped by counterparty.
 */
import type { ChangeInput, RunQueryInput } from "@platform/shared";

import { type QueryOutcome, type ResolverDeps, lookup, refOf, textOf } from "../didox/resolve.js";
import { BLOCKING, type BankPayment, type BankStatement } from "./statement.js";

export interface BankDeps extends ResolverDeps {
  getObject(object: string, ref: string): Promise<QueryOutcome>;
}

export interface BankCandidate {
  ref: string;
  name: string;
}

export interface BankProblem {
  /** The sheet rows it concerns. */
  rows: number[];
  code:
    | "CHECK"
    | "BANK_ACCOUNT_NOT_FOUND"
    | "BANK_ACCOUNT_AMBIGUOUS"
    | "NO_INN"
    | "COUNTERPARTY_NOT_FOUND"
    | "COUNTERPARTY_AMBIGUOUS"
    | "NO_TEMPLATE"
    | "BAD_TEMPLATE";
  message: string;
  /** Who it is about: the name and INN as the statement writes them. */
  counterparty?: string;
  candidates?: BankCandidate[];
}

/** What the model decided for what the program could not: references only. */
export interface BankOverrides {
  ownAccount?: string;
  counterparties?: { row: number; ref: string }[];
  /** A posted payment document to copy for a row: used when the counterparty has no earlier payment. */
  templates?: { row: number; ref: string }[];
}

export interface BankResolved {
  ready: { payment: BankPayment; change: ChangeInput }[];
  /** Payments already in 1C (same date, counterparty and amount): left out. */
  alreadyIn1c: number[];
  problems: BankProblem[];
}

export interface BankCache {
  /** Templates found so far: "object|counterparty" → the snapshot. */
  templates: Map<string, Template | null>;
}

interface Template {
  object: string;
  ref: string;
  fields: Record<string, unknown>;
  tables: Record<string, Record<string, unknown>[]>;
}

const OBJECT = {
  in: "Документ.ПоступлениеНаРасчетныйСчет",
  out: "Документ.СписаниеСРасчетногоСчета",
} as const;

/** Attributes the program rewrites in the copied document, by the names 1C configurations use. */
const FIELD_NAMES = {
  amount: ["СуммаДокумента"],
  purpose: ["НазначениеПлатежа", "Назначение"],
  number: ["НомерВходящегоДокумента", "НомерПлатежногоДокумента", "НомерВходящего", "НомерДокументаБанка"],
  incomingDate: ["ДатаВходящегоДокумента", "ДатаПлатежногоДокумента", "ДатаВходящего"],
  bankAccount: ["БанковскийСчет"],
};

/** Standard attributes a copy must not carry over: 1C makes them itself. */
const NOT_COPIED = new Set([
  "Number",
  "Номер",
  "Posted",
  "Проведен",
  "DeletionMark",
  "ПометкаУдаления",
  "Date",
  "Дата",
]);

/** Columns of the payment breakdown that hold money and scale with the payment's amount. */
const MONEY_COLUMNS = ["СуммаПлатежа", "СуммаВзаиморасчетов", "СуммаНДС", "Сумма"];

const round2 = (n: number) => Math.round(n * 100) / 100;
const first = (keys: string[], have: Record<string, unknown>) => keys.find((k) => k in have);

/** A reference as GetObject writes it, back into what a change accepts. */
function writable(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as { type?: unknown; ref?: unknown; name?: unknown };
    if (typeof v.ref === "string" && typeof v.type === "string") {
      // An enumeration is written by the value's name.
      return v.type.startsWith("Перечисление") ? String(v.name ?? v.ref) : { ref: v.ref };
    }
  }
  return value;
}

const parsePositive = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : Number.NaN);

/** The copied document with this payment's own date, amount, number and purpose, or why it cannot be made. */
export function copyTemplate(
  template: Template,
  payment: BankPayment,
  ownAccount: string | null,
): { ok: true; change: ChangeInput } | { ok: false; message: string } {
  const amountKey = first(FIELD_NAMES.amount, template.fields);
  if (!amountKey) return { ok: false, message: `${template.object} has no ${FIELD_NAMES.amount[0]} to set` };
  const oldTotal = parsePositive(template.fields[amountKey]);
  if (!(oldTotal > 0)) return { ok: false, message: "the earlier payment has no amount to copy from" };
  const amount = payment.amount / 100;

  const fields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(template.fields)) {
    if (!NOT_COPIED.has(name)) fields[name] = writable(value);
  }
  fields[amountKey] = amount;
  const purposeKey = first(FIELD_NAMES.purpose, template.fields);
  if (purposeKey && payment.purpose) fields[purposeKey] = payment.purpose;
  const numberKey = first(FIELD_NAMES.number, template.fields);
  if (numberKey && payment.number) fields[numberKey] = payment.number;
  const incomingKey = first(FIELD_NAMES.incomingDate, template.fields);
  if (incomingKey) fields[incomingKey] = payment.date;
  const accountKey = first(FIELD_NAMES.bankAccount, template.fields);
  if (accountKey && ownAccount) fields[accountKey] = { ref: ownAccount };
  fields.Date = payment.date;

  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const [name, rows] of Object.entries(template.tables)) {
    if (rows.length === 0) continue;
    const moneyRows = rows.filter((row) => MONEY_COLUMNS.some((c) => c in row));
    if (moneyRows.length === 0) {
      tables[name] = rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([k, v]) => [k, writable(v)])),
      );
      continue;
    }
    // One row per contract: a payment that was split over several contracts cannot be copied for a new amount.
    if (rows.length !== 1) {
      return {
        ok: false,
        message: `the earlier payment's ${name} has ${rows.length} rows (split over contracts)`,
      };
    }
    const row = rows[0] ?? {};
    const rate = parsePositive(row["КурсВзаиморасчетов"] ?? row["Курс"] ?? 1);
    if (rate !== 1) {
      return {
        ok: false,
        message: `the earlier payment is in a foreign currency (rate ${rate}): enter it by hand`,
      };
    }
    const rowTotal = parsePositive(row["СуммаПлатежа"] ?? row["Сумма"]);
    if (!(rowTotal > 0) || Math.abs(rowTotal - oldTotal) > 0.005) {
      return { ok: false, message: `the earlier payment's ${name} does not add up to its amount` };
    }
    const scaled: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(row)) {
      scaled[column] =
        MONEY_COLUMNS.includes(column) && typeof value === "number"
          ? round2((value * amount) / oldTotal)
          : writable(value);
    }
    tables[name] = [scaled];
  }
  return {
    ok: true,
    change: {
      action: "create",
      object: template.object,
      fields,
      ...(Object.keys(tables).length > 0 ? { tables } : {}),
      post: false,
    },
  };
}

const day = (date: string) => date.slice(0, 10);

/** The two bank documents a day apart or an INN-less payment cannot be told apart from a copy: only exact matches are "already in 1C". */
const sameKey = (date: string, counterparty: string, amount: number) =>
  `${day(date)}|${counterparty}|${Math.round(amount * 100)}`;

export async function resolvePayments(
  statement: BankStatement,
  options: { companyInn?: string; overrides?: BankOverrides; cache?: BankCache; only?: number[] },
  deps: BankDeps,
): Promise<BankResolved> {
  const overrides = options.overrides ?? {};
  const cache = options.cache ?? { templates: new Map() };
  const problems: BankProblem[] = [];
  const alreadyIn1c: number[] = [];
  const wanted = options.only ? new Set(options.only) : null;
  let payments = statement.payments.filter((p) => !wanted || wanted.has(p.row));

  // 1. Payments the program's own checks stop.
  const stopped = new Map<number, string[]>();
  for (const issue of statement.issues) {
    if (BLOCKING.includes(issue.code))
      stopped.set(issue.row, [...(stopped.get(issue.row) ?? []), issue.message]);
  }
  for (const p of payments.filter((x) => stopped.has(x.row))) {
    problems.push({
      rows: [p.row],
      code: "CHECK",
      message: (stopped.get(p.row) ?? []).join("; "),
      counterparty: label(p),
    });
  }
  payments = payments.filter((p) => !stopped.has(p.row));
  if (payments.length === 0) return { ready: [], alreadyIn1c, problems };

  // 2. The organization's own bank account.
  let ownAccount: string | null = overrides.ownAccount ?? null;
  if (!ownAccount && statement.account) {
    const rows = await lookup(
      deps,
      (ph) =>
        `ВЫБРАТЬ Т.Ссылка КАК Ссылка, Т.Наименование КАК Наименование ИЗ Справочник.БанковскиеСчета КАК Т ГДЕ Т.НомерСчета В (${ph}) И НЕ Т.ПометкаУдаления`,
      [statement.account],
    );
    const found = (rows ?? []).flatMap(({ cells }) => {
      const ref = refOf(cells[0]);
      return ref ? [{ ref, name: textOf(cells[1]) }] : [];
    });
    const [only] = found;
    if (found.length === 1 && only) ownAccount = only.ref;
    else if (rows) {
      problems.push({
        rows: payments.map((p) => p.row),
        code: found.length === 0 ? "BANK_ACCOUNT_NOT_FOUND" : "BANK_ACCOUNT_AMBIGUOUS",
        message:
          found.length === 0
            ? `no bank account ${statement.account} in 1C: pass ownAccount (the reference of the organization's account)`
            : `${found.length} bank accounts have the number ${statement.account}: pass ownAccount`,
        candidates: found,
      });
      return { ready: [], alreadyIn1c, problems };
    }
  }

  // 3. Counterparties by INN.
  const inns = [...new Set(payments.map((p) => p.inn).filter((inn) => inn !== ""))];
  const byInn = new Map<string, BankCandidate[]>();
  const counterpartyRows = inns.length
    ? await lookup(
        deps,
        (ph) =>
          `ВЫБРАТЬ Т.ИНН КАК ИНН, Т.Ссылка КАК Ссылка, Т.Наименование КАК Наименование ИЗ Справочник.Контрагенты КАК Т ГДЕ Т.ИНН В (${ph}) И НЕ Т.ПометкаУдаления`,
        inns,
      )
    : [];
  for (const { cells } of counterpartyRows ?? []) {
    const ref = refOf(cells[1]);
    if (ref)
      byInn.set(String(cells[0]), [...(byInn.get(String(cells[0])) ?? []), { ref, name: textOf(cells[2]) }]);
  }

  const withCounterparty: { payment: BankPayment; counterparty: string }[] = [];
  const grouped = new Map<string, BankProblem>();
  const addProblem = (
    p: BankPayment,
    code: BankProblem["code"],
    message: string,
    candidates?: BankCandidate[],
  ) => {
    const key = `${code}|${p.inn || p.counterparty}`;
    const existing = grouped.get(key);
    if (existing) existing.rows.push(p.row);
    else {
      const created: BankProblem = {
        rows: [p.row],
        code,
        message,
        counterparty: label(p),
        ...(candidates ? { candidates } : {}),
      };
      grouped.set(key, created);
      problems.push(created);
    }
  };
  for (const p of payments) {
    const chosen = overrides.counterparties?.find((o) => o.row === p.row);
    if (chosen) {
      withCounterparty.push({ payment: p, counterparty: chosen.ref });
      continue;
    }
    if (p.inn === "") {
      addProblem(
        p,
        "NO_INN",
        "the statement has no INN for this counterparty: find it in 1C by name, or answer with counterparties",
      );
      continue;
    }
    if (!counterpartyRows) {
      addProblem(p, "COUNTERPARTY_NOT_FOUND", "1C could not be asked for the counterparty");
      continue;
    }
    const matches = byInn.get(p.inn) ?? [];
    const [only] = matches;
    if (matches.length === 1 && only) withCounterparty.push({ payment: p, counterparty: only.ref });
    else if (matches.length === 0)
      addProblem(p, "COUNTERPARTY_NOT_FOUND", `no counterparty with INN ${p.inn} in 1C: create it first`);
    else
      addProblem(
        p,
        "COUNTERPARTY_AMBIGUOUS",
        `${matches.length} counterparties have INN ${p.inn}: choose one`,
        matches,
      );
  }
  if (withCounterparty.length === 0) return { ready: [], alreadyIn1c, problems };

  // 4. Payments already in 1C: the same day, counterparty and amount in the same kind of document.
  const dates = withCounterparty.map((x) => x.payment.date).sort();
  const existing = new Set<string>();
  for (const direction of ["in", "out"] as const) {
    if (!withCounterparty.some((x) => x.payment.direction === direction)) continue;
    const query: RunQueryInput = {
      query: `ВЫБРАТЬ Т.Контрагент КАК Контрагент, Т.Дата КАК Дата, Т.СуммаДокумента КАК Сумма ИЗ ${OBJECT[direction]} КАК Т ГДЕ Т.Дата МЕЖДУ &начало И &конец И НЕ Т.ПометкаУдаления`,
      params: { начало: `${dates[0]}T00:00:00`, конец: `${dates.at(-1)}T23:59:59` },
      limit: 1000,
      refs: true,
    };
    const outcome = await deps.query(query);
    if (!outcome.ok) continue;
    for (const cells of (outcome.data as { rows?: unknown[][] }).rows ?? []) {
      const ref = refOf(cells[0]);
      if (ref && typeof cells[2] === "number")
        existing.add(`${direction}|${sameKey(String(cells[1]), ref, cells[2])}`);
    }
  }

  // 5. A copy of the counterparty's newest payment, per payment.
  const ready: BankResolved["ready"] = [];
  for (const { payment, counterparty } of withCounterparty) {
    if (existing.has(`${payment.direction}|${sameKey(payment.date, counterparty, payment.amount / 100)}`)) {
      alreadyIn1c.push(payment.row);
      continue;
    }
    const object = OBJECT[payment.direction];
    const asked = overrides.templates?.find((o) => o.row === payment.row);
    const cacheKey = `${asked?.ref ?? `${object}|${counterparty}`}`;
    let template = cache.templates.get(cacheKey);
    if (template === undefined) {
      template = await findTemplate(deps, object, counterparty, asked?.ref);
      cache.templates.set(cacheKey, template);
    }
    if (!template) {
      addProblem(
        payment,
        "NO_TEMPLATE",
        `no earlier posted ${object.replace("Документ.", "")} for this counterparty to copy: answer with templates (a posted document of the same kind) or enter it with propose_changes`,
      );
      continue;
    }
    const made = copyTemplate(template, payment, ownAccount);
    if (!made.ok) {
      addProblem(payment, "BAD_TEMPLATE", made.message);
      continue;
    }
    ready.push({ payment, change: made.change });
  }
  return { ready, alreadyIn1c, problems };
}

const label = (p: BankPayment) =>
  p.inn ? `${p.counterparty} (INN ${p.inn})` : p.counterparty || "(no name)";

/** The newest posted document of this kind for the counterparty, read whole; or the one the model named. */
async function findTemplate(
  deps: BankDeps,
  object: string,
  counterparty: string,
  named?: string,
): Promise<Template | null> {
  let ref = named ?? null;
  if (!ref) {
    const outcome = await deps.query({
      query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ ${object} КАК Т ГДЕ Т.Проведен И Т.Контрагент = &к УПОРЯДОЧИТЬ ПО Т.Дата УБЫВ`,
      params: { к: counterparty },
      limit: 1,
      refs: true,
    });
    if (!outcome.ok) return null;
    ref = refOf((outcome.data as { rows?: unknown[][] }).rows?.[0]?.[0]);
  }
  if (!ref) return null;
  const snapshot = await deps.getObject(object, ref);
  if (!snapshot.ok) return null;
  const data = snapshot.data as {
    fields?: Record<string, unknown>;
    tables?: Record<string, Record<string, unknown>[]>;
  };
  return { object, ref, fields: data.fields ?? {}, tables: data.tables ?? {} };
}
