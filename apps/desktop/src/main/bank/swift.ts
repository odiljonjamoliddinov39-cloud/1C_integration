/**
 * A payment abroad, read from the bank's own words. In the statement of a currency account the bank writes an outgoing
 * SWIFT payment as a payment to its own ledger line («К получению с Головного Офиса - Долларов США», with the bank's
 * INN): that is the bank's bookkeeping, not the company's supplier. The supplier, the contract and whether it is an
 * advance are in the purpose, in the SWIFT message's fields:
 *
 *   BC: /100816681574  CANGZHOU GREAT DRILL BITS CO LTD  NO 2 JIANSH OC: /22614840505733821001 …
 *       PD: PREPAYMENT PER CONTRACT GR-TI-01 D  .D. 30.01.2024 FOR SUPPLYING …
 *   … CONTRA CT KQ-TI-01 D.D 01/01/24 …, TXID/311012912, TAIZHOU KAIQIU DRILLING TOOLS CO.,L TD. ADD: 2398 …
 *
 * The bank wraps the text at a fixed width (a word may be split with a space, "CONTRA CT", "L TD"), cuts long names, and
 * writes the date as it likes. So the name is compared with 1C's by its letters only and by its beginning, and a
 * contract number is read with its spaces removed. Nothing is invented: what the text does not say is null.
 */
import type { BankPayment, BankStatement } from "./statement.js";

export interface ForeignPayee {
  /** The beneficiary as the bank wrote it; it may be cut short, and a word in it may be split. */
  name: string;
  /** The beneficiary's account at its bank. */
  account: string;
  /** A tax number written beside the name (a Russian INN), "" when none. */
  taxId: string;
  contract: { number: string; date: string } | null;
  /** The payment is an advance (the purpose says prepayment). */
  prepayment: boolean;
}

/** The bank's own ledger line a SWIFT payment is written to: «К получению с Головного Офиса - Долларов США». */
export const HEAD_OFFICE = /(?:к\s+получению\s+с\s+)?головн\p{L}*\s+офис\p{L}*/iu;

/** Where a name ends and an address begins. */
const ADDRESS_STARTS = /\s+(?:AD\s?D(?:RESS)?\s*[:.]|NO\.?\s*\d|ROOM\b|FLOOR\b|BLDG\b|BUILDING\b)/iu;

/**
 * Words and shapes of the ordering company's own address in the bank's message (the company is in Uzbekistan, and the
 * bank spells the country with a wrap in it): what comes after the last of them is the beneficiary.
 */
const ORDERER_ADDRESS =
  /UZ\s*BE\s*KIS\s*TAN|UZB\s*EKISTAN|UZBEKISTON|(?<![\p{L}])UZ(?![\p{L}])|BUKHARA|BUKHORO|BUXORO|KAGAN|GEOFIZIKA|GEOPHYSICS|TXID\/\d*/giu;

/** A chunk of an address, not of a name: it has a figure, or names a street or a region. */
const ADDRESS_CHUNK = /\d|STREET|\bSTR\b|ROAD|REGION|DISTRICT|ADDRESS|\bN\s?O\b/iu;

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** A name for comparing: its letters and digits only. */
export const squashName = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** One year of two digits is this century. */
const fullYear = (y: string) => (y.length === 2 ? `20${y}` : y);

/** The contract a SWIFT text names: "CONTRACT GR-TI-01 D.D. 30.01.2024", "CONTRA CT KQ-TI-01 D.D 01/01/24". */
export function foreignContract(purpose: string): { number: string; date: string } | null {
  const found =
    /(?:C\s*O\s*N\s*T\s*R\s*A\s*C\s*T|CONT\.|KONTRAKT\p{L}*|КОНТРАКТ\p{L}*|AGREEMENT)\s*(?:N[O°.]?|№)?\s*[:#]?\s*([\p{L}\d][\p{L}\d\-/ ]{0,40}?)\s+(?:D\s*[.,]?\s*D\s*[.,]?|DATED|FROM|OT|ОТ)\s*:?\s*(\d{1,2})\s*[./-]+\s*(\d{1,2})\s*[./-]+\s*(\d{2,4})/iu.exec(
      purpose,
    );
  if (!found) return null;
  const [, number = "", d = "", m = "", y = ""] = found;
  return {
    number: number.replace(/\s+/g, ""),
    date: `${fullYear(y)}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`,
  };
}

/** The beneficiary of a SWIFT payment, or null when the text names none. */
export function foreignPayee(purpose: string): ForeignPayee | null {
  const text = purpose.replace(/\s+/g, " ");
  let name: string;
  let account: string;
  let taxId = "";
  const customer = /BC:\s*\/?\s*([\p{L}\d]*)\s+(.*?)\s+OC:/iu.exec(text);
  if (customer) {
    account = customer[1] ?? "";
    let rest = customer[2] ?? "";
    const tax = /INN\s*(\d{8,12})(?:\.?\s*KPP\s*\d+)?/iu.exec(rest);
    if (tax) {
      taxId = tax[1] ?? "";
      rest = rest.replace(tax[0], " ");
    }
    name = rest;
  } else {
    // The bank's own message: "…, <orderer> ADDRESS: <its address>, <beneficiary> ADD: <its address>, <own account>,
    // <beneficiary's account>, URG{…}".
    const accounts = /,\s*(\d{20})\s*,\s*(\d{6,24})\s*,\s*URG/u.exec(text);
    const before = accounts ? text.slice(0, accounts.index) : text;
    let from = 0;
    for (const m of before.matchAll(ORDERER_ADDRESS)) from = (m.index ?? 0) + m[0].length;
    if (from === 0 && !accounts) return null;
    const cut = (before.slice(from).split(ADDRESS_STARTS)[0] ?? "").split(",");
    const kept: string[] = [];
    for (let i = cut.length - 1; i >= 0; i--) {
      const chunk = (cut[i] ?? "").trim();
      if (chunk === "") continue;
      if (ADDRESS_CHUNK.test(chunk)) break;
      kept.unshift(chunk);
    }
    name = kept.join(", ");
    account = accounts?.[2] ?? "";
  }
  name = collapse(name.split(ADDRESS_STARTS)[0] ?? "").replace(/\s+([,.])/g, "$1");
  if (name.length < 3) return null;
  return {
    name: name.slice(0, 120),
    account,
    taxId,
    contract: foreignContract(purpose),
    prepayment: /PREPAYMENT|PREDOPLATA|ПРЕДОПЛАТ|ADVANCE\s+PAYMENT/iu.test(purpose),
  };
}

/** The money the correspondent bank sent back: "возврат международного перевода … от 23.02.2024 на сумму 6100". */
export function foreignReturn(purpose: string): { date: string; amount: number } | null {
  const found =
    /возврат\s+международн\p{L}*\s+перевод\p{L}*[^]*?от\s+(\d{2})\.(\d{2})\.(\d{4})\s+на\s+сумм\p{L}*\s+(\d[\d\s]*(?:[.,]\d+)?)/iu.exec(
      purpose,
    );
  if (!found) return null;
  const amount = Number((found[4] ?? "").replace(/\s+/g, "").replace(",", "."));
  return Number.isFinite(amount) && amount > 0
    ? { date: `${found[3]}-${found[2]}-${found[1]}`, amount }
    : null;
}

/** Can two spellings of a name be one counterparty: one's letters begin the other's (the bank cuts names). */
export function sameForeignName(a: string, b: string): boolean {
  const x = squashName(a);
  const y = squashName(b);
  const shorter = Math.min(x.length, y.length);
  return shorter >= 10 && (x.startsWith(y) || y.startsWith(x));
}

/**
 * The statement of a currency account with each SWIFT payment written to its real beneficiary instead of the bank's
 * ledger line (the bank's INN is dropped: the beneficiary is known by name, as the bank wrote it, and 1C's own spelling
 * of it is put in by `matchPayees`). The payees are returned by row.
 */
export function withForeignPayees(statement: BankStatement): {
  statement: BankStatement;
  payees: Map<number, ForeignPayee>;
} {
  const payees = new Map<number, ForeignPayee>();
  const written = new Map<string, BankPayment>();
  const moved = (p: BankPayment, payee: ForeignPayee, purpose = p.purpose): BankPayment => {
    return { ...p, inn: "", counterparty: payee.name, innZero: true, purpose };
  };
  const payments = statement.payments.map((p) => {
    if (p.direction !== "out" || !HEAD_OFFICE.test(p.counterparty)) return p;
    const payee = foreignPayee(p.purpose);
    if (!payee) return p;
    payees.set(p.row, payee);
    written.set(`${p.date}|${p.amount}`, p);
    return moved(p, payee);
  });
  // The money the correspondent bank sent back names the payment it is the return of (its day and amount): the same
  // beneficiary and the same contract.
  const back = payments.map((p) => {
    if (p.direction !== "in" || !HEAD_OFFICE.test(p.counterparty)) return p;
    const returned = foreignReturn(p.purpose);
    const original = returned
      ? written.get(`${returned.date}|${Math.round(returned.amount * 100)}`)
      : undefined;
    const payee = original ? payees.get(original.row) : undefined;
    if (!original || !payee) return p;
    payees.set(p.row, payee);
    const contract = payee.contract
      ? ` PER CONTRACT ${payee.contract.number} D.D. ${payee.contract.date.split("-").reverse().join(".")}`
      : "";
    return moved(p, payee, `${p.purpose}${contract}`);
  });
  return { statement: payees.size > 0 ? { ...statement, payments: back } : statement, payees };
}
