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
    | "NO_INN"
    | "COUNTERPARTY_NOT_FOUND"
    | "COUNTERPARTY_AMBIGUOUS"
    | "NO_TEMPLATE"
    | "BAD_TEMPLATE"
    | "TAX_PAYMENT";
  message: string;
  /** Who it is about: the name and INN as the statement writes them. */
  counterparty?: string;
  candidates?: BankCandidate[];
}

/** Something the program decided for itself that the accountant should know, e.g. a contract it could not find. */
export interface BankNote {
  rows: number[];
  message: string;
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
  notes: BankNote[];
}

export interface BankCache {
  /** Posted documents of a kind, newest first: "object|INN" (or "object|*" for all) → ref and purpose. */
  lists: Map<string, { ref: string; purpose: string }[]>;
  snapshots: Map<string, Template | null>;
}

export interface Template {
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
  counterpartyAccount: ["СчетКонтрагента"],
  counterparty: ["Контрагент"],
  contract: ["ДоговорКонтрагента"],
  date: ["Дата", "Date"],
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

const refIn = (value: unknown): string | null => refOf(value);

/**
 * What kind of payment a purpose is, by its words: digits and punctuation are dropped, so
 * "00634SmartVista - Выручка … 483,610.84 сум" and the same text with other figures are one kind.
 */
export const shapeOf = (purpose: string) =>
  purpose
    .toLowerCase()
    .replace(/[\d\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30);

/** The contract a payment purpose names ("Договор 4/28 от 01.01.2026г", "по дог. № 17 от 08.01.2026"). */
export function contractMention(purpose: string): { number: string; date: string } | null {
  const found =
    /(?:догов\p{L}*|дог\.?|dog\p{L}*|шартном\p{L}*)(?:\s*номер\p{L}*)?\s*(?:№|N\b|no\b)?\.?\s*([\p{L}\d][\p{L}\d\-/.]*?)\s*(?:от|dan|ot)?\s*(\d{2})\.(\d{2})\.(\d{4})/iu.exec(
      purpose,
    );
  if (!found) return null;
  return { number: found[1] ?? "", date: `${found[4]}-${found[3]}-${found[2]}` };
}

const normalNumber = (n: string) =>
  n
    .toLowerCase()
    .replace(/[\s№#]/g, "")
    .replace(/^0+/, "");

/**
 * A payment to the budget: the treasury or the tax office as the receiver, or a tax named in the purpose.
 * It is not a supplier payment. Copying the counterparty's last payment would repeat however the company
 * entered the earlier ones, and those are often «Оплата поставщику» on 4220, not «Уплата налога».
 */
export function isTaxPayment(payment: BankPayment): boolean {
  if (payment.direction !== "out") return false;
  const who =
    /moliya\s+vazirligi|iqtisodiyot|g['‘’ʻ`]aznachilik|казначейств|давлат\s+солиқ|davlat\s+soliq|налогов|soliq\s+qo['‘’ʻ`]mitasi|министерств\p{L}*\s+(экономики|финансов)/iu;
  const what = /(?<!\p{L})(солиқ\p{L}*|soliq\p{L}*|налог\p{L}*|инпс|inps|ндфл|жшдс|jshds)(?!\p{L})/iu;
  return who.test(payment.counterparty) || what.test(payment.purpose);
}

export interface CopyContext {
  /** The counterparty this payment is with, when known. */
  counterparty?: string | null;
  contract?: string | null;
  ownAccount?: string | null;
  counterpartyAccount?: string | null;
}

/** The copied document with this payment's own date, amount, number and purpose, or why it cannot be made. */
export function copyTemplate(
  template: Template,
  payment: BankPayment,
  context: CopyContext | string | null = {},
): { ok: true; change: ChangeInput } | { ok: false; message: string } {
  const ctx: CopyContext = typeof context === "string" ? { ownAccount: context } : (context ?? {});
  const amountKey = first(FIELD_NAMES.amount, template.fields);
  if (!amountKey) return { ok: false, message: `${template.object} has no ${FIELD_NAMES.amount[0]} to set` };
  const oldTotal = parsePositive(template.fields[amountKey]);
  if (!(oldTotal > 0)) return { ok: false, message: "the earlier payment has no amount to copy from" };
  const amount = payment.amount / 100;

  const counterpartyKey = first(FIELD_NAMES.counterparty, template.fields);
  const templateCounterparty = counterpartyKey ? refIn(template.fields[counterpartyKey]) : null;
  const otherCounterparty = Boolean(
    ctx.counterparty && templateCounterparty && ctx.counterparty !== templateCounterparty,
  );
  if (otherCounterparty && !ctx.contract) {
    return {
      ok: false,
      message:
        "the document to copy is another counterparty's and the payment purpose names no contract of this one that 1C has",
    };
  }

  const theirAccountKey = first(FIELD_NAMES.counterpartyAccount, template.fields);
  const fields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(template.fields)) {
    // Another counterparty's bank account is worse than an empty one.
    if (NOT_COPIED.has(name) || (otherCounterparty && name === theirAccountKey)) continue;
    fields[name] = writable(value);
  }
  fields[amountKey] = amount;
  const purposeKey = first(FIELD_NAMES.purpose, template.fields);
  if (purposeKey && payment.purpose) fields[purposeKey] = payment.purpose;
  const numberKey = first(FIELD_NAMES.number, template.fields);
  if (numberKey && payment.number) fields[numberKey] = payment.number;
  const incomingKey = first(FIELD_NAMES.incomingDate, template.fields);
  if (incomingKey) fields[incomingKey] = payment.date;
  const accountKey = first(FIELD_NAMES.bankAccount, template.fields);
  if (accountKey && ctx.ownAccount) fields[accountKey] = { ref: ctx.ownAccount };
  if (counterpartyKey && ctx.counterparty) fields[counterpartyKey] = { ref: ctx.counterparty };
  if (theirAccountKey && ctx.counterpartyAccount) fields[theirAccountKey] = { ref: ctx.counterpartyAccount };
  const contractKey = first(FIELD_NAMES.contract, template.fields);
  if (contractKey && ctx.contract) fields[contractKey] = { ref: ctx.contract };
  // The date is the standard attribute: its name is the one the earlier document was read with.
  fields[first(FIELD_NAMES.date, template.fields) ?? "Дата"] = payment.date;

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
    if (ctx.contract && "ДоговорКонтрагента" in row) scaled["ДоговорКонтрагента"] = { ref: ctx.contract };
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

/** Only exact matches are "already in 1C": the same day, counterparty and amount. */
const sameKey = (date: string, counterparty: string, amount: number) =>
  `${day(date)}|${counterparty}|${Math.round(amount * 100)}`;

const label = (p: BankPayment) =>
  p.inn ? `${p.counterparty} (INN ${p.inn})` : p.counterparty || "(no name)";

export async function resolvePayments(
  statement: BankStatement,
  options: { companyInn?: string; overrides?: BankOverrides; cache?: BankCache; only?: number[] },
  deps: BankDeps,
): Promise<BankResolved> {
  const overrides = options.overrides ?? {};
  const cache = options.cache ?? { lists: new Map(), snapshots: new Map() };
  const problems: BankProblem[] = [];
  const notes: BankNote[] = [];
  const alreadyIn1c: number[] = [];
  const wanted = options.only ? new Set(options.only) : null;
  let payments = statement.payments.filter((p) => !wanted || wanted.has(p.row));
  const nothing = (): BankResolved => ({ ready: [], alreadyIn1c, problems, notes });

  const grouped = new Map<string, BankProblem>();
  const addProblem = (
    p: BankPayment,
    code: BankProblem["code"],
    message: string,
    candidates?: BankCandidate[],
  ) => {
    const key = `${code}|${message}|${p.inn || p.counterparty}`;
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
  const addNote = (rows: number[], message: string) => {
    const existing = notes.find((n) => n.message === message);
    if (existing) existing.rows.push(...rows);
    else notes.push({ rows, message });
  };

  // 1. Payments the program's own checks stop.
  const stopped = new Map<number, string[]>();
  for (const issue of statement.issues) {
    if (BLOCKING.includes(issue.code))
      stopped.set(issue.row, [...(stopped.get(issue.row) ?? []), issue.message]);
  }
  for (const p of payments.filter((x) => stopped.has(x.row))) {
    addProblem(p, "CHECK", (stopped.get(p.row) ?? []).join("; "));
  }
  payments = payments.filter((p) => !stopped.has(p.row));
  if (payments.length === 0) return nothing();

  // 2. The organization's own bank account. Not finding it is not a stop: the copied document keeps its own.
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
      return ref ? [ref] : [];
    });
    const [only] = found;
    if (found.length === 1 && only) ownAccount = only;
    else if (rows) {
      addNote(
        payments.map((p) => p.row),
        found.length === 0
          ? `no bank account ${statement.account} in 1C: each document keeps the account of the payment it was copied from`
          : `${found.length} bank accounts have the number ${statement.account}: each document keeps the account of the payment it was copied from`,
      );
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

  // A payment with no INN (acquiring, bank fees) is copied from a payment of the same kind: no counterparty is needed.
  const withCounterparty: { payment: BankPayment; counterparty: string | null }[] = [];
  for (const p of payments) {
    const chosen = overrides.counterparties?.find((o) => o.row === p.row);
    if (chosen) {
      withCounterparty.push({ payment: p, counterparty: chosen.ref });
      continue;
    }
    if (p.inn === "") {
      withCounterparty.push({ payment: p, counterparty: null });
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
  if (withCounterparty.length === 0) return nothing();

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
      if (typeof cells[2] === "number")
        existing.add(`${direction}|${sameKey(String(cells[1]), refOf(cells[0]) ?? "", cells[2])}`);
    }
  }

  // 5. The contracts the purposes name, and the counterparties' bank accounts, by INN.
  const mentions = new Map<number, { number: string; date: string }>();
  for (const { payment } of withCounterparty) {
    const mention = payment.inn ? contractMention(payment.purpose) : null;
    if (mention) mentions.set(payment.row, mention);
  }
  const contractInns = [
    ...new Set(withCounterparty.filter(({ payment }) => mentions.has(payment.row)).map((x) => x.payment.inn)),
  ];
  const contractsOf = new Map<string, { ref: string; number: string; date: string }[]>();
  for (const { cells } of contractInns.length
    ? ((await lookup(
        deps,
        (ph) =>
          `ВЫБРАТЬ Т.Владелец.ИНН КАК ИНН, Т.Ссылка КАК Ссылка, Т.Номер КАК Номер, Т.Дата КАК Дата ИЗ Справочник.ДоговорыКонтрагентов КАК Т ГДЕ Т.Владелец.ИНН В (${ph}) И НЕ Т.ПометкаУдаления`,
        contractInns,
      )) ?? [])
    : []) {
    const ref = refOf(cells[1]);
    if (ref) {
      const list = contractsOf.get(String(cells[0])) ?? [];
      list.push({ ref, number: String(cells[2] ?? ""), date: day(String(cells[3] ?? "")) });
      contractsOf.set(String(cells[0]), list);
    }
  }
  const accountInns = [
    ...new Set(withCounterparty.filter((x) => x.payment.inn && x.payment.account).map((x) => x.payment.inn)),
  ];
  const accountsOf = new Map<string, string>();
  for (const { cells } of accountInns.length
    ? ((await lookup(
        deps,
        (ph) =>
          `ВЫБРАТЬ Т.Владелец.ИНН КАК ИНН, Т.Ссылка КАК Ссылка, Т.НомерСчета КАК НомерСчета ИЗ Справочник.БанковскиеСчета КАК Т ГДЕ Т.Владелец.ИНН В (${ph}) И НЕ Т.ПометкаУдаления`,
        accountInns,
      )) ?? [])
    : []) {
    const ref = refOf(cells[1]);
    if (ref) accountsOf.set(`${String(cells[0])}|${String(cells[2] ?? "").replace(/\D/g, "")}`, ref);
  }

  // 6. A copy of the counterparty's newest payment of the same kind, per payment.
  const ready: BankResolved["ready"] = [];
  for (const { payment, counterparty } of withCounterparty) {
    if (
      existing.has(`${payment.direction}|${sameKey(payment.date, counterparty ?? "", payment.amount / 100)}`)
    ) {
      alreadyIn1c.push(payment.row);
      continue;
    }
    const object = OBJECT[payment.direction];
    const asked = overrides.templates?.find((o) => o.row === payment.row);
    // A tax payment is copied only from a document the model names (the company's own correct tax payment).
    if (!asked && isTaxPayment(payment)) {
      addProblem(
        payment,
        "TAX_PAYMENT",
        "looks like a tax or budget payment: it needs the «Уплата налога» operation, the tax, its period and the tax office, not a copy of an earlier supplier payment. Answer with templates (a posted «Уплата налога» document of the company, for the same tax) or enter it with propose_changes",
      );
      continue;
    }
    const template = asked
      ? await snapshot(deps, cache, object, asked.ref)
      : await findTemplate(deps, cache, object, payment);
    if (!template) {
      addProblem(
        payment,
        "NO_TEMPLATE",
        `no earlier posted ${object.replace("Документ.", "")} of this kind to copy: answer with templates (a posted document of the same kind) or enter it with propose_changes`,
      );
      continue;
    }

    let contract: string | null = null;
    const mention = mentions.get(payment.row);
    if (mention) {
      const list = contractsOf.get(payment.inn) ?? [];
      const match = list.filter(
        (c) => normalNumber(c.number) === normalNumber(mention.number) && c.date === mention.date,
      );
      const [only] = match;
      if (match.length === 1 && only) contract = only.ref;
      else {
        addNote(
          [payment.row],
          `the purpose names contract ${mention.number} of ${mention.date.split("-").reverse().join(".")}, which 1C ${list.length === 0 ? "does not have for this counterparty" : `does not have (it has ${list.map((c) => `${c.number} of ${c.date.split("-").reverse().join(".")}`).join(", ")})`}: the contract of the payment it was copied from is used`,
        );
      }
    }
    const made = copyTemplate(template, payment, {
      counterparty,
      contract,
      ownAccount,
      counterpartyAccount: accountsOf.get(`${payment.inn}|${payment.account}`) ?? null,
    });
    if (!made.ok) {
      addProblem(payment, "BAD_TEMPLATE", made.message);
      continue;
    }
    ready.push({ payment, change: made.change });
  }
  return { ready, alreadyIn1c, problems, notes };
}

async function snapshot(
  deps: BankDeps,
  cache: BankCache,
  object: string,
  ref: string,
): Promise<Template | null> {
  const key = `${object}|${ref}`;
  if (cache.snapshots.has(key)) return cache.snapshots.get(key) ?? null;
  const outcome = await deps.getObject(object, ref);
  let template: Template | null = null;
  if (outcome.ok) {
    const data = outcome.data as {
      fields?: Record<string, unknown>;
      tables?: Record<string, Record<string, unknown>[]>;
    };
    template = { object, ref, fields: data.fields ?? {}, tables: data.tables ?? {} };
  }
  cache.snapshots.set(key, template);
  return template;
}

/**
 * The document to copy for a payment. With an INN: the counterparty's newest posted payment of the
 * same kind, preferring one whose purpose says the same kind of thing (a fee, not a refund). With
 * none (acquiring, bank fees): the newest posted payment whose purpose has the same words.
 */
async function findTemplate(
  deps: BankDeps,
  cache: BankCache,
  object: string,
  payment: BankPayment,
): Promise<Template | null> {
  const key = `${object}|${payment.inn || "*"}`;
  let list = cache.lists.get(key);
  if (!list) {
    const outcome = await deps.query({
      query: payment.inn
        ? `ВЫБРАТЬ ПЕРВЫЕ 20 Т.Ссылка КАК Ссылка, Т.НазначениеПлатежа КАК Назначение ИЗ ${object} КАК Т ГДЕ Т.Проведен И Т.Контрагент.ИНН = &инн УПОРЯДОЧИТЬ ПО Т.Дата УБЫВ`
        : `ВЫБРАТЬ ПЕРВЫЕ 300 Т.Ссылка КАК Ссылка, Т.НазначениеПлатежа КАК Назначение ИЗ ${object} КАК Т ГДЕ Т.Проведен УПОРЯДОЧИТЬ ПО Т.Дата УБЫВ`,
      ...(payment.inn ? { params: { инн: payment.inn } } : {}),
      limit: payment.inn ? 20 : 300,
      refs: true,
    });
    list = outcome.ok
      ? ((outcome.data as { rows?: unknown[][] }).rows ?? []).flatMap((cells) => {
          const ref = refOf(cells[0]);
          return ref ? [{ ref, purpose: String(cells[1] ?? "") }] : [];
        })
      : [];
    cache.lists.set(key, list);
  }
  const shape = shapeOf(payment.purpose);
  const same = shape.length >= 8 ? list.find((c) => shapeOf(c.purpose) === shape) : undefined;
  const chosen = same ?? (payment.inn ? list[0] : undefined);
  return chosen ? snapshot(deps, cache, object, chosen.ref) : null;
}
