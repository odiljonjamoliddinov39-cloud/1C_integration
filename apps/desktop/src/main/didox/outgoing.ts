/**
 * An outgoing invoice (ЭСФ) as Didox takes it: the draft body, in the layout of Didox's own 1C library
 * (`didox_СформироватьJSONСтрокуСчетФактуры`). The seller and the buyer come from Didox's own profiles of
 * their INNs, the numbers of the document from 1C. The sums are worked out here, in whole tiyin, from
 * quantity, price and VAT rate: what the model read from 1C is the input, never the arithmetic.
 */

/** Didox's code of an invoice among its document types (the path of `/v1/documents/{docType}/create`). */
import type { DidoxDraftPreview as DraftPreview } from "../../shared/ipc.js";

export type { DraftPreview };

export const INVOICE_DOCTYPE = "002";

export interface DraftLineInput {
  name: string;
  /** The unit as 1C names it ("шт", "кг"); looked up in Didox's list of units. */
  unit: string;
  /** Didox's own code of the unit, when it is known and `unit` is not enough. */
  measureId?: string | undefined;
  qty: number;
  /** Price without VAT, in sum. */
  price: number;
  /** 0 or 12 (others are written as given). */
  vatRate: number;
  /** The state catalogue code of the goods or service (IKPU, МХИК) and its name, when 1C has them. */
  catalogCode?: string | undefined;
  catalogName?: string | undefined;
  barcode?: string | undefined;
}

export interface DraftInput {
  number: string;
  /** YYYY-MM-DD. */
  date: string;
  buyerTin: string;
  contract?: { number: string; date: string } | undefined;
  lines: DraftLineInput[];
}

/** What Didox's profile tells about a company, in the fields an invoice repeats. */
export interface Party {
  tin: string;
  name: string;
  account: string;
  bankId: string;
  address: string;
  mobile: string;
  workPhone: string;
  oked: string;
  districtId: string;
  director: string;
  accountant: string;
  vatRegCode: string;
  vatRegStatus: number | null;
}

export type DraftProblemCode =
  "NO_NUMBER" | "BAD_DATE" | "BAD_TIN" | "NO_LINES" | "BAD_LINE" | "NO_UNIT" | "NO_PARTY" | "NO_SELLER_DATA";

export interface DraftProblem {
  code: DraftProblemCode;
  /** The line it is about (1-based); null for the document. */
  line: number | null;
  message: string;
}

/** Sum with two decimals, from tiyin. */
export function sum(tiyin: number): string {
  const sign = tiyin < 0 ? "-" : "";
  const abs = Math.abs(tiyin);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";

/** The first non-empty text among the names, however Didox cased them. */
function pick(source: Record<string, unknown>, names: string[]): string {
  const lower = new Map(Object.entries(source).map(([key, value]) => [key.toLowerCase(), value]));
  for (const name of names) {
    const found = text(lower.get(name.toLowerCase()));
    if (found) return found;
  }
  return "";
}

/** The profile answer may carry the company under `data`. */
function body(profile: unknown): Record<string, unknown> {
  const top = record(profile);
  const inner = record(top.data);
  return Object.keys(inner).length > 0 ? inner : top;
}

/** A company's profile from Didox as the party of an invoice. Null when the answer holds no name. */
export function partyFromProfile(tin: string, profile: unknown, vat?: unknown): Party | null {
  const p = body(profile);
  const name = pick(p, ["name", "fullName", "shortName", "companyName", "title"]);
  if (!name) return null;
  const v = body(vat);
  const status = Number(pick(v, ["vatRegStatus"]) || pick(p, ["vatRegStatus"]));
  return {
    tin,
    name,
    account: pick(p, ["account", "accountNumber", "bankAccount"]),
    bankId: pick(p, ["mfo", "bankId", "bankCode"]),
    address: pick(p, ["address"]),
    mobile: pick(p, ["mobile", "phone"]),
    workPhone: pick(p, ["workPhone", "phone"]),
    oked: pick(p, ["oked"]),
    districtId: pick(p, ["districtId", "district"]),
    director: pick(p, ["director", "directorName", "directorFio"]),
    accountant: pick(p, ["accountant", "accountantName", "accountantFio"]),
    vatRegCode: pick(v, ["vatRegCode"]) || pick(p, ["vatRegCode"]),
    vatRegStatus: Number.isFinite(status) && status > 0 ? status : null,
  };
}

const validTin = (tin: string) => /^\d{9}$/.test(tin) || /^\d{14}$/.test(tin);
const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date));

/** A unit name for comparing: case, dots, brackets, slashes and spaces do not tell units apart. */
const unitKey = (name: string) => name.toLowerCase().replace(/[.\s()/,\-–]/g, "");

/** The ways a piece is written in Uzbek, Russian and English: any of them stands for any other. */
const PIECE = ["шт", "штук", "штука", "дона", "dona", "pcs", "pc", "piece", "pieces", "unit", "units"].map(
  unitKey,
);

/** The words of one unit's entry in the answer of Didox, however deep: its names in each language, short and long. */
function namesOf(value: unknown, into: string[] = [], depth = 0): string[] {
  if (depth > 4) return into;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      into.push(unitKey(trimmed));
      // "Штука (дона)" is the unit "штука" and the unit "дона".
      for (const part of trimmed.split(/[()/,;]/))
        if (part.trim() && part.trim() !== trimmed) into.push(unitKey(part));
    }
  } else if (Array.isArray(value)) {
    for (const item of value) namesOf(item, into, depth + 1);
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (/^(id|code|measureid|measure_id|ikpu|order|ord)$/i.test(key)) continue;
      namesOf(inner, into, depth + 1);
    }
  }
  return into;
}

function measureList(measures: unknown): unknown[] {
  const top = record(measures);
  return Array.isArray(measures)
    ? measures
    : ((["data", "items", "measures", "result"].map((key) => top[key]).find(Array.isArray) ??
        Object.values(top).find(Array.isArray) ??
        []) as unknown[]);
}

/**
 * Didox's code for a unit by its name, from the answer of `/v1/measures/all` (a list, or an object holding
 * one; each entry has an id and a name in some language, plain or inside an object). A piece is found by any of its
 * spellings («шт», «штука», «дона», «dona»…). Null when no entry has that name.
 */
export function findMeasure(measures: unknown, unit: string): string | null {
  const wanted = unitKey(unit);
  if (!wanted) return null;
  // The asked name and its parts: «Штука (дона)» is «штука» and «дона».
  const asked = new Set([
    wanted,
    ...unit
      .split(/[()/,;]/)
      .map(unitKey)
      .filter(Boolean),
  ]);
  const accepted = [...asked].some((name) => PIECE.includes(name)) ? new Set([...asked, ...PIECE]) : asked;
  for (const entry of measureList(measures)) {
    const e = record(entry);
    const id = pick(e, ["id", "code", "measureId", "measure_id"]);
    if (!id) continue;
    if (namesOf(e).some((name) => accepted.has(name))) return id;
  }
  return null;
}

/** The units Didox has, for the message that says a name is not among them (a few, so the person can pick the right one). */
export function measureNames(measures: unknown, limit = 25): string[] {
  const shown: string[] = [];
  for (const entry of measureList(measures)) {
    const e = record(entry);
    const name = Object.entries(e)
      .filter(([key, value]) => !/^(id|code|measureid|measure_id)$/i.test(key) && typeof value === "string")
      .map(([, value]) => String(value).trim())
      .find(Boolean);
    if (name && !shown.includes(name)) shown.push(name);
    if (shown.length >= limit) break;
  }
  return shown;
}

/** A party as Didox's documents carry it (`Seller`, `Buyer`). */
export function partyBody(p: Party) {
  return {
    Name: p.name,
    Account: p.account,
    BankId: p.bankId,
    Address: p.address,
    Mobile: p.mobile,
    WorkPhone: p.workPhone,
    Oked: p.oked,
    DistrictId: p.districtId,
    Director: p.director,
    Accountant: p.accountant,
    VatRegCode: p.vatRegCode,
    BranchCode: "",
    BranchName: "",
    ...(p.vatRegStatus !== null ? { VatRegStatus: p.vatRegStatus } : {}),
  };
}

interface Built {
  /** The body for `POST /v1/documents/002/create`. */
  body: Record<string, unknown>;
  preview: DraftPreview;
}

/**
 * The draft body and the card for it, or what is wrong with the input. `measures` is Didox's list of units,
 * `seller` and `buyer` come from Didox's profiles.
 */
export function buildInvoiceDraft(
  input: DraftInput,
  seller: Party | null,
  buyer: Party | null,
  measures: unknown,
): { ok: true; built: Built } | { ok: false; problems: DraftProblem[] } {
  const problems: DraftProblem[] = [];
  const add = (code: DraftProblemCode, line: number | null, message: string) =>
    problems.push({ code, line, message });

  if (!input.number.trim()) add("NO_NUMBER", null, "The invoice has no number");
  if (!validDate(input.date)) add("BAD_DATE", null, `The invoice date "${input.date}" is not YYYY-MM-DD`);
  if (!validTin(input.buyerTin))
    add("BAD_TIN", null, `The buyer's INN "${input.buyerTin}" is not 9 or 14 digits`);
  if (!seller) add("NO_SELLER_DATA", null, "Didox gave no profile for our own company");
  if (!buyer && validTin(input.buyerTin))
    add("NO_PARTY", null, `Didox has no company with INN ${input.buyerTin}`);
  if (input.lines.length === 0) add("NO_LINES", null, "The invoice has no lines");

  let amountTotal = 0;
  let vatTotal = 0;
  const products: Record<string, unknown>[] = [];
  const views: DraftPreview["lines"] = [];
  input.lines.forEach((line, i) => {
    const n = i + 1;
    if (!line.name.trim()) add("BAD_LINE", n, "The line has no name");
    if (!(line.qty > 0) || !(line.price >= 0) || !(line.vatRate >= 0)) {
      add("BAD_LINE", n, "Quantity must be above 0, price and VAT rate not negative");
      return;
    }
    const measureId = line.measureId || findMeasure(measures, line.unit);
    if (!measureId) {
      const have = measureNames(measures);
      add(
        "NO_UNIT",
        n,
        `Didox has no unit named "${line.unit}"` +
          (have.length > 0
            ? `; its units are: ${have.join(", ")}`
            : "; its list of units was empty or unreadable"),
      );
    }
    const amount = Math.round(line.qty * line.price * 100);
    const vat = Math.round((amount * line.vatRate) / 100);
    amountTotal += amount;
    vatTotal += vat;
    const withVat = amount + vat;
    views.push({
      n,
      name: line.name,
      unit: line.unit,
      qty: line.qty,
      price: sum(Math.round(line.price * 100)),
      amount: sum(amount),
      vatRate: line.vatRate,
      vat: sum(vat),
      total: sum(withVat),
    });
    products.push({
      OrdNo: n,
      Name: line.name,
      Count: line.qty,
      Summa: Number(line.price.toFixed(2)),
      ExciseRate: 0,
      ExciseSum: 0,
      DeliverySum: amount / 100,
      VatRate: line.vatRate,
      VatSum: vat / 100,
      DeliverySumWithVat: withVat / 100,
      WithoutVat: line.vatRate === 0,
      MeasureId: measureId ?? "",
      ...(line.catalogCode ? { CatalogCode: line.catalogCode, CatalogName: line.catalogName ?? "" } : {}),
      ...(line.barcode ? { Barcode: line.barcode } : {}),
      origin: 1,
      expansion: { showcount: true },
    });
  });

  if (problems.length > 0 || !seller || !buyer) return { ok: false, problems };

  const hasVat = products.some((p) => p.VatSum !== 0);
  const total = amountTotal + vatTotal;
  return {
    ok: true,
    built: {
      body: {
        Version: 1,
        FacturaType: 0,
        FacturaDoc: { FacturaNo: input.number.trim(), FacturaDate: input.date },
        ...(input.contract
          ? { ContractDoc: { ContractNo: input.contract.number, ContractDate: input.contract.date } }
          : {}),
        SellerTin: seller.tin,
        BuyerTin: buyer.tin,
        Seller: partyBody(seller),
        Buyer: partyBody(buyer),
        ProductList: {
          HasVat: hasVat,
          HasExcise: false,
          HasMedical: false,
          HasCommittent: false,
          HasLgota: false,
          Tin: seller.tin,
          Products: products,
        },
        HasMarking: false,
        products_vat_sum: vatTotal / 100,
        products_excise_sum: 0,
        products_delivery_sum: amountTotal / 100,
        products_total_sum: total / 100,
        HasRent: false,
      },
      preview: {
        number: input.number.trim(),
        date: input.date,
        seller: { tin: seller.tin, name: seller.name },
        buyer: { tin: buyer.tin, name: buyer.name },
        contract: input.contract ?? null,
        lines: views,
        totals: { amount: sum(amountTotal), vat: sum(vatTotal), total: sum(total) },
      },
    },
  };
}

/** The id of the draft in Didox's answer to the creation (`_id`, as the library reads it). */
export function draftIdOf(answer: unknown): string | null {
  const a = record(answer);
  return pick(a, ["_id", "id", "documentId"]) || pick(record(a.data), ["_id", "id", "documentId"]) || null;
}

/** Didox's code for a free-form document (the path of `/v1/documents/{docType}/create`). */
export const DOCUMENT_DOCTYPE = "000";

/** The `Subtype` Didox's own 1C library gives each kind of free-form document. */
export const DOCUMENT_SUBTYPES = {
  reconciliation_act: 1,
  letter: 2,
  contract: 3,
  payment_invoice: 4,
  work_act: 5,
  other: 6,
  request: 7,
  specification: 8,
} as const;
export type DocumentType = keyof typeof DOCUMENT_SUBTYPES;

export interface DocumentInput {
  type: DocumentType;
  number: string;
  /** YYYY-MM-DD. */
  date: string;
  buyerTin: string;
  contract?: { number: string; date: string } | undefined;
}

/**
 * The draft body of a free-form document (a letter, an act, ...): the file is a PDF of the text (base64),
 * the data are the number, date and the two parties, as in Didox's own 1C library.
 */
export function buildDocumentDraft(
  input: DocumentInput,
  seller: Party | null,
  buyer: Party | null,
  pdfBase64: string,
): { ok: true; body: Record<string, unknown> } | { ok: false; problems: DraftProblem[] } {
  const problems: DraftProblem[] = [];
  const add = (code: DraftProblemCode, message: string) => problems.push({ code, line: null, message });
  if (!input.number.trim()) add("NO_NUMBER", "The document has no number");
  if (!validDate(input.date)) add("BAD_DATE", `The date "${input.date}" is not YYYY-MM-DD`);
  if (!validTin(input.buyerTin))
    add("BAD_TIN", `The recipient's INN "${input.buyerTin}" is not 9 or 14 digits`);
  if (!seller) add("NO_SELLER_DATA", "Didox gave no profile for our own company");
  if (!buyer && validTin(input.buyerTin)) add("NO_PARTY", `Didox has no company with INN ${input.buyerTin}`);
  if (problems.length > 0 || !seller || !buyer) return { ok: false, problems };
  return {
    ok: true,
    body: {
      data: {
        Subtype: DOCUMENT_SUBTYPES[input.type],
        Document: { DocumentNo: input.number.trim(), DocumentDate: input.date },
        contractdoc: {
          contractdate: input.contract?.date ?? "",
          contractno: input.contract?.number ?? "",
        },
        SellerTin: seller.tin,
        BuyerTin: buyer.tin,
        Seller: partyBody(seller),
        Buyer: partyBody(buyer),
      },
      document: pdfBase64,
    },
  };
}
