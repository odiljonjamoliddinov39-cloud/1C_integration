/**
 * Card (acquiring) receipts: the bank pays the shop's takings less its commission and says both in
 * the purpose, e.g.
 *   "00634SmartVista - Выручка CRYSTAL WATER TRADE 483,610.84 сум с 12.10.2026 по 12.10.2026
 *    ( TID 30061802) от сумма: 484,580.00 в том числе комиссия (0.2%) 969.16"
 * The statement's amount is the net (483,610.84). The company books the gross receipt (484,580.00)
 * and the commission as a bank-fee document of its own (969.16), so the two are read here.
 */
import { parseNumber } from "../tables.js";

export interface Acquiring {
  /** What the cardholders paid, tiyin. */
  gross: number;
  /** The bank's commission, tiyin. */
  commission: number;
  /** The terminal's number, when the purpose has one. */
  terminal: string;
}

const tiyin = (n: number) => Math.round(n * 100);

/** The gross and the commission a purpose names, when they add up to the statement's amount (net, tiyin). */
export function parseAcquiring(purpose: string, net: number): Acquiring | null {
  const gross = /от\s+сумма\s*:?\s*([\d][\d\s.,]*\d)/iu.exec(purpose)?.[1];
  const commission = /комисси\p{L}*\s*(?:\([^)]*\))?\s*:?\s*([\d][\d\s.,]*\d)/iu.exec(purpose)?.[1];
  if (!gross || !commission) return null;
  const g = tiyin(parseNumber(gross));
  const c = tiyin(parseNumber(commission));
  if (!(g > 0) || !(c > 0) || Number.isNaN(g) || Number.isNaN(c)) return null;
  // A figure that does not add up is something else: it is not split.
  if (Math.abs(g - c - net) > 1) return null;
  return { gross: g, commission: c, terminal: /TID\s*(\d+)/iu.exec(purpose)?.[1] ?? "" };
}

/** An earlier bank-fee document that is for acquiring, by its purpose. */
export const isAcquiringFee = (purpose: string) =>
  /комисси/iu.test(purpose) &&
  /(smartvista|эквайринг|acquir|терминал|terminal|tid\s*\d|\d\s*%)/iu.test(purpose);
