/**
 * What the declaration needs from the company's own 1C, read once and read-only: whether the contract named in graph 44 is
 * there for this supplier (V12), and which accounts the base already uses for the roles of the postings (the program never
 * invents an account; it takes them from documents the accountant has posted):
 *
 *   customs payments   bank payments to the customs: the debit account is the customs settlement account, the credit account
 *                      is the bank account the money left from;
 *   goods              the supplier's earlier receipts: the debit account is where this company keeps the goods, the credit
 *                      account is its foreign supplier settlements.
 */
import type { RunQueryInput } from "@platform/shared";

import type { QueryOutcome } from "../didox/resolve.js";
import { squashName } from "../bank/swift.js";
import { rowsOfPeriod } from "../query-window.js";
import { type GtdAccounts, emptyAccounts } from "./proposal.js";
import type { ContractLookup } from "./validate.js";

export interface GtdDeps {
  query: (input: RunQueryInput) => Promise<QueryOutcome>;
}

const text = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
/** A name or a number compared by its letters and digits only. */
const core = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** The contract of graph 44 (code 202) among the contracts 1C has, and whose it is. */
export async function lookupContract(
  deps: GtdDeps,
  contractNo: string | null,
  exporter: string | null,
): Promise<ContractLookup> {
  if (!contractNo) return { status: "unknown", detail: "the contract number was not read" };
  const wanted = core(contractNo);
  const tail = contractNo.trim();
  const outcome = await deps.query({
    query:
      "ВЫБРАТЬ Т.Номер КАК Номер, Т.Дата КАК Дата, ПРЕДСТАВЛЕНИЕ(Т.Владелец) КАК Владелец " +
      "ИЗ Справочник.ДоговорыКонтрагентов КАК Т " +
      "ГДЕ НЕ Т.ПометкаУдаления И (Т.Номер = &Номер ИЛИ Т.Номер ПОДОБНО &Маска)",
    params: { Номер: tail, Маска: `%${tail.replace(/[%_]/g, "")}%` },
    limit: 200,
  });
  if (!outcome.ok)
    return {
      status: "unknown",
      detail: "1C could not be asked for its contracts: the contract was not checked",
    };
  const rows = ((outcome.data as { rows?: unknown[][] }).rows ?? []).map((r) => ({
    no: text(r[0]),
    date: text(r[1]).slice(0, 10),
    owner: text(r[2]),
  }));
  const same = rows.filter((r) => core(r.no) === wanted);
  if (same.length === 0)
    return {
      status: "not_found",
      detail: `1C has no contract ${contractNo}: create it (and the supplier) first, or the contract number was misread`,
    };
  if (!exporter)
    return { status: "found", detail: `contract ${contractNo} is in 1C (the supplier was not compared)` };
  const key = squashName(exporter);
  const mine = same.filter((r) => {
    const owner = squashName(r.owner);
    return owner.length > 0 && key.length > 0 && (owner.includes(key) || key.includes(owner));
  });
  if (mine.length > 0)
    return { status: "found", detail: `contract ${mine[0]?.no} of ${mine[0]?.owner} is in 1C` };
  return {
    status: "not_found",
    detail: `contract ${contractNo} is in 1C only under another counterparty (${[...new Set(same.map((r) => r.owner))].join("; ")}), not under ${exporter}`,
  };
}

const CUSTOMS = /таможен|божхон|bojxona|customs/iu;

const mostCommon = (codes: string[]): { code: string; count: number } | null => {
  const counts = new Map<string, number>();
  for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  return top ? { code: top[0], count: top[1] } : null;
};

export interface AccountsResult {
  accounts: GtdAccounts;
  /** Why a role could not be filled, for the accountant. */
  notes: string[];
}

/** The accounts the base uses for the roles of the postings, from the entries of the last year (nothing guessed). */
export async function resolveAccounts(
  deps: GtdDeps,
  options: { exporter: string | null; today: string },
): Promise<AccountsResult> {
  const accounts = emptyAccounts();
  const notes: string[] = [];
  const year = Number(options.today.slice(0, 4));
  const from = `${year - 1}${options.today.slice(4)}`;
  const entries = await rowsOfPeriod(
    deps,
    "ВЫБРАТЬ Х.СчетДт.Код КАК Дт, Х.СчетКт.Код КАК Кт, ПРЕДСТАВЛЕНИЕ(Х.СубконтоДт1) КАК Дебет, ПРЕДСТАВЛЕНИЕ(Х.СубконтоКт1) КАК Кредит " +
      "ИЗ РегистрБухгалтерии.Хозрасчетный КАК Х " +
      'ГДЕ Х.Период МЕЖДУ &начало И &конец И Х.Активность И (Х.СчетКт.Код ПОДОБНО "51%" ИЛИ Х.СчетКт.Код ПОДОБНО "60%")',
    from,
    options.today,
  );
  if (!entries) {
    notes.push("1C could not be asked for its entries: the accounts of the postings are all open");
    return { accounts, notes };
  }
  const rows = entries.map((r) => ({
    dt: text(r[0]),
    kt: text(r[1]),
    debit: text(r[2]),
    credit: text(r[3]),
  }));

  // Customs payments: the money left a bank account (Кт 51xx) for the customs (the debit side's counterparty).
  const paid = rows.filter((r) => r.kt.startsWith("51") && CUSTOMS.test(r.debit) && !r.dt.startsWith("51"));
  const settlement = mostCommon(paid.map((r) => r.dt));
  const bank = mostCommon(paid.map((r) => r.kt));
  if (settlement) {
    accounts.customsSettlement = {
      ...accounts.customsSettlement,
      code: settlement.code,
      source: "base",
      evidence: `${settlement.count} of ${paid.length} posted payments to the customs`,
    };
    if (bank)
      accounts.bank = {
        ...accounts.bank,
        code: bank.code,
        source: "base",
        evidence: `${bank.count} of ${paid.length} payments to the customs`,
      };
  } else
    notes.push(
      "1C has no posted payment to the customs in the last year: the customs settlement account is open",
    );

  // The supplier's receipts: Кт 60xx with the supplier on the credit side; the debit is where the goods are kept.
  const key = options.exporter ? squashName(options.exporter) : "";
  const supplier = key
    ? rows.filter((r) => {
        const name = squashName(r.credit);
        return r.kt.startsWith("60") && name.length > 0 && (name.includes(key) || key.includes(name));
      })
    : [];
  const goods = mostCommon(supplier.filter((r) => /^[12]/.test(r.dt)).map((r) => r.dt));
  const settlements = mostCommon(supplier.map((r) => r.kt));
  if (goods) {
    accounts.goods = {
      ...accounts.goods,
      code: goods.code,
      source: "base",
      evidence: `${goods.count} earlier receipts from ${options.exporter}`,
    };
    if (settlements)
      accounts.foreignSupplier = {
        ...accounts.foreignSupplier,
        code: settlements.code,
        source: "base",
        evidence: `${settlements.count} entries with ${options.exporter}`,
      };
  } else
    notes.push(
      `1C has no earlier receipt from ${options.exporter ?? "this supplier"}: the account the goods are kept on is open (the spec expects ${accounts.goods.suggested}, but it is not taken without a posted example)`,
    );
  return { accounts, notes };
}
