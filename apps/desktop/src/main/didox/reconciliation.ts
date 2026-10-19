/**
 * A reconciliation act (акт сверки) for Didox, built from the 1C document itself: the rows of both sides, the
 * contract and the period are read from 1C's `Документ.АктСверкиВзаиморасчетов`, and every sum (the turnover and
 * the balances of each contract and of the whole act) is worked out here in whole tiyin. Nothing is typed by the
 * model but the balance at the start of the period, which 1C's act does not keep (it comes from the accounts).
 * The body is Didox's verification act as its own 1C library lays it out (document type 052).
 */
import type { DidoxReconciliationPreview } from "../../shared/ipc.js";
import { type Party, sum } from "./outgoing.js";

/** Didox's code of a reconciliation act (the path of `/v1/documents/{docType}/create`). */
export const RECONCILIATION_DOCTYPE = "052";

export interface ReconProblem {
  code:
    | "NOT_AN_ACT"
    | "NO_PERIOD"
    | "NO_CONTRACT"
    | "NO_ROWS"
    | "NO_NUMBER"
    | "BAD_TIN"
    | "NO_PARTY"
    | "NO_SELLER_DATA"
    | "OPENING_CONTRACT";
  message: string;
}

/** Debit and credit of both sides, in tiyin. */
export interface Balance {
  ownerDebit: number;
  ownerCredit: number;
  partnerDebit: number;
  partnerCredit: number;
}
const zero = (): Balance => ({ ownerDebit: 0, ownerCredit: 0, partnerDebit: 0, partnerCredit: 0 });

/** What the model gives: the balance at the start of the period, from the accounts. In sum, not tiyin. */
export interface OpeningInput {
  /** The contract's number; absent: the act has one contract, or this is for all. */
  contract?: string | undefined;
  ownerDebit?: number | undefined;
  ownerCredit?: number | undefined;
  partnerDebit?: number | undefined;
  partnerCredit?: number | undefined;
}

interface Row {
  /** YYYY-MM-DD or "". */
  date: string;
  name: string;
  debit: number;
  credit: number;
  contract: { number: string; date: string } | null;
}

export interface ReconAct {
  number: string;
  /** YYYY-MM-DD. */
  date: string;
  from: string;
  to: string;
  /** The counterparty as 1C names it. */
  counterparty: string;
  contract: { number: string; date: string } | null;
  ownerRows: Row[];
  partnerRows: Row[];
}

interface Snapshot {
  fields: Record<string, unknown>;
  tables: Record<string, Record<string, unknown>[]>;
}

const text = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    return text(v.name ?? v.presentation ?? v.Представление ?? v.Наименование ?? "");
  }
  return "";
};

/** First of the columns that holds something. */
const pick = (row: Record<string, unknown>, names: string[]): unknown => {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
};

/** Tiyin out of a number (or numeric text) of sum; null when it is not one. */
function tiyin(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.replace(/\s/g, "").replace(",", "."))
        : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const day = (value: unknown): string => {
  const s = text(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(s);
  return dotted ? `${dotted[3]}-${dotted[2]}-${dotted[1]}` : "";
};

/** "№85 от 30.12.2025" as 1C shows a contract. */
export function parseContract(value: unknown): { number: string; date: string } | null {
  const match = /№\s*(.+?)\s+(?:от|from|dated)\s+(\d{2})\.(\d{2})\.(\d{4})/iu.exec(text(value));
  return match ? { number: match[1] ?? "", date: `${match[4]}-${match[3]}-${match[2]}` } : null;
}

function rowsOf(table: Record<string, unknown>[] | undefined): Row[] {
  return (table ?? []).map((row) => ({
    date: day(row.Дата),
    name: text(pick(row, ["Представление", "Документ", "Содержание", "Операция"])),
    debit: tiyin(pick(row, ["Дебет", "ДебетРегл", "Дт"])) ?? 0,
    credit: tiyin(pick(row, ["Кредит", "КредитРегл", "Кт"])) ?? 0,
    contract: parseContract(row.Договор),
  }));
}

/** The table of a side by the part of its name ("ПоДаннымОрганизации", "ПоДаннымКонтрагента"). */
function tableOf(tables: Snapshot["tables"], part: string): Record<string, unknown>[] | undefined {
  const key = Object.keys(tables).find((name) => name.toLowerCase().includes(part));
  return key ? tables[key] : undefined;
}

/** The act as 1C has it, or what is missing in it. */
export function readReconciliationAct(
  snapshot: Snapshot,
): { ok: true; act: ReconAct } | { ok: false; problems: ReconProblem[] } {
  const f = snapshot.fields;
  const problems: ReconProblem[] = [];
  const number = text(f.Номер);
  const date = day(f.Дата);
  const from = day(f.ДатаНачала);
  const to = day(f.ДатаОкончания);
  if (!number || !date)
    problems.push({
      code: "NOT_AN_ACT",
      message: "The 1C document has no number or date: it is not the act.",
    });
  if (!from || !to)
    problems.push({ code: "NO_PERIOD", message: "The act in 1C has no period (ДатаНачала, ДатаОкончания)." });
  const ownerRows = rowsOf(tableOf(snapshot.tables, "организац"));
  const partnerRows = rowsOf(tableOf(snapshot.tables, "контрагент"));
  const contract = parseContract(f.ДоговорКонтрагента);
  if (ownerRows.length === 0 && partnerRows.length === 0)
    problems.push({
      code: "NO_ROWS",
      message: "The act in 1C has no rows on either side: fill it in 1C first.",
    });
  const hasContract = contract !== null || [...ownerRows, ...partnerRows].some((r) => r.contract !== null);
  if (!hasContract) problems.push({ code: "NO_CONTRACT", message: "The act and its rows name no contract." });
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    act: { number, date, from, to, counterparty: text(f.Контрагент), contract, ownerRows, partnerRows },
  };
}

const contractKey = (c: { number: string; date: string } | null) => (c ? `${c.number}|${c.date}` : "");

/** Closing balance from the opening one and the turnover: a positive net is a debit, a negative one a credit. */
function closing(open: Balance, turnover: Balance): Balance {
  const net = (debit: number, credit: number) => debit - credit;
  const owner = net(open.ownerDebit, open.ownerCredit) + net(turnover.ownerDebit, turnover.ownerCredit);
  const partner =
    net(open.partnerDebit, open.partnerCredit) + net(turnover.partnerDebit, turnover.partnerCredit);
  return {
    ownerDebit: Math.max(owner, 0),
    ownerCredit: Math.max(-owner, 0),
    partnerDebit: Math.max(partner, 0),
    partnerCredit: Math.max(-partner, 0),
  };
}

const add = (a: Balance, b: Balance): Balance => ({
  ownerDebit: a.ownerDebit + b.ownerDebit,
  ownerCredit: a.ownerCredit + b.ownerCredit,
  partnerDebit: a.partnerDebit + b.partnerDebit,
  partnerCredit: a.partnerCredit + b.partnerCredit,
});

const balanceBody = (b: Balance) => ({
  OwnerDebit: b.ownerDebit / 100,
  OwnerCredit: b.ownerCredit / 100,
  PartnerDebit: b.partnerDebit / 100,
  PartnerCredit: b.partnerCredit / 100,
});
const balanceView = (b: Balance) => ({
  ownerDebit: sum(b.ownerDebit),
  ownerCredit: sum(b.ownerCredit),
  partnerDebit: sum(b.partnerDebit),
  partnerCredit: sum(b.partnerCredit),
});

const significant = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(
      (w) => w.length >= 4 && !["mchj", "mas", "uliyati", "cheklangan", "jamiyat", "мчж", "ооо"].includes(w),
    );

export interface ReconBuilt {
  body: Record<string, unknown>;
  preview: DidoxReconciliationPreview;
}

/**
 * The Didox body of the act and the card for it. `openings` are the balances at the start of the period (in sum);
 * a contract with none starts from zero, and one that names a contract the act does not have is a problem.
 */
export function buildReconciliation(
  act: ReconAct,
  seller: Party | null,
  buyer: Party | null,
  openings: OpeningInput[],
  extraText: string | undefined,
): { ok: true; built: ReconBuilt } | { ok: false; problems: ReconProblem[] } {
  const problems: ReconProblem[] = [];
  if (!seller)
    problems.push({ code: "NO_SELLER_DATA", message: "Didox gave no profile for our own company" });
  if (!buyer) problems.push({ code: "NO_PARTY", message: "Didox has no company with the recipient's INN" });

  // The contracts: those the rows name, in order; the act's own when no row names one.
  const rowsByContract = new Map<
    string,
    { contract: { number: string; date: string }; owner: Row[]; partner: Row[] }
  >();
  const slot = (c: { number: string; date: string } | null) => {
    const use = c ?? act.contract;
    const key = contractKey(use);
    if (!use) return null;
    let entry = rowsByContract.get(key);
    if (!entry) {
      entry = { contract: use, owner: [], partner: [] };
      rowsByContract.set(key, entry);
    }
    return entry;
  };
  for (const row of act.ownerRows) slot(row.contract)?.owner.push(row);
  for (const row of act.partnerRows) slot(row.contract)?.partner.push(row);
  if (rowsByContract.size === 0 && act.contract) slot(null);

  const contracts = [...rowsByContract.values()];
  const openingFor = (number: string): Balance => {
    const found = openings.filter(
      (o) => o.contract === number || (o.contract === undefined && contracts.length === 1),
    );
    return found.reduce<Balance>(
      (total, o) =>
        add(total, {
          ownerDebit: Math.round((o.ownerDebit ?? 0) * 100),
          ownerCredit: Math.round((o.ownerCredit ?? 0) * 100),
          partnerDebit: Math.round((o.partnerDebit ?? 0) * 100),
          partnerCredit: Math.round((o.partnerCredit ?? 0) * 100),
        }),
      zero(),
    );
  };
  for (const o of openings) {
    if (o.contract !== undefined && !contracts.some((c) => c.contract.number === o.contract))
      problems.push({
        code: "OPENING_CONTRACT",
        message: `The opening balance names contract ${o.contract}, which the act does not have.`,
      });
  }
  if (openings.some((o) => o.contract === undefined) && contracts.length > 1)
    problems.push({
      code: "OPENING_CONTRACT",
      message: "The act has several contracts: give the opening balance of each with its contract number.",
    });
  if (problems.length > 0 || !seller || !buyer) return { ok: false, problems };

  let open = zero();
  let turnover = zero();
  let close = zero();
  const bodyContracts: Record<string, unknown>[] = [];
  const viewContracts: DidoxReconciliationPreview["contracts"] = [];
  for (const c of contracts) {
    const items = Math.max(c.owner.length, c.partner.length);
    const rows = Array.from({ length: items }, (_x, i) => ({ owner: c.owner[i], partner: c.partner[i] }));
    const total: Balance = {
      ownerDebit: c.owner.reduce((s, r) => s + r.debit, 0),
      ownerCredit: c.owner.reduce((s, r) => s + r.credit, 0),
      partnerDebit: c.partner.reduce((s, r) => s + r.debit, 0),
      partnerCredit: c.partner.reduce((s, r) => s + r.credit, 0),
    };
    const start = openingFor(c.contract.number);
    const end = closing(start, total);
    open = add(open, start);
    turnover = add(turnover, total);
    close = add(close, end);
    bodyContracts.push({
      ContractNo: c.contract.number,
      ContractDate: c.contract.date,
      VerificationActContractItems: rows.map(({ owner, partner }) => ({
        OwnerOperationDate: owner?.date ?? "",
        OwnerOperationName: owner?.name ?? "",
        OwnerDebit: (owner?.debit ?? 0) / 100,
        OwnerCredit: (owner?.credit ?? 0) / 100,
        PartnerOperationDate: partner?.date ?? "",
        PartnerOperationName: partner?.name ?? "",
        PartnerDebit: (partner?.debit ?? 0) / 100,
        PartnerCredit: (partner?.credit ?? 0) / 100,
      })),
      OpenBalance: balanceBody(start),
      TotalBalance: balanceBody(total),
      CloseBalance: balanceBody(end),
    });
    viewContracts.push({
      number: c.contract.number,
      date: c.contract.date,
      rows: rows.map(({ owner, partner }) => ({
        ownerDate: owner?.date ?? "",
        ownerName: owner?.name ?? "",
        ownerDebit: sum(owner?.debit ?? 0),
        ownerCredit: sum(owner?.credit ?? 0),
        partnerDate: partner?.date ?? "",
        partnerName: partner?.name ?? "",
        partnerDebit: sum(partner?.debit ?? 0),
        partnerCredit: sum(partner?.credit ?? 0),
      })),
      open: balanceView(start),
      total: balanceView(total),
      close: balanceView(end),
    });
  }

  const dotted = (iso: string) => iso.split("-").reverse().join(".");
  const intro = `Акт сверки взаиморасчётов за период с ${dotted(act.from)} по ${dotted(act.to)}.`;
  const warnings: string[] = [];
  const words = significant(act.counterparty);
  if (words.length > 0 && !words.some((w) => buyer.name.toLowerCase().includes(w)))
    warnings.push(
      `1C names the counterparty "${act.counterparty}", Didox's company with this INN is "${buyer.name}": check the INN.`,
    );
  if (act.partnerRows.length === 0)
    warnings.push(
      "The counterparty's side of the act is empty (no data from the counterparty): they fill it in Didox.",
    );

  return {
    ok: true,
    built: {
      body: {
        VerificationActDoc: {
          VerificationActNo: act.number,
          VerificationActDate: act.date,
          VerificationActText: extraText ? `${intro}\n${extraText}` : intro,
        },
        OwnerTin: seller.tin,
        OwnerName: seller.name,
        OwnerFizTin: "",
        OwnerFizFio: "",
        PartnerTin: buyer.tin,
        PartnerName: buyer.name,
        PartnerFizTin: "",
        PartnerFizFio: "",
        VerificationActContracts: bodyContracts,
        OpenBalance: balanceBody(open),
        TurnoverBalance: balanceBody(turnover),
        CloseBalance: balanceBody(close),
      },
      preview: {
        number: act.number,
        date: act.date,
        from: act.from,
        to: act.to,
        seller: { tin: seller.tin, name: seller.name },
        buyer: { tin: buyer.tin, name: buyer.name },
        counterparty1c: act.counterparty,
        contracts: viewContracts,
        open: balanceView(open),
        turnover: balanceView(turnover),
        close: balanceView(close),
        warnings,
      },
    },
  };
}
