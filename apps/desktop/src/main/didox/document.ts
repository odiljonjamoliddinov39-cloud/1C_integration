/**
 * Documents exported from Didox (the JSON inside the archives its "download" gives: an ЭСФ, an act,
 * a contract, a free-form document, a reconciliation act). Read here, with no AI: the fields are
 * fixed, so a model reading the page or the raw JSON only costs time and tokens, and may miscount.
 *
 * The figures are the supplier's and are never changed. They are only checked (quantity × price,
 * VAT, total), in whole tiyin, and what does not add up is named, so that the model looks at those
 * lines only and does not recalculate the rest.
 */

export type DidoxKind = "invoice" | "act" | "contract" | "free" | "reconciliation";

export interface DidoxParty {
  tin: string;
  name: string;
}

export interface DidoxLine {
  n: number;
  name: string;
  /** The state catalogue code of the goods or service (IKPU). */
  catalogCode: string;
  catalogName: string;
  unit: string;
  qty: number;
  /** Price without VAT, tiyin. */
  price: number;
  /** Amount without VAT, tiyin. */
  amount: number;
  vatRate: number;
  vat: number;
  /** Amount with VAT, tiyin. */
  total: number;
}

export interface DidoxIssue {
  /** The line it is about; null for the document. */
  line: number | null;
  code:
    | "LINE_AMOUNT"
    | "LINE_VAT"
    | "LINE_TOTAL"
    | "VAT_RATE"
    | "TIN_FORMAT"
    | "NO_LINES"
    | "NO_NUMBER"
    | "ACT_DIFFERS";
  message: string;
}

export interface DidoxDocument {
  kind: DidoxKind;
  /** Didox's own id of the document (facturaid, actid, ...): what makes a second import of it a duplicate. */
  id: string;
  number: string;
  /** YYYY-MM-DD. */
  date: string;
  seller: DidoxParty;
  buyer: DidoxParty;
  contract: { number: string; date: string } | null;
  lines: DidoxLine[];
  /** Sums of the lines, tiyin. */
  totals: { amount: number; vat: number; total: number };
  issues: DidoxIssue[];
  /** Things worth knowing that are not errors: a corrective invoice, a type code, an act's text. */
  notes: string[];
  /** Free-form documents: the file the sender attached. */
  fileName: string;
}

/** VAT rates in use in Uzbekistan; others are shown, not refused. */
const KNOWN_VAT_RATES = new Set([0, 12]);

const str = (value: unknown): string =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** A number out of what Didox sends: a number, or a string, sometimes with float noise ("892.86000000000001"). */
function decimal(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
  if (typeof value !== "string") return null;
  const text = value.replace(/\s/g, "").replace(",", ".");
  if (text === "") return null;
  const number = Number(text);
  return Number.isFinite(number) ? Number(number.toFixed(6)) : null;
}

const tiyin = (value: unknown): number | null => {
  const whole = decimal(value);
  return whole === null ? null : Math.round(whole * 100);
};

const decimals = (value: number) => (String(value).split(".")[1] ?? "").length;

/** Tiyin as sum with two decimals, for the model: "1320000.00". */
export function money(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** The kind of document a parsed JSON is, by the fields only that kind has; null when it is not Didox's. */
function kindOf(json: Record<string, unknown>): DidoxKind | null {
  if (json.facturadoc && json.productlist) return "invoice";
  if (json.actdoc && json.productlist) return "act";
  if (json.verificationactdoc) return "reconciliation";
  if (json.contractdoc && json.owner && json.parts) return "contract";
  if (json.document && (json.documentid || json.subtype !== undefined)) return "free";
  return null;
}

/** True when the JSON is a Didox document (so that other JSON files are left to be read as text). */
export const isDidoxJson = (value: unknown): boolean => kindOf(record(value)) !== null;

/** A legal entity's INN has 9 digits, a person's PINFL 14. */
const validTin = (tin: string) => /^\d{9}$/.test(tin) || /^\d{14}$/.test(tin);

export function parseDidoxDocument(value: unknown): DidoxDocument | null {
  const json = record(value);
  const kind = kindOf(json);
  if (!kind) return null;

  const notes: string[] = [];
  const doc: DidoxDocument = {
    kind,
    id: str(json.facturaid) || str(json.actid) || str(json.contractid) || str(json.documentid),
    number: "",
    date: "",
    seller: { tin: str(json.sellertin), name: str(record(json.seller).name) || str(json.sellername) },
    buyer: { tin: str(json.buyertin), name: str(record(json.buyer).name) || str(json.buyername) },
    contract: null,
    lines: [],
    totals: { amount: 0, vat: 0, total: 0 },
    issues: [],
    notes,
    fileName: "",
  };

  const contract = record(json.contractdoc);
  const contractNumber = str(contract.contractno);
  if (contractNumber) doc.contract = { number: contractNumber, date: str(contract.contractdate) };

  if (kind === "invoice") {
    const head = record(json.facturadoc);
    doc.number = str(head.facturano);
    doc.date = str(head.facturadate);
    const type = str(json.facturatype);
    if (type && type !== "0") notes.push(`invoice type ${type}`);
    const old = record(json.oldfacturadoc);
    if (str(old.oldfacturano))
      notes.push(`corrects invoice ${str(old.oldfacturano)} of ${str(old.oldfacturadate)}`);
    if (json.hasrent === true && record(json.facturarentdoc).rentfrom) {
      const rent = record(json.facturarentdoc);
      notes.push(`rent ${str(rent.rentfrom)} – ${str(rent.rentto)}`);
    }
  } else if (kind === "act") {
    const head = record(json.actdoc);
    doc.number = str(head.actno);
    doc.date = str(head.actdate);
  } else if (kind === "contract") {
    const head = record(json.contractdoc);
    doc.number = str(head.contractno);
    doc.date = str(head.contractdate);
    const owner = record(json.owner);
    const client = record(Array.isArray(json.clients) ? json.clients[0] : null);
    doc.seller = { tin: str(owner.tin), name: str(owner.name) };
    doc.buyer = { tin: str(client.tin), name: str(client.name) };
    doc.contract = null;
    if (str(head.contractexpiredate)) notes.push(`valid until ${str(head.contractexpiredate)}`);
  } else if (kind === "free") {
    const head = record(json.document);
    doc.number = str(head.documentno);
    doc.date = str(head.documentdate);
    doc.fileName = str(json.filename);
    if (str(head.documentname)) notes.push(str(head.documentname));
  } else {
    const head = record(json.verificationactdoc);
    doc.number = str(head.verificationactno) || str(head.actno);
    doc.date = str(head.verificationactdate) || str(head.actdate);
    doc.seller = { tin: str(json.ownertin), name: str(json.ownername) };
    doc.buyer = { tin: str(json.partnertin), name: str(json.partnername) };
  }

  if (kind === "invoice" || kind === "act") {
    const products = record(json.productlist).products;
    const list = Array.isArray(products) ? products : [];
    doc.lines = list.map((item, index) => line(record(item), index + 1));
    check(doc);
  }
  return doc;
}

function line(item: Record<string, unknown>, fallback: number): DidoxLine {
  const qty = decimal(item.count) ?? 0;
  const price = tiyin(item.summa) ?? 0;
  const amount = tiyin(item.deliverysum ?? item.totalsumwithoutvat) ?? Math.round(qty * price);
  let rate = decimal(item.vatrate) ?? 0;
  let vat = tiyin(item.vatsum) ?? 0;
  const stated = tiyin(item.deliverysumwithvat ?? item.totalsum);
  const total = stated ?? amount + vat;
  // A line with no VAT in it is a line without VAT, whatever rate is written beside it: the supplier flagged it
  // so, or charged none (the total is the amount). It is not a mismatch to look at, and 1C gets no rate for it.
  const flagged = [true, "true", 1, "1"].includes(item.withoutvat as boolean | string | number);
  if (rate !== 0 && (flagged || (stated !== null && vat === 0 && Math.abs(total - amount) <= 1))) {
    rate = 0;
    vat = 0;
  }
  return {
    n: typeof item.ordno === "number" ? item.ordno : fallback,
    name: str(item.name).replace(/\s+/g, " "),
    catalogCode: str(item.catalogcode),
    catalogName: str(item.catalogname).replace(/\s+/g, " "),
    unit: str(item.packagename),
    qty,
    price,
    amount,
    vatRate: rate,
    vat,
    total,
  };
}

/**
 * Quantity × price against the amount, the amount's VAT, and amount + VAT against the total, in
 * tiyin. A price is written to two decimals, so qty × price can be off by half a tiyin for each unit
 * (price 0.005 more or less): that is how much is allowed, and no more.
 */
function check(doc: DidoxDocument) {
  const issue = (line: number | null, code: DidoxIssue["code"], message: string) =>
    doc.issues.push({ line, code, message });
  if (doc.number === "") issue(null, "NO_NUMBER", "the document has no number");
  if (doc.lines.length === 0) issue(null, "NO_LINES", "the document has no lines");
  for (const party of [doc.seller, doc.buyer]) {
    if (party.tin && !validTin(party.tin))
      issue(null, "TIN_FORMAT", `INN ${party.tin} is not 9 or 14 digits`);
  }
  for (const l of doc.lines) {
    const exact = decimals(l.price / 100) <= 2;
    const allowed = exact ? Math.max(1, Math.ceil(l.qty * 0.5)) : 1;
    const expected = Math.round(l.qty * l.price);
    if (Math.abs(expected - l.amount) > allowed) {
      issue(
        l.n,
        "LINE_AMOUNT",
        `${l.qty} × ${money(l.price)} = ${money(expected)}, the document says ${money(l.amount)}`,
      );
    }
    if (!KNOWN_VAT_RATES.has(l.vatRate)) issue(l.n, "VAT_RATE", `VAT rate ${l.vatRate}% is not 0 or 12`);
    const vat = Math.round((l.amount * l.vatRate) / 100);
    if (Math.abs(vat - l.vat) > 1) {
      issue(
        l.n,
        "LINE_VAT",
        `${l.vatRate}% of ${money(l.amount)} = ${money(vat)}, the document says ${money(l.vat)}`,
      );
    }
    if (Math.abs(l.amount + l.vat - l.total) > 1) {
      issue(
        l.n,
        "LINE_TOTAL",
        `${money(l.amount)} + ${money(l.vat)} = ${money(l.amount + l.vat)}, the document says ${money(l.total)}`,
      );
    }
    doc.totals.amount += l.amount;
    doc.totals.vat += l.vat;
    doc.totals.total += l.total;
  }
}

/** How a document is named to the model and in what the model sends back: "312318957/24". */
export const didoxKey = (d: { seller: DidoxParty; number: string }) => `${d.seller.tin}/${d.number}`;

/** What documents of one archive come to: those that become entries in 1C, and those that do not. */
export interface DidoxBatch {
  /** Invoices, and acts that have no invoice. */
  postable: DidoxDocument[];
  /** Contracts, free-form documents and reconciliation acts: for reading, nothing to post. */
  reference: DidoxDocument[];
  /** Acts left out because the invoice with the same seller and number says the same. */
  pairedActs: number;
}

/**
 * An invoice and its act carry the same lines (a service is both invoiced and accepted), so the act
 * is not a second entry: it is checked against the invoice and left out. The same document sent
 * twice counts once.
 */
export function batchOf(documents: DidoxDocument[]): DidoxBatch {
  const key = (d: DidoxDocument) => `${d.seller.tin}|${d.number}`;
  const invoices = new Map<string, DidoxDocument>();
  const postable: DidoxDocument[] = [];
  const reference: DidoxDocument[] = [];
  const seen = new Set<string>();
  let pairedActs = 0;

  for (const d of documents) {
    if (d.kind !== "invoice") continue;
    if (seen.has(`invoice|${key(d)}`)) continue;
    seen.add(`invoice|${key(d)}`);
    invoices.set(key(d), d);
    postable.push(d);
  }
  for (const d of documents) {
    if (d.kind === "act") {
      const invoice = invoices.get(key(d));
      if (invoice) {
        pairedActs += 1;
        if (invoice.totals.total !== d.totals.total) {
          invoice.issues.push({
            line: null,
            code: "ACT_DIFFERS",
            message: `the act with the same number comes to ${money(d.totals.total)}, the invoice to ${money(invoice.totals.total)}`,
          });
        }
        continue;
      }
      if (seen.has(`act|${key(d)}`)) continue;
      seen.add(`act|${key(d)}`);
      postable.push(d);
    } else if (d.kind !== "invoice") {
      const id = `${d.kind}|${key(d)}|${d.date}`;
      if (seen.has(id)) continue;
      seen.add(id);
      reference.push(d);
    }
  }
  return { postable, reference, pairedActs };
}

const label = (d: DidoxDocument) => (d.kind === "invoice" ? "invoice" : d.kind === "act" ? "act" : d.kind);

/**
 * The text the model reads in place of the pages and the JSON: the buyer once, the documents by
 * seller, one line per goods line, and the result of the checks. Short on purpose; the same text goes
 * with every step of the question.
 */
export function describeBatch(batch: DidoxBatch): string {
  const out: string[] = [];
  const { postable, reference } = batch;
  const buyers = new Set([...postable, ...reference].map((d) => d.buyer.tin));
  const only = buyers.size === 1 ? [...postable, ...reference][0] : undefined;

  out.push(
    `Didox documents read by the program (not by AI): ${postable.length} to post${
      batch.pairedActs > 0 ? `, ${batch.pairedActs} act(s) repeat an invoice and are left out` : ""
    }${reference.length > 0 ? `, ${reference.length} for reference only` : ""}.`,
    "Amounts are the supplier's. The program checked every line (quantity × price, VAT, total): a document marked OK adds up, use its figures as they are and do not recalculate; a document with a CHECK line has the lines named there to look at. Amounts are in sum, VAT is per line.",
  );
  if (only) out.push(`Buyer in all: ${only.buyer.name} (INN ${only.buyer.tin}).`);

  const bySeller = new Map<string, DidoxDocument[]>();
  for (const d of postable) {
    const key = `${d.seller.tin}|${d.seller.name}`;
    bySeller.set(key, [...(bySeller.get(key) ?? []), d]);
  }
  const codes = new Map<string, string>();
  let withIssues = 0;
  for (const [key, docs] of bySeller) {
    const [tin, name] = key.split("|");
    out.push("", `SELLER ${name} (INN ${tin}): ${docs.length} document(s)`);
    for (const d of docs) {
      out.push(
        `${label(d).toUpperCase()} ${d.number} of ${d.date} [${didoxKey(d)}]${
          d.contract ? `, contract ${d.contract.number} of ${d.contract.date}` : ""
        }${only ? "" : `, buyer ${d.buyer.name} (INN ${d.buyer.tin})`}${
          d.notes.length > 0 ? `, ${d.notes.join("; ")}` : ""
        }`,
        "n|name|code|unit|qty|price|VAT%|VAT|total",
      );
      for (const l of d.lines) {
        if (l.catalogCode && l.catalogName) codes.set(l.catalogCode, l.catalogName);
        out.push(
          [
            l.n,
            l.name,
            l.catalogCode,
            l.unit,
            l.qty,
            money(l.price),
            l.vatRate,
            money(l.vat),
            money(l.total),
          ].join("|"),
        );
      }
      out.push(
        `sum without VAT ${money(d.totals.amount)}, VAT ${money(d.totals.vat)}, total ${money(d.totals.total)} — ${
          d.issues.length === 0 ? "OK" : "CHECK"
        }`,
      );
      if (d.issues.length > 0) {
        withIssues += 1;
        for (const i of d.issues)
          out.push(`  CHECK ${i.line === null ? "document" : `line ${i.line}`}: ${i.message}`);
      }
    }
  }
  if (codes.size > 0) {
    out.push("", "Catalogue codes:", ...[...codes].map(([code, name]) => `${code} = ${name}`));
  }
  if (reference.length > 0) {
    out.push("", "For reference only (nothing to post):");
    for (const d of reference) out.push(`- ${referenceLine(d)}`);
  }
  out.push(
    "",
    withIssues === 0
      ? `All ${postable.length} document(s) add up.`
      : `${withIssues} of ${postable.length} document(s) have lines to check; the others add up.`,
  );
  return out.join("\n");
}

/**
 * The documents this company issued, with their lines, for entering them into 1C as sales: what Didox gave, not
 * what the model remembers. An act that repeats an invoice is left out. One block per document, in the same line
 * format as the incoming ones.
 */
export function describeOutgoing(documents: DidoxDocument[]): string {
  const { postable } = batchOf(documents);
  const out = [
    `Issued by this company, read from Didox by the program (not by AI): ${postable.length} document(s), with their lines. Amounts are as Didox has them, VAT per line.`,
  ];
  for (const d of postable) {
    out.push(
      "",
      `${label(d).toUpperCase()} ${d.number} of ${d.date} [${didoxKey(d)}], buyer ${d.buyer.name} (INN ${d.buyer.tin})${
        d.contract ? `, contract ${d.contract.number} of ${d.contract.date}` : ""
      }${d.notes.length > 0 ? `, ${d.notes.join("; ")}` : ""}`,
      "n|name|code|unit|qty|price|VAT%|VAT|total",
      ...d.lines.map((l) =>
        [
          l.n,
          l.name,
          l.catalogCode,
          l.unit,
          l.qty,
          money(l.price),
          l.vatRate,
          money(l.vat),
          money(l.total),
        ].join("|"),
      ),
      `sum without VAT ${money(d.totals.amount)}, VAT ${money(d.totals.vat)}, total ${money(d.totals.total)} — ${
        d.issues.length === 0 ? "OK" : "CHECK"
      }`,
      ...d.issues.map((i) => `  CHECK ${i.line === null ? "document" : `line ${i.line}`}: ${i.message}`),
    );
  }
  return out.join("\n");
}

function referenceLine(d: DidoxDocument): string {
  const who = `${d.seller.name} (INN ${d.seller.tin})`;
  if (d.kind === "contract") {
    return `contract ${d.number} of ${d.date}, ${who}${d.notes.length > 0 ? `, ${d.notes.join("; ")}` : ""}`;
  }
  if (d.kind === "free") {
    return `free-form document ${d.number} of ${d.date}, ${who}${d.fileName ? `, file ${d.fileName} (its pages are not sent; attach it by itself to read it)` : ""}`;
  }
  return `reconciliation act with ${d.buyer.name || d.seller.name}`;
}
