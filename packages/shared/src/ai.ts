/**
 * The AI assistant (TD §7 "AI assistant", §8 "AI proxy"). The desktop app runs the tools against
 * 1C on the PC and sends the conversation to the control system; the control system holds the
 * Claude API key, the system prompt and the tool list, and counts tokens per account.
 */
import { z } from "zod";

import {
  ChangeInput,
  GetObjectInput,
  InvoiceReceivedDraft,
  RunQueryInput,
  SaleLookup,
} from "./platform-api.js";

const Column = z
  .string()
  .regex(/^[A-Za-z]{1,3}$/)
  .describe("A column by its letter, as in Excel: A, B, … AA");

/**
 * Reads a spreadsheet or CSV the user attached to the chat; runs on the PC, over the whole file.
 * Rows can be filtered; with group_by or sum it returns counts and totals instead of rows.
 */
export const ReadAttachmentInput = z.object({
  /** The file name as attached. */
  file: z.string().min(1).max(200),
  /** Sheet name; the first sheet when absent. */
  sheet: z.string().max(100).optional(),
  /** Row numbers (1-based, inclusive) to look at; the whole sheet when absent. */
  from: z.number().int().min(1).optional(),
  to: z.number().int().min(1).optional(),
  where: z
    .array(
      z.object({
        column: Column,
        op: z.enum(["=", "!=", "contains", ">", ">=", "<", "<=", "empty", "not_empty"]),
        value: z.string().max(200).optional(),
      }),
    )
    .max(10)
    .optional(),
  /** Groups the matching rows by a column's value, or by the day or month of a date column. */
  group_by: z.object({ column: Column, by: z.enum(["value", "day", "month"]).default("value") }).optional(),
  /** Columns to total (numbers like "1 234 567,89" are read too). */
  sum: z.array(Column).max(10).optional(),
  /** Columns to return when listing rows; all when absent. */
  columns: z.array(Column).max(30).optional(),
  /** Rows (or groups) to return, at most 5000; 200 by default. */
  limit: z.number().int().min(1).max(5000).optional(),
});
export type ReadAttachmentInput = z.infer<typeof ReadAttachmentInput>;

/**
 * Several changes on one card with one confirmation: a bank statement's documents, a list of
 * invoices. Each is checked by 1C first; those 1C refuses are shown and left out.
 */
export const ChangeBatchInput = z.object({
  /** What the batch does, for the card's title, e.g. "Bank statement 01–15.09: 42 documents". */
  title: z.string().trim().min(1).max(200),
  changes: z.array(ChangeInput).min(1).max(1000),
});
export type ChangeBatchInput = z.infer<typeof ChangeBatchInput>;

/** One problem an audit check found. */
export const AuditFinding = z.object({
  severity: z.enum(["high", "medium", "low"]),
  title: z.string().trim().min(1).max(300),
  detail: z.string().max(2000).default(""),
  /** The money involved, in UZS, when there is an amount. */
  amount: z.number().optional(),
  date: z.string().max(40).optional(),
  counterparty: z.string().max(300).optional(),
  /** The document or item as 1C shows it, e.g. "Реализация 0000-000123 от 05.09.2026". */
  document: z.string().max(300).optional(),
});
export type AuditFinding = z.infer<typeof AuditFinding>;

/** The result of one audit check: the model's last call in it. */
export const ReportFindingsInput = z.object({
  status: z.enum(["ok", "issues", "not_applicable"]),
  /** One or two sentences: what was checked and what was found. */
  summary: z.string().trim().min(1).max(1000),
  /** One per problem, most important first; empty when the status is ok. */
  findings: z.array(AuditFinding).max(300).default([]),
});
export type ReportFindingsInput = z.infer<typeof ReportFindingsInput>;

/**
 * Tools the assistant may call; the desktop runs them through PlatformAPI. The read tools run at
 * once. The propose_* tools never write: the desktop shows the document to the user, and only the
 * user's click creates it in 1C (unposted). The tool result says what the user decided.
 */
export const AI_TOOLS = {
  list_organizations: z.object({}),
  describe_objects: z.object({
    /** Full 1C names, e.g. "Документ.СчетФактураПолученный", "РегистрБухгалтерии.Хозрасчетный". */
    objects: z.array(z.string().min(1)).min(1).max(20),
  }),
  run_query: RunQueryInput,
  get_object: GetObjectInput,
  read_attachment: ReadAttachmentInput,
  propose_change: ChangeInput,
  propose_changes: ChangeBatchInput,
  propose_invoice_issued: z.object({ sale: SaleLookup }),
  propose_invoice_received: InvoiceReceivedDraft,
  report_findings: ReportFindingsInput,
} as const;
export type AiToolName = keyof typeof AI_TOOLS;

export const AI_PROPOSAL_TOOLS = [
  "propose_change",
  "propose_changes",
  "propose_invoice_issued",
  "propose_invoice_received",
] as const;
export type AiProposalTool = (typeof AI_PROPOSAL_TOOLS)[number];
/** Tools that run in the app itself, over the chat's attached files, not in 1C. */
export const AI_LOCAL_TOOLS = ["read_attachment", "report_findings"] as const;
export type AiLocalTool = (typeof AI_LOCAL_TOOLS)[number];
/** Tools that read 1C. */
export type AiReadTool = Exclude<AiToolName, AiProposalTool | AiLocalTool>;

export function isProposalTool(name: AiToolName): name is AiProposalTool {
  return (AI_PROPOSAL_TOOLS as readonly string[]).includes(name);
}

/** The tools of a chat with the accountant. */
export const CHAT_TOOLS: AiToolName[] = (Object.keys(AI_TOOLS) as AiToolName[]).filter(
  (name) => name !== "report_findings",
);
/** The tools of one audit check: it reads 1C and reports what it found. */
export const AUDIT_TOOLS: AiToolName[] = [
  "list_organizations",
  "describe_objects",
  "run_query",
  "get_object",
  "report_findings",
];

export function isAiToolName(name: string): name is AiToolName {
  return Object.hasOwn(AI_TOOLS, name);
}

/** A content block as the Claude API returns it. Passed back unchanged: thinking blocks must be. */
export const AiContentBlock = z.looseObject({ type: z.string() });
export type AiContentBlock = z.infer<typeof AiContentBlock>;

export const AiMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string().min(1), z.array(AiContentBlock).min(1)]),
});
export type AiMessage = z.infer<typeof AiMessage>;

/** Tools of the first app versions, which do not say which tools they have. */
export const LEGACY_AI_TOOLS = ["list_organizations", "describe_objects", "run_query"] as const;

export const AiChatInput = z.object({
  /** The company the questions are about (its 1C organization name). */
  company: z.string().trim().min(1).max(200),
  /**
   * Tools this app version can run. The proxy offers the model only these, so an older app is
   * never asked to run a tool it does not have. Absent: LEGACY_AI_TOOLS.
   */
  tools: z.array(z.string().max(64)).max(50).optional(),
  messages: z.array(AiMessage).min(1).max(20_000),
});
export type AiChatInput = z.infer<typeof AiChatInput>;

export const AiToolUse = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
export type AiToolUse = z.infer<typeof AiToolUse>;

/** POST /v1/ai/chat answers with one JSON event per line. */
export const AiEvent = z.discriminatedUnion("type", [
  /** A piece of the answer text, as it is generated. */
  z.object({ type: z.literal("text"), text: z.string() }),
  /** A piece of the model's progress note between tool calls ("checking September's payments…"). */
  z.object({ type: z.literal("progress"), text: z.string() }),
  /** Sent every few seconds while the model works, so a quiet connection is not taken for a dead one. */
  z.object({ type: z.literal("ping") }),
  /** The finished turn: append `content` to the conversation as the assistant message. */
  z.object({
    type: z.literal("message"),
    content: z.array(AiContentBlock),
    stopReason: z.string().nullable(),
  }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type AiEvent = z.infer<typeof AiEvent>;
