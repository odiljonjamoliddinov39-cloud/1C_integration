/**
 * Reading what the financial reports need from 1C (the ledger's balances and turnovers, by counterparty, by item) and
 * handing it to the pure builders in financial.ts. The queries are plain: one read per report (two for the balance,
 * which also reads the year's turnovers to check its profit against the result), and a failed read comes back as 1C's
 * own message, not as an empty report.
 */
import type { FinancialReportInput } from "@platform/shared";

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

const accountRows = (data: unknown): AccountRow[] =>
  rowsOf(data).flatMap((c) =>
    String(c[0] ?? "")
      ? [{ code: String(c[0]), name: String(c[1] ?? ""), debit: num(c[2]), credit: num(c[3]) }]
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

export async function financialReport(
  run: RunQuery,
  input: FinancialReportInput,
  today: string,
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
