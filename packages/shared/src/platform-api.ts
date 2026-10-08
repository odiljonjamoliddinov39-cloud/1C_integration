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
  "GetObject",
  "PreviewChange",
  "ApplyChange",
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
  "CONFLICT",
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

/**
 * The PlatformAPI extension version this app is built for: it has every function the app calls
 * (GetObject, PreviewChange, ApplyChange). An older one still answers questions, but cannot change 1C.
 */
export const EXTENSION_VERSION = "0.4.0";

/** "0.3.0" < "0.4.0" < "0.10.0"; anything unreadable counts as older. */
export function isOlderExtension(version: string, than = EXTENSION_VERSION): boolean {
  const parts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10));
  const a = parts(version);
  const b = parts(than);
  if (a.some(Number.isNaN)) return true;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

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
  /** Rows to return; the app applies the policy's default (50) and cap (500). */
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Rows to return: 50 by default, at most 500. Prefer aggregating in the query."),
  refs: z
    .boolean()
    .optional()
    .describe(
      "Return references as {type, ref, name} instead of their names (to change those objects later)",
    ),
});
export type RunQueryInput = z.infer<typeof RunQueryInput>;

/** References and enums come back as their 1C presentation; dates as YYYY-MM-DDTHH:mm:ss. */
/** With "refs": true a reference comes as an object, to change the object later. */
export const QueryRef = z.looseObject({ type: z.string(), ref: z.string(), name: z.string() });
export type QueryRef = z.infer<typeof QueryRef>;

export const QueryResult = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null(), QueryRef]))),
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

// --- GetObject / PreviewChange / ApplyChange: any document or directory ------------------------

/** A reference as 1C returns it with refs: true. For an enumeration, `ref` is the value's name. */
export const RefValue = z.object({ type: z.string(), ref: z.string(), name: z.string() });
export type RefValue = z.infer<typeof RefValue>;

export const GetObjectInput = z.object({
  /** Full name, e.g. "Справочник.Контрагенты", "Документ.РеализацияТоваровУслуг". */
  object: z.string().trim().min(1).max(200),
  ref: Uuid,
});
export type GetObjectInput = z.infer<typeof GetObjectInput>;

export const ObjectState = z.object({
  object: z.string(),
  ref: Uuid.nullable(),
  presentation: z.string(),
  posted: z.boolean(),
  deletionMark: z.boolean(),
  /** 1C's data version: a change confirmed on an older version is refused (CONFLICT). */
  version: z.string(),
});
export type ObjectState = z.infer<typeof ObjectState>;

export const ObjectSnapshot = ObjectState.extend({
  fields: z.record(z.string(), z.unknown()),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});
export type ObjectSnapshot = z.infer<typeof ObjectSnapshot>;

/**
 * A change to one document or directory item. Field names are 1C's (see GetMetadata). A reference
 * field takes {ref} | {find: {field: value}} | {name} | {code}, with `type` when the field allows
 * several types; an enumeration takes the value's name; a date "YYYY-MM-DD[THH:mm:ss]". `tables`
 * replaces whole tabular sections. delete = deletion mark (undelete removes it). A document is
 * posted when `post` is true; a posted document that is changed is re-posted unless `post` is false.
 */
export const ChangeInput = z
  .object({
    action: z.enum(["create", "update", "delete", "undelete"]),
    object: z.string().trim().min(1).max(200),
    ref: Uuid.optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
    tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).optional(),
    post: z.boolean().optional(),
  })
  .refine((c) => c.action === "create" || c.ref, {
    message: "ref is required to change an existing object",
    path: ["ref"],
  })
  .refine((c) => c.action !== "create" || c.fields || c.tables, {
    message: "fields or tables are required to create an object",
    path: ["fields"],
  });
export type ChangeInput = z.infer<typeof ChangeInput>;

export const ChangePreview = ObjectState.extend({
  action: z.enum(["create", "update", "delete", "undelete"]),
  willPost: z.boolean(),
  changes: z.array(z.object({ field: z.string(), before: z.unknown(), after: z.unknown() })),
  tables: z.array(
    z.object({
      table: z.string(),
      rowsBefore: z.number(),
      rowsAfter: z.number(),
      rows: z.array(z.record(z.string(), z.unknown())),
    }),
  ),
  /** 1C's own filling checks (ПроверитьЗаполнение); the write may still be refused. */
  warnings: z.array(z.string()),
});
export type ChangePreview = z.infer<typeof ChangePreview>;

export const ApplyChangeInput = z.intersection(ChangeInput, z.object({ version: z.string().optional() }));
export type ApplyChangeInput = z.infer<typeof ApplyChangeInput>;
