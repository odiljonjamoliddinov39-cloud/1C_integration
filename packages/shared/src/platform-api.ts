/**
 * Contract of the PlatformAPI 1C extension (onec/extension).
 *
 * Every exported BSL function takes and returns one JSON string. The answer is always an
 * envelope: {"ok": true, "data": ...} or {"ok": false, "error": {"code", "message", "details"}},
 * never a bare 1C exception text (TD §5, "Rules for every write").
 */
import { z } from "zod";

export const PLATFORM_FUNCTIONS = [
  "Ping",
  "GetOrganizations",
  "GetMetadata",
  "RunQuery",
  "CreateInvoiceReceived",
  "PreviewInvoiceIssued",
  "CreateInvoiceIssued",
] as const;
export type PlatformFunction = (typeof PLATFORM_FUNCTIONS)[number];

/** Error codes returned by the extension, plus the ones the client adds (marked "client"). */
export const ERROR_CODES = [
  "BAD_JSON",
  "VALIDATION",
  "NOT_FOUND",
  "ORGANIZATION_NOT_FOUND",
  "COUNTERPARTY_NOT_FOUND",
  "CONTRACT_NOT_FOUND",
  "SALE_NOT_FOUND",
  "ITEM_NOT_FOUND",
  "VAT_RATE_NOT_FOUND",
  "CLOSED_PERIOD",
  "QUERY_ERROR",
  "WRITE_FAILED",
  "INTERNAL",
  // client
  "COM_UNAVAILABLE",
  "CONNECT_FAILED",
  "BAD_RESPONSE",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ApiError = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiError>;

export const Envelope = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: ApiError }),
]);
export type Envelope = z.infer<typeof Envelope>;

const Uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "1C reference (UUID)");
/** INN: 9 digits for legal entities, 14 (PINFL) for individuals. */
export const Inn = z.string().regex(/^(\d{9}|\d{14})$/, "INN must be 9 or 14 digits");
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date as YYYY-MM-DD");

// --- Ping / organizations / metadata ---------------------------------------------------------

export const PingResult = z.object({
  configuration: z.object({ name: z.string(), synonym: z.string(), version: z.string() }),
  platformVersion: z.string(),
  extensionVersion: z.string(),
  infobase: z.string(),
});
export type PingResult = z.infer<typeof PingResult>;

export const Organization = z.object({
  ref: Uuid,
  name: z.string(),
  inn: z.string(),
});
export type Organization = z.infer<typeof Organization>;

export const MetadataField = z.object({
  name: z.string(),
  synonym: z.string(),
  types: z.array(z.string()),
});

export const MetadataObject = z.object({
  fullName: z.string(), // e.g. "Документ.СчетФактураПолученный"
  synonym: z.string(),
  attributes: z.array(MetadataField),
  tabularSections: z.array(
    z.object({ name: z.string(), synonym: z.string(), attributes: z.array(MetadataField) }),
  ),
});
export type MetadataObject = z.infer<typeof MetadataObject>;

// --- RunQuery (read-only, for the AI assistant and the audit) ------------------------------------

/** Query parameter values: strings like "2026-01-31" become 1C dates. */
export const QueryParams = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

export const RunQueryInput = z.object({
  /** Text in the 1C query language (ВЫБРАТЬ ...). It cannot change data. */
  query: z.string().trim().min(1).max(20_000),
  params: QueryParams.optional().describe(
    'Values of &Name parameters in the query; "YYYY-MM-DD" strings become dates',
  ),
  /** Rows to return, at most 1000 (default 200). */
  limit: z.number().int().min(1).max(1000).optional().describe("Rows to return, default 200"),
});
export type RunQueryInput = z.infer<typeof RunQueryInput>;

/** References and enums come back as their 1C presentation; dates as YYYY-MM-DDTHH:mm:ss. */
export const QueryResult = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  truncated: z.boolean(),
});
export type QueryResult = z.infer<typeof QueryResult>;

// --- CreateInvoiceReceived ---------------------------------------------------------------------

const Money = z.number().finite();

export const InvoiceLine = z.object({
  /** Item by 1C ref, else by IKPU code, else by exact name. Phase 1 matching fills `ref`. */
  item: z
    .object({ ref: Uuid.optional(), ikpu: z.string().optional(), name: z.string().optional() })
    .refine((i) => i.ref || i.ikpu || i.name, "item needs ref, ikpu or name"),
  unit: z.string().optional(),
  quantity: z.number().positive(),
  price: Money.nonnegative(),
  /** Without VAT. */
  amount: Money,
  vatRate: z.number().min(0).max(100),
  vatAmount: Money,
  /** amount + vatAmount. */
  total: Money,
});
export type InvoiceLine = z.infer<typeof InvoiceLine>;

const CENT = 0.01;

/** The fields of a received invoice; InvoiceReceivedInput adds the amount checks. */
export const InvoiceReceivedFields = z.object({
  /** Id at the source (Didox document id ...); 1C refuses to create a second document with it. */
  externalId: z.string().min(1).max(100),
  source: z.enum(["didox", "soliq-service", "soliq-file", "manual"]),
  /** Our organization in 1C; defaults to the only one if the base has one. */
  organization: z.object({ ref: Uuid.optional(), inn: Inn.optional() }).optional(),
  /** Supplier's invoice number and date. */
  number: z.string().min(1).max(50),
  date: IsoDate,
  counterparty: z
    .object({ ref: Uuid.optional(), inn: Inn.optional() })
    .refine((c) => c.ref || c.inn, "counterparty needs ref or inn"),
  contract: z.object({ ref: Uuid }).optional(),
  lines: z.array(InvoiceLine).min(1),
  comment: z.string().max(500).optional(),
});

function checkLines(invoice: { lines: InvoiceLine[] }, ctx: z.RefinementCtx) {
  invoice.lines.forEach((line, i) => {
    if (Math.abs(line.quantity * line.price - line.amount) > CENT * Math.max(1, line.quantity)) {
      ctx.addIssue({ code: "custom", path: ["lines", i, "amount"], message: "amount ≠ quantity × price" });
    }
    if (Math.abs(line.amount + line.vatAmount - line.total) > CENT) {
      ctx.addIssue({ code: "custom", path: ["lines", i, "total"], message: "total ≠ amount + vatAmount" });
    }
  });
}

export const InvoiceReceivedInput = InvoiceReceivedFields.superRefine(checkLines);
export type InvoiceReceivedInput = z.infer<typeof InvoiceReceivedInput>;

/** A received invoice without where it came from: what the assistant drafts from the chat. */
export const InvoiceReceivedDraft = InvoiceReceivedFields.omit({
  externalId: true,
  source: true,
}).superRefine(checkLines);
export type InvoiceReceivedDraft = z.infer<typeof InvoiceReceivedDraft>;

export const CreateInvoiceResult = z.object({
  ref: Uuid,
  number: z.string(),
  date: z.string(),
  posted: z.literal(false),
  /** True when a document with this externalId already existed; nothing was written. */
  duplicate: z.boolean(),
});
export type CreateInvoiceResult = z.infer<typeof CreateInvoiceResult>;

// --- PreviewInvoiceIssued / CreateInvoiceIssued ------------------------------------------------

/** A sale (Реализация товаров и услуг): by 1C ref, or by its number and date as 1C shows them. */
export const SaleLookup = z
  .object({
    ref: Uuid.optional(),
    number: z.string().trim().min(1).max(50).optional(),
    date: IsoDate.optional(),
  })
  .refine((s) => s.ref || (s.number && s.date), "sale needs ref, or number and date");
export type SaleLookup = z.infer<typeof SaleLookup>;

/** Счет-фактура выданный on the basis of a sale, filled by 1C as its own «Выписать счет-фактуру» does. */
export const InvoiceIssuedInput = z.object({ sale: SaleLookup });
export type InvoiceIssuedInput = z.infer<typeof InvoiceIssuedInput>;

export const SaleSummary = z.object({
  ref: Uuid,
  number: z.string(),
  date: z.string(),
  organization: z.string().nullable(),
  counterparty: z.string().nullable(),
  amount: z.number().nullable(),
  posted: z.boolean(),
});
export type SaleSummary = z.infer<typeof SaleSummary>;

/** What would be written, for the user to confirm; `existing` is an invoice already made for the sale. */
export const InvoiceIssuedPreview = z.object({
  sale: SaleSummary,
  existing: z.object({ ref: Uuid, number: z.string(), date: z.string() }).nullable(),
});
export type InvoiceIssuedPreview = z.infer<typeof InvoiceIssuedPreview>;
