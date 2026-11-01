/**
 * The CRM (docs/crm.md): leads from the first contact to a customer, in one place, with a funnel the admin shapes and
 * the conversion measured. The operators work in a Telegram Mini App; the owner sees the funnel and the reports.
 */
import { z } from "zod";

const Id = z.uuid();
const Text = (max: number) => z.string().trim().max(max);

/** Where a lead came from, as typed (free text: "instagram", "reklama", "tavsiya"…); the reports group by it. */
export const LeadSource = Text(60);

export const CrmStageInput = z
  .object({
    name: Text(60).min(1),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#64748b"),
    /** A lead that reached this stage became a customer ("yutuq"). */
    isWon: z.boolean().default(false),
    /** A lead that reached this stage is gone ("yo'qotish"). Lost stages are outside the funnel. */
    isLost: z.boolean().default(false),
  })
  .refine((s) => !(s.isWon && s.isLost), { message: "A stage cannot be both won and lost" });
export type CrmStageInput = z.infer<typeof CrmStageInput>;

export const CrmStageUpdate = z
  .object({
    name: Text(60).min(1).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    isWon: z.boolean().optional(),
    isLost: z.boolean().optional(),
  })
  .refine((s) => !(s.isWon && s.isLost), { message: "A stage cannot be both won and lost" });
export type CrmStageUpdate = z.infer<typeof CrmStageUpdate>;

export const CrmStageOrderInput = z.object({ ids: z.array(Id).min(1).max(50) });
export type CrmStageOrderInput = z.infer<typeof CrmStageOrderInput>;

export interface CrmStageView {
  id: string;
  name: string;
  position: number;
  color: string;
  isWon: boolean;
  isLost: boolean;
  /** Leads in this stage now (what the caller may see). */
  leads: number;
}

export interface CrmPipelineView {
  id: string;
  name: string;
  stages: CrmStageView[];
}

export const CrmLeadInput = z.object({
  name: Text(120).min(1),
  phone: Text(40).min(1),
  source: LeadSource.optional(),
  company: Text(120).optional(),
  note: Text(2000).optional(),
  /** Empty: the first stage. */
  stageId: Id.optional(),
});
export type CrmLeadInput = z.infer<typeof CrmLeadInput>;

export const CrmLeadUpdate = z.object({
  name: Text(120).min(1).optional(),
  phone: Text(40).min(1).optional(),
  source: LeadSource.nullable().optional(),
  company: Text(120).nullable().optional(),
  /** Who works with the lead (a manager's admin id); staff only. */
  ownerId: Id.nullable().optional(),
});
export type CrmLeadUpdate = z.infer<typeof CrmLeadUpdate>;

export const CrmStageMoveInput = z.object({ stageId: Id });
export type CrmStageMoveInput = z.infer<typeof CrmStageMoveInput>;

export const CrmNoteInput = z.object({ text: Text(2000).min(1) });
export type CrmNoteInput = z.infer<typeof CrmNoteInput>;

export const CALL_RESULTS = ["answered", "no_answer", "busy", "callback", "wrong_number"] as const;
export const CallResult = z.enum(CALL_RESULTS);
export type CallResult = z.infer<typeof CallResult>;

export const CrmCallInput = z.object({
  result: CallResult,
  /** Seconds the call lasted; empty when the operator did not say. */
  durationSec: z.number().int().min(0).max(36_000).optional(),
  note: Text(1000).optional(),
});
export type CrmCallInput = z.infer<typeof CrmCallInput>;

export const CrmLeadsQuery = z.object({
  q: Text(100).optional(),
  stageId: Id.optional(),
  source: Text(60).optional(),
  ownerId: z.union([Id, z.literal("none")]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type CrmLeadsQuery = z.infer<typeof CrmLeadsQuery>;

export interface CrmLeadRow {
  id: string;
  name: string;
  phone: string;
  source: string | null;
  company: string | null;
  stageId: string;
  stageName: string;
  stageColor: string;
  ownerId: string | null;
  ownerName: string | null;
  lastContactAt: string | null;
  createdAt: string;
}

export interface CrmLeadsResponse {
  total: number;
  leads: CrmLeadRow[];
}

export interface CrmNoteView {
  id: string;
  text: string;
  authorName: string | null;
  createdAt: string;
}

export interface CrmCallView {
  id: string;
  result: CallResult;
  durationSec: number | null;
  note: string | null;
  byName: string | null;
  startedAt: string;
}

export interface CrmHistoryView {
  id: string;
  fromStage: string | null;
  toStage: string;
  byName: string | null;
  at: string;
}

export interface CrmLeadDetail {
  lead: CrmLeadRow;
  notes: CrmNoteView[];
  calls: CrmCallView[];
  history: CrmHistoryView[];
}

/** A lead was added: `created` false means a lead with this phone existed and was updated instead. */
export interface CrmLeadSaved {
  lead: CrmLeadRow;
  created: boolean;
}

export interface CrmMe {
  id: string;
  name: string;
  role: "owner" | "support" | "manager";
  /** Sees every lead (owner, support) or only their own (manager). */
  seesAll: boolean;
}

export interface CrmManagerView {
  id: string;
  name: string;
  email: string;
}

export const CrmImportSheetInput = z.object({ url: z.url().max(500) });
export type CrmImportSheetInput = z.infer<typeof CrmImportSheetInput>;

/** An .xlsx file travels base64-coded inside JSON (up to about 5 MB of file). */
export const CrmImportFileInput = z.object({
  fileName: Text(200).min(1),
  dataBase64: z.string().min(1).max(7_000_000),
});
export type CrmImportFileInput = z.infer<typeof CrmImportFileInput>;

export interface CrmImportError {
  /** The row's number in the sheet (the header is row 1). */
  row: number;
  reason: string;
}

export interface CrmImportJobView {
  id: string;
  source: "excel" | "google_sheet";
  fileName: string;
  status: "running" | "done" | "failed";
  rowsTotal: number;
  rowsCreated: number;
  rowsUpdated: number;
  rowsFailed: number;
  /** The first rows that failed, with the reason; the rest are only counted. */
  errors: CrmImportError[];
  /** Which sheet columns went to which CRM field, and which were left out. */
  mapped: { column: string; field: string }[];
  ignored: string[];
  /** A problem with the whole file (not one row). */
  failure: string | null;
  createdByName: string | null;
  createdAt: string;
}

export const CrmReportQuery = z.object({
  /** Leads created on or after this day (YYYY-MM-DD). */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** …and on or before this day. */
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type CrmReportQuery = z.infer<typeof CrmReportQuery>;

export interface CrmFunnelStep {
  stageId: string;
  name: string;
  color: string;
  /** Leads that reached this stage or went further. */
  reached: number;
  /** Of the previous step: what share came here (null for the first). */
  fromPrevPct: number | null;
  /** Of all the leads: what share reached this stage. */
  fromFirstPct: number | null;
  isWon: boolean;
}

export interface CrmReport {
  period: { from: string | null; to: string | null };
  totalLeads: number;
  /** New lead → customer. */
  conversionPct: number;
  won: number;
  lost: number;
  funnel: CrmFunnelStep[];
  /** The lost stages are outside the funnel: how many leads ended in each. */
  lostStages: { stageId: string; name: string; leads: number }[];
  timeInStage: { stageId: string; name: string; avgHours: number | null; leads: number }[];
  bySource: { source: string; leads: number; won: number; conversionPct: number }[];
  byManager: {
    ownerId: string | null;
    name: string;
    leads: number;
    won: number;
    lost: number;
    conversionPct: number;
    /** Won against won + lost. */
    winRatePct: number | null;
  }[];
}
