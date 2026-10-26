/**
 * The declarations the program has read for a company, kept so a later one can be linked to them: an IM 40 that releases
 * goods from a customs warehouse names the IM 74 declaration in graph 40, and the program must know that one (its items, the
 * quantity not yet released) instead of treating the release as a plain import.
 */
import type { Declaration } from "./declaration.js";
import { fixed, plain } from "./decimal.js";

export interface GtdRecord {
  declarationNo: string;
  date: string | null;
  kind: Declaration["regime"]["kind"];
  exporter: string | null;
  invoiceNo: string | null;
  currency: string | null;
  amount: string | null;
  /** The fee (graph 47, type 10) in soums. */
  fee: string | null;
  /** The deadline of graph 50. */
  releaseDeadline: string | null;
  items: {
    no: number;
    hs: string | null;
    nameEn: string | null;
    qty: string | null;
    unit: string | null;
    value: string | null;
  }[];
  readAt: string;
}

export const MAX_RECORDS = 200;

export function recordOf(d: Declaration, fee: string | null, now: Date = new Date()): GtdRecord | null {
  if (!d.declaration_no) return null;
  return {
    declarationNo: d.declaration_no,
    date: d.date,
    kind: d.regime.kind,
    exporter: d.exporter.name,
    invoiceNo: d.invoice.no,
    currency: d.invoice.currency,
    amount: d.invoice.amount ? fixed(d.invoice.amount, 2) : null,
    fee,
    releaseDeadline: d.warehouse?.release_deadline ?? null,
    items: d.items.map((i) => ({
      no: i.no,
      hs: i.hs,
      nameEn: i.name_en,
      qty: i.qty ? plain(i.qty) : null,
      unit: i.unit_code,
      value: i.value ? fixed(i.value, 2) : null,
    })),
    readAt: now.toISOString(),
  };
}

/** The same declaration read again replaces the earlier reading; the oldest go when there are too many. */
export function remember(held: GtdRecord[], record: GtdRecord): GtdRecord[] {
  return [...held.filter((r) => r.declarationNo !== record.declarationNo), record].slice(-MAX_RECORDS);
}

/** Whether this company has read a customs warehouse (IM 74) declaration with this number. */
export const hasWarehouse = (held: GtdRecord[]) => (declarationNo: string) =>
  held.some((r) => r.declarationNo === declarationNo && r.kind === "customs_warehouse");
