/**
 * Reading what the financial reports need from 1C (the ledger's balances and turnovers, by counterparty, by item) and
 * handing it to the pure builders in financial.ts. The queries are plain: one read per report (two for the balance,
 * which also reads the year's turnovers to check its profit against the result), and a failed read comes back as 1C's
 * own message, not as an empty report.
 */
import type { FinancialReportInput } from "@platform/shared";

import { ageDebts, type DebtEntry } from "./aging.js";
import { type StatementBalance, type BookBalance, reconcileBank } from "./bank-reconcile.js";
import { type ExplainRow, explainResult, previousPeriod } from "./explain.js";
import {
  type RegisterDoc,
  accrueProfitTax,
  compareRegisters,
  turnoverTax,
  upcomingDeadlines,
  vatPosition,
} from "./tax-accrual.js";
import { type Context } from "./posting-rules.js";
import { type CostMethod, checkCost } from "./stock-cost.js";
import { DEFAULT_PROFILE, type TaxProfile } from "./tax-tables.js";
import {
  type AccountRow,
  type PartyRow,
  type StockRow,
  buildBalance,
  buildDebts,
  buildResult,
  buildStock,
} from "./financial.js";

export type QueryResult = { ok: true; data: unknown } | { ok: false; code: string; message: string };
export type RunQuery = (query: string, params: Record<string, unknown>) => Promise<QueryResult>;

const num = (v: unknown) => Number(v) || 0;
const rowsOf = (data: unknown): unknown[][] => (data as { rows?: unknown[][] }).rows ?? [];
/** The most rows one 1C read returns (the tool's own cap). */
const LIMIT = 1000;

/** The ledger's balances per account at the end of a day. */
export const BALANCES_QUERY =
  "ВЫБРАТЬ Х.Счет.Код КАК Код, Х.Счет.Наименование КАК Имя, Х.СуммаОстатокДт КАК Дт, Х.СуммаОстатокКт КАК Кт " +
  "ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки(&Дата, , , ) КАК Х";

/** The ledger's turnovers per account between two dates, from the entries themselves (debit side, then credit side). */
export const TURNOVERS_QUERY =
  "ВЫБРАТЬ Х.СчетДт.Код КАК Код, Х.СчетДт.Наименование КАК Имя, СУММА(Х.Сумма) КАК Дт, 0 КАК Кт " +
  "ИЗ РегистрБухгалтерии.Хозрасчетный КАК Х ГДЕ Х.Период МЕЖДУ &Нач И &Кон И Х.Активность " +
  "СГРУППИРОВАТЬ ПО Х.СчетДт.Код, Х.СчетДт.Наименование " +
  "ОБЪЕДИНИТЬ ВСЕ " +
  "ВЫБРАТЬ Х.СчетКт.Код, Х.СчетКт.Наименование, 0, СУММА(Х.Сумма) " +
  "ИЗ РегистрБухгалтерии.Хозрасчетный КАК Х ГДЕ Х.Период МЕЖДУ &Нач И &Кон И Х.Активность " +
  "СГРУППИРОВАТЬ ПО Х.СчетКт.Код, Х.СчетКт.Наименование";

/** Balances of the settlement accounts by their first analytic (the counterparty). */
export const PARTIES_QUERY =
  "ВЫБРАТЬ ПРЕДСТАВЛЕНИЕ(Х.Субконто1) КАК Субъект, СУММА(Х.СуммаОстатокДт) КАК Дт, СУММА(Х.СуммаОстатокКт) КАК Кт " +
  "ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки(&Дата, , , ) КАК Х ГДЕ Х.Счет.Код ПОДОБНО &Маска " +
  "СГРУППИРОВАТЬ ПО ПРЕДСТАВЛЕНИЕ(Х.Субконто1)";

/** Stock and production accounts by item and warehouse (the first two analytics), with quantity. */
export const STOCK_QUERY =
  "ВЫБРАТЬ ПРЕДСТАВЛЕНИЕ(Х.Субконто1) КАК Номенклатура, ПРЕДСТАВЛЕНИЕ(Х.Субконто2) КАК Склад, " +
  "СУММА(Х.КоличествоОстатокДт - Х.КоличествоОстатокКт) КАК Кол, СУММА(Х.СуммаОстатокДт - Х.СуммаОстатокКт) КАК Сумма " +
  "ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки(&Дата, , , ) КАК Х " +
  "ГДЕ Х.Счет.Код ПОДОБНО &Маска1 ИЛИ Х.Счет.Код ПОДОБНО &Маска2 " +
  "СГРУППИРОВАТЬ ПО ПРЕДСТАВЛЕНИЕ(Х.Субконто1), ПРЕДСТАВЛЕНИЕ(Х.Субконто2) УПОРЯДОЧИТЬ ПО Сумма УБЫВ";

/** Entries by who (the first analytic) and account, for what moved the result: accounts 9xxx only. */
export const EXPLAIN_QUERY =
  "ВЫБРАТЬ Х.СчетДт.Код КАК Код, ПРЕДСТАВЛЕНИЕ(Х.СубконтоДт1) КАК Кто, СУММА(Х.Сумма) КАК Дт, 0 КАК Кт " +
  "ИЗ РегистрБухгалтерии.Хозрасчетный КАК Х ГДЕ Х.Период МЕЖДУ &Нач И &Кон И Х.Активность И Х.СчетДт.Код ПОДОБНО &Маска " +
  "СГРУППИРОВАТЬ ПО Х.СчетДт.Код, ПРЕДСТАВЛЕНИЕ(Х.СубконтоДт1) " +
  "ОБЪЕДИНИТЬ ВСЕ " +
  "ВЫБРАТЬ Х.СчетКт.Код, ПРЕДСТАВЛЕНИЕ(Х.СубконтоКт1), 0, СУММА(Х.Сумма) " +
  "ИЗ РегистрБухгалтерии.Хозрасчетный КАК Х ГДЕ Х.Период МЕЖДУ &Нач И &Кон И Х.Активность И Х.СчетКт.Код ПОДОБНО &Маска " +
  "СГРУППИРОВАТЬ ПО Х.СчетКт.Код, ПРЕДСТАВЛЕНИЕ(Х.СубконтоКт1)";

/** The settlement accounts' entries by counterparty and day, both sides (aging). */
export const DEBT_ENTRIES_QUERY =
  "ВЫБРАТЬ ПРЕДСТАВЛЕНИЕ(Х.СубконтоДт1) КАК Кто, НАЧАЛОПЕРИОДА(Х.Период, ДЕНЬ) КАК День, СУММА(Х.Сумма) КАК Дт, 0 КАК Кт " +
  "ИЗ РегистрБухгалтерии.Хозрасчетный КАК Х ГДЕ Х.Период МЕЖДУ &Нач И &Кон И Х.Активность И Х.СчетДт.Код ПОДОБНО &Маска " +
  "СГРУППИРОВАТЬ ПО ПРЕДСТАВЛЕНИЕ(Х.СубконтоДт1), НАЧАЛОПЕРИОДА(Х.Период, ДЕНЬ) " +
  "ОБЪЕДИНИТЬ ВСЕ " +
  "ВЫБРАТЬ ПРЕДСТАВЛЕНИЕ(Х.СубконтоКт1), НАЧАЛОПЕРИОДА(Х.Период, ДЕНЬ), 0, СУММА(Х.Сумма) " +
  "ИЗ РегистрБухгалтерии.Хозрасчетный КАК Х ГДЕ Х.Период МЕЖДУ &Нач И &Кон И Х.Активность И Х.СчетКт.Код ПОДОБНО &Маска " +
  "СГРУППИРОВАТЬ ПО ПРЕДСТАВЛЕНИЕ(Х.СубконтоКт1), НАЧАЛОПЕРИОДА(Х.Период, ДЕНЬ)";

/** VAT charged on sales (credit 6410 against receivables) and VAT to offset (debit 4410), by month. */
export const VAT_QUERY =
  "ВЫБРАТЬ НАЧАЛОПЕРИОДА(Х.Период, МЕСЯЦ) КАК Месяц, 1 КАК Вид, СУММА(Х.Сумма) КАК Сумма " +
  "ИЗ РегистрБухгалтерии.Хозрасчетный КАК Х ГДЕ Х.Период МЕЖДУ &Нач И &Кон И Х.Активность " +
  "И Х.СчетКт.Код ПОДОБНО &Выход И Х.СчетДт.Код ПОДОБНО &Дебиторы СГРУППИРОВАТЬ ПО НАЧАЛОПЕРИОДА(Х.Период, МЕСЯЦ) " +
  "ОБЪЕДИНИТЬ ВСЕ " +
  "ВЫБРАТЬ НАЧАЛОПЕРИОДА(Х.Период, МЕСЯЦ), 2, СУММА(Х.Сумма) " +
  "ИЗ РегистрБухгалтерии.Хозрасчетный КАК Х ГДЕ Х.Период МЕЖДУ &Нач И &Кон И Х.Активность " +
  "И Х.СчетДт.Код ПОДОБНО &Вход СГРУППИРОВАТЬ ПО НАЧАЛОПЕРИОДА(Х.Период, МЕСЯЦ)";

/** The balance of the bank accounts in 1C, by the account number, in soums and in the account's currency. */
export const BANK_BOOKS_QUERY =
  "ВЫБРАТЬ Х.Субконто1.НомерСчета КАК Счет, СУММА(Х.СуммаОстатокДт - Х.СуммаОстатокКт) КАК Сум, " +
  "СУММА(Х.ВалютнаяСуммаОстатокДт - Х.ВалютнаяСуммаОстатокКт) КАК Вал " +
  "ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки(&Дата, , , ) КАК Х ГДЕ Х.Счет.Код ПОДОБНО &Маска " +
  "СГРУППИРОВАТЬ ПО Х.Субконто1.НомерСчета";

const dayOf = (v: unknown): string => {
  const text = String(v ?? "");
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const t = Date.parse(text);
  return Number.isNaN(t) ? "" : new Date(t).toISOString().slice(0, 10);
};

const accountRows = (data: unknown): AccountRow[] =>
  rowsOf(data).flatMap((c) =>
    String(c[0] ?? "")
      ? [{ code: String(c[0]), name: String(c[1] ?? ""), debit: num(c[2]), credit: num(c[3]) }]
      : [],
  );

const explainRows = (data: unknown): ExplainRow[] =>
  rowsOf(data).flatMap((c) =>
    String(c[0] ?? "")
      ? [{ account: String(c[0]), who: String(c[1] ?? ""), debit: num(c[2]), credit: num(c[3]) }]
      : [],
  );

export async function readBalances(run: RunQuery, date: string) {
  const read = await run(BALANCES_QUERY, { Дата: `${date}T23:59:59` });
  return read.ok ? { ok: true as const, rows: accountRows(read.data) } : read;
}

async function readTurnovers(run: RunQuery, from: string, to: string) {
  const read = await run(TURNOVERS_QUERY, { Нач: `${from}T00:00:00`, Кон: `${to}T23:59:59` });
  return read.ok ? { ok: true as const, rows: accountRows(read.data) } : read;
}

export type Describe = (objects: string[]) => Promise<QueryResult>;

/**
 * The invoices of a kind in 1C for a period, with the counterparty's INN, as a VAT register. The base's own names of
 * the incoming number, its date and the amount are found from the object's description, not assumed.
 */
export async function readInvoiceRegister(
  run: RunQuery,
  describe: Describe,
  object: "Документ.СчетФактураПолученный" | "Документ.СчетФактураВыданный",
  from: string,
  to: string,
): Promise<
  { ok: true; docs: RegisterDoc[]; amounts: boolean } | { ok: false; code: string; message: string }
> {
  const described = await describe([object]);
  if (!described.ok) return described;
  const attrs = ((described.data as { attributes?: { name: string }[] }[])[0]?.attributes ?? []).map(
    (a) => a.name,
  );
  const pick = (...res: RegExp[]) => res.map((re) => attrs.find((n) => re.test(n))).find(Boolean);
  const number = pick(/^(НомерВходящ|ВходящийНомер|НомерВходящего)/i) ?? "Номер";
  const date = pick(/^(ДатаВходящ|ВходящаяДата|ДатаВходящего)/i) ?? "Дата";
  const amount = pick(/^СуммаДокумента$/i, /^Сумма$/i, /^СуммаВсего$/i);
  const read = await run(
    `ВЫБРАТЬ Д.${number} КАК Номер, Д.${date} КАК Дата, Д.Контрагент.ИНН КАК ИНН${amount ? `, Д.${amount} КАК Сумма` : ""} ` +
      `ИЗ ${object} КАК Д ГДЕ Д.Дата МЕЖДУ &Нач И &Кон И НЕ Д.ПометкаУдаления`,
    { Нач: `${from}T00:00:00`, Кон: `${to}T23:59:59` },
  );
  if (!read.ok) return read;
  return {
    ok: true,
    amounts: Boolean(amount),
    docs: rowsOf(read.data).map((c) => ({
      number: String(c[0] ?? ""),
      date: dayOf(c[1]),
      inn: String(c[2] ?? ""),
      amount: amount ? num(c[3]) : 0,
    })),
  };
}

/** The movements of one item on the stock accounts, by day: quantity and cost in and out. */
export const ITEM_MOVES_QUERY =
  "ВЫБРАТЬ НАЧАЛОПЕРИОДА(Х.Период, ДЕНЬ) КАК День, СУММА(Х.КоличествоДт) КАК КолДт, СУММА(Х.Сумма) КАК СумДт, 0 КАК КолКт, 0 КАК СумКт " +
  "ИЗ РегистрБухгалтерии.Хозрасчетный КАК Х ГДЕ Х.Период <= &Кон И Х.Активность И ПРЕДСТАВЛЕНИЕ(Х.СубконтоДт1) = &Товар " +
  "И (Х.СчетДт.Код ПОДОБНО &М1 ИЛИ Х.СчетДт.Код ПОДОБНО &М2 ИЛИ Х.СчетДт.Код ПОДОБНО &М3) СГРУППИРОВАТЬ ПО НАЧАЛОПЕРИОДА(Х.Период, ДЕНЬ) " +
  "ОБЪЕДИНИТЬ ВСЕ " +
  "ВЫБРАТЬ НАЧАЛОПЕРИОДА(Х.Период, ДЕНЬ), 0, 0, СУММА(Х.КоличествоКт), СУММА(Х.Сумма) " +
  "ИЗ РегистрБухгалтерии.Хозрасчетный КАК Х ГДЕ Х.Период <= &Кон И Х.Активность И ПРЕДСТАВЛЕНИЕ(Х.СубконтоКт1) = &Товар " +
  "И (Х.СчетКт.Код ПОДОБНО &М1 ИЛИ Х.СчетКт.Код ПОДОБНО &М2 ИЛИ Х.СчетКт.Код ПОДОБНО &М3) СГРУППИРОВАТЬ ПО НАЧАЛОПЕРИОДА(Х.Период, ДЕНЬ)";

export interface ReportContext {
  /** The company's own posting rules and its chart of accounts (the entry of a tax accrual comes from them). */
  posting?: Context;
  /** The company's stock cost method (stock_cost); absent: the accountant must name it. */
  costMethod?: CostMethod | null;
  /** The documents Didox holds for the period, by direction (tax.registers); read by the assistant. */
  didox?: { incoming: RegisterDoc[]; outgoing: RegisterDoc[] };
  describe?: Describe;
  profile?: TaxProfile | null;
  /** The bank statements attached to the chat (bank.reconcile). */
  statements?: StatementBalance[];
}

const addDays = (date: string, n: number) =>
  new Date(Date.parse(date) + n * 86_400_000).toISOString().slice(0, 10);

export async function financialReport(
  run: RunQuery,
  input: FinancialReportInput,
  today: string,
  context: ReportContext = {},
): Promise<QueryResult> {
  const now = today.slice(0, 10);
  const year = now.slice(0, 4);
  switch (input.report) {
    case "result": {
      const from = input.from ?? `${year}-01-01`;
      const to = input.to ?? now;
      const read = await readTurnovers(run, from, to);
      if (!read.ok) return read;
      return { ok: true, data: { report: "result", ...buildResult(read.rows, { from, to }, now) } };
    }
    case "balance": {
      const date = input.date ?? input.to ?? now;
      const read = await readBalances(run, date);
      if (!read.ok) return read;
      // The profit of the open year in the balance is checked against the result of the year to that date.
      const turnovers = await readTurnovers(run, `${date.slice(0, 4)}-01-01`, date);
      const resultNet = turnovers.ok
        ? buildResult(turnovers.rows, { from: `${date.slice(0, 4)}-01-01`, to: date }, now).netProfit
        : undefined;
      return { ok: true, data: { report: "balance", ...buildBalance(read.rows, date, resultNet) } };
    }
    case "receivables":
    case "payables": {
      const date = input.date ?? input.to ?? now;
      const read = await run(PARTIES_QUERY, {
        Дата: `${date}T23:59:59`,
        Маска: input.report === "receivables" ? "4%" : "6%",
      });
      if (!read.ok) return read;
      const rows: PartyRow[] = rowsOf(read.data).map((c) => ({
        party: String(c[0] ?? ""),
        debit: num(c[1]),
        credit: num(c[2]),
      }));
      return { ok: true, data: { report: input.report, ...buildDebts(input.report, rows, date) } };
    }
    case "result_explain": {
      const from = input.from ?? `${year}-01-01`;
      const to = input.to ?? now;
      const before = previousPeriod(from, to);
      const read = async (a: string, b: string) => {
        const got = await run(EXPLAIN_QUERY, { Нач: `${a}T00:00:00`, Кон: `${b}T23:59:59`, Маска: "9%" });
        return got.ok ? { ok: true as const, rows: explainRows(got.data) } : got;
      };
      const [now1, before1] = [await read(from, to), await read(before.from, before.to)];
      if (!now1.ok) return now1;
      return {
        ok: true,
        data: {
          report: "result_explain",
          from,
          to,
          before,
          groups: explainResult(now1.rows, before1.ok ? before1.rows : undefined),
        },
      };
    }
    case "aging_receivables":
    case "aging_payables": {
      const date = input.date ?? input.to ?? now;
      const kind = input.report === "aging_receivables" ? "receivables" : "payables";
      const mask = kind === "receivables" ? "4%" : "6%";
      const start = addDays(date, -365);
      const entries = await run(DEBT_ENTRIES_QUERY, {
        Нач: `${start}T00:00:00`,
        Кон: `${date}T23:59:59`,
        Маска: mask,
      });
      if (!entries.ok) return entries;
      const opening = await run(PARTIES_QUERY, { Дата: `${addDays(start, -1)}T23:59:59`, Маска: mask });
      const list: DebtEntry[] = rowsOf(entries.data).flatMap((c) => {
        const day = dayOf(c[1]);
        return day ? [{ party: String(c[0] ?? ""), date: day, debit: num(c[2]), credit: num(c[3]) }] : [];
      });
      // What stood at the start of the window is one item as old as the window.
      if (opening.ok)
        for (const c of rowsOf(opening.data))
          list.push({
            party: String(c[0] ?? ""),
            date: addDays(start, -1),
            debit: num(c[1]),
            credit: num(c[2]),
          });
      const truncated = Boolean((entries.data as { truncated?: boolean }).truncated);
      return { ok: true, data: { report: input.report, truncated, ...ageDebts(kind, list, date) } };
    }
    case "tax_accrual": {
      const to = input.to ?? input.date ?? now;
      const from = input.from ?? `${to.slice(0, 4)}-01-01`;
      const profile = context.profile ?? DEFAULT_PROFILE;
      const turnovers = await readTurnovers(run, from, to);
      if (!turnovers.ok) return turnovers;
      const result = buildResult(turnovers.rows, { from, to }, now);
      const profit =
        profile.regime === "turnover"
          ? null
          : accrueProfitTax(result.profitBeforeTax, result.tax.amount, to, profile, {
              posting: context.posting,
            });
      const turnover = profile.regime === "turnover" ? turnoverTax(result.revenue.amount, to, profile) : null;
      const vat = profile.vatPayer
        ? await run(VAT_QUERY, {
            Нач: `${from}T00:00:00`,
            Кон: `${to}T23:59:59`,
            Выход: "6410%",
            Дебиторы: "40%",
            Вход: "4410%",
          })
        : null;
      if (vat && !vat.ok) return vat;
      const months = vat?.ok
        ? rowsOf(vat.data).map((c) => ({
            month: dayOf(c[0]).slice(0, 7),
            output: Number(c[1]) === 1 ? num(c[2]) : 0,
            input: Number(c[1]) === 2 ? num(c[2]) : 0,
          }))
        : null;
      return {
        ok: true,
        data: {
          report: "tax_accrual",
          from,
          to,
          regime: profile.regime,
          profitBeforeTax: result.profitBeforeTax,
          revenue: result.revenue.amount,
          profit,
          turnover,
          vat: months ? vatPosition(months) : null,
        },
      };
    }
    case "tax_registers": {
      const from = input.from ?? `${year}-01-01`;
      const to = input.to ?? now;
      if (!context.didox || !context.describe)
        return {
          ok: false,
          code: "NO_DIDOX_CONNECTION",
          message: "Didox is not connected for this company.",
        };
      const out: Record<string, unknown> = {};
      for (const [key, object, theirs] of [
        ["incoming", "Документ.СчетФактураПолученный", context.didox.incoming],
        ["outgoing", "Документ.СчетФактураВыданный", context.didox.outgoing],
      ] as const) {
        const mine = await readInvoiceRegister(run, context.describe, object, from, to);
        if (!mine.ok) return mine;
        out[key] = {
          in1c: mine.docs.length,
          inDidox: theirs.length,
          amountsCompared: mine.amounts,
          ...compareRegisters(mine.docs, theirs, mine.amounts ? 1 : Number.POSITIVE_INFINITY),
        };
      }
      return { ok: true, data: { report: "tax_registers", from, to, ...out } };
    }
    case "tax_calendar": {
      const from = input.from ?? now;
      const to = input.to ?? addDays(from, 45);
      return {
        ok: true,
        data: {
          report: "tax_calendar",
          from,
          to,
          due: upcomingDeadlines(context.profile ?? DEFAULT_PROFILE, from, to),
        },
      };
    }
    case "bank_reconcile": {
      const statements = context.statements ?? [];
      if (statements.length === 0)
        return {
          ok: false,
          code: "NO_STATEMENT",
          message: "Attach the bank statement (Excel) to compare its closing balance with 1C.",
        };
      const rows: BookBalance[] = [];
      for (const date of new Set(statements.map((s) => s.date))) {
        const read = await run(BANK_BOOKS_QUERY, { Дата: `${date}T23:59:59`, Маска: "5%" });
        if (!read.ok) return read;
        for (const c of rowsOf(read.data))
          rows.push({ account: String(c[0] ?? ""), soum: num(c[1]), currency: num(c[2]) });
      }
      return { ok: true, data: { report: "bank_reconcile", ...reconcileBank(statements, rows) } };
    }
    case "stock_cost": {
      const method = input.method ?? context.costMethod;
      if (!method)
        return {
          ok: false,
          code: "COST_METHOD_MISSING",
          message:
            "The cost method of this company (average, FIFO or LIFO) is not set. It is the accountant's decision: ask which one the accounting policy uses, then call again with method.",
        };
      if (!input.item)
        return { ok: false, code: "ITEM_MISSING", message: "Name the item whose issues are to be checked." };
      const date = input.date ?? input.to ?? now;
      const read = await run(ITEM_MOVES_QUERY, {
        Кон: `${date}T23:59:59`,
        Товар: input.item,
        М1: "10%",
        М2: "28%",
        М3: "29%",
      });
      if (!read.ok) return read;
      const moves = rowsOf(read.data).flatMap((c) => {
        const day = dayOf(c[0]);
        return day
          ? [{ date: day, qtyIn: num(c[1]), sumIn: num(c[2]), qtyOut: num(c[3]), sumOut: num(c[4]) }]
          : [];
      });
      if (moves.length === 0)
        return {
          ok: false,
          code: "ITEM_NOT_FOUND",
          message: `No entries on the stock accounts for «${input.item}»: check the exact name.`,
        };
      return { ok: true, data: { report: "stock_cost", date, ...checkCost(input.item, moves, method) } };
    }
    case "stock_semi": {
      const date = input.date ?? input.to ?? now;
      const read = await run(STOCK_QUERY, { Дата: `${date}T23:59:59`, Маска1: "20%", Маска2: "21%" });
      if (!read.ok) return read;
      const rows: StockRow[] = rowsOf(read.data).map((c) => ({
        item: String(c[0] ?? ""),
        warehouse: String(c[1] ?? ""),
        qty: num(c[2]),
        amount: num(c[3]),
      }));
      const report = buildStock(rows, date);
      return { ok: true, data: { report: "stock_semi", producer: report.positions > 0, ...report } };
    }
    case "stock": {
      const date = input.date ?? input.to ?? now;
      const read = await run(STOCK_QUERY, { Дата: `${date}T23:59:59`, Маска1: "1%", Маска2: "2%" });
      if (!read.ok) return read;
      const rows: StockRow[] = rowsOf(read.data).map((c) => ({
        item: String(c[0] ?? ""),
        warehouse: String(c[1] ?? ""),
        qty: num(c[2]),
        amount: num(c[3]),
      }));
      const truncated = Boolean((read.data as { truncated?: boolean }).truncated);
      return { ok: true, data: { report: "stock", truncated, ...buildStock(rows, date) } };
    }
  }
}

export { LIMIT as REPORT_ROW_LIMIT };
