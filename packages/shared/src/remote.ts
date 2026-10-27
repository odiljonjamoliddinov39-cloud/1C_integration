/**
 * Telegram remote control: the contracts the server, the Mini App and the desktop app all import (docs/remote-control.md).
 * The phone leaves a request in a mailbox on the server, the desktop app takes it when the PC is online, runs it once and sends
 * the result back. A request is never lost and never answered twice.
 */
import { z } from "zod";

/** The commands the server accepts and the desktop knows how to run. Nothing outside this list is accepted. */
export const REMOTE_COMMAND_TYPES = [
  "chat.message",
  "chat.attach",
  "proposal.list",
  "proposal.apply",
  "report.make",
  "status.get",
] as const;
export const RemoteCommandType = z.enum(REMOTE_COMMAND_TYPES);
export type RemoteCommandType = z.infer<typeof RemoteCommandType>;

/**
 * What a command may do to the books. Read changes nothing; Prepare makes unposted proposals; Apply creates documents (unposted)
 * from a proposal the user confirmed. Posting, deletion and marking for deletion are not available from the phone in version 1.
 */
export const RemoteClass = z.enum(["read", "prepare", "apply"]);
export type RemoteClass = z.infer<typeof RemoteClass>;

/** The most a Telegram link may do; the same order as the classes. */
export const RemoteCeiling = RemoteClass;
export type RemoteCeiling = z.infer<typeof RemoteCeiling>;

const RANK: Record<RemoteClass, number> = { read: 0, prepare: 1, apply: 2 };
export const classAllowed = (ceiling: RemoteCeiling, wanted: RemoteClass) => RANK[wanted] <= RANK[ceiling];

/**
 * The class a command is created with. A message may only ask or may make proposals: the server cannot tell, so it is a Prepare
 * command when the link may prepare, and a Read command (the desktop refuses it if the assistant would propose anything) when
 * it may not.
 */
export function classOf(type: RemoteCommandType, ceiling: RemoteCeiling): RemoteClass {
  switch (type) {
    case "status.get":
    case "proposal.list":
    case "report.make":
      return "read";
    case "chat.attach":
      return "prepare";
    case "proposal.apply":
      return "apply";
    case "chat.message":
      return classAllowed(ceiling, "prepare") ? "prepare" : "read";
  }
}

export const REMOTE_STATES = [
  "queued",
  "delivered",
  "running",
  "done",
  "failed",
  "expired",
  "cancelled",
] as const;
export const RemoteState = z.enum(REMOTE_STATES);
export type RemoteState = z.infer<typeof RemoteState>;
export const OPEN_STATES: RemoteState[] = ["queued", "delivered", "running"];

/** How long a command may wait for the PC, in hours: Read and Prepare a day, Apply two hours. */
export const TTL_HOURS: Record<RemoteClass, number> = { read: 24, prepare: 24, apply: 2 };

/** The limits of section 6: commands a minute per link, open commands per device, the size of an uploaded file. */
export const REMOTE_LIMITS = {
  commandsPerMinute: 30,
  openPerDevice: 50,
  maxFileBytes: 20 * 1024 * 1024,
  /** A generated output and an uploaded file live this long. */
  blobHours: 24,
  /** The desktop pings every 25 seconds; the server marks it offline after 60 seconds of silence. */
  pingSeconds: 25,
  offlineAfterSeconds: 60,
  pairingMinutes: 10,
  /** initData older than this is refused. */
  initDataMaxAgeSeconds: 3600,
  maxMessageChars: 4000,
} as const;

export const ErrorBody = z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() });
export type ErrorBody = z.infer<typeof ErrorBody>;

// ---- payloads, one per command type ----

export const ChatMessagePayload = z.object({
  text: z.string().trim().min(1).max(REMOTE_LIMITS.maxMessageChars),
});
export const ChatAttachPayload = z.object({
  /** The uploaded file (POST /remote/blobs). */
  blob_id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
});
export const EmptyPayload = z.object({}).strict();
export const ProposalApplyPayload = z.object({
  /** The card the user confirmed, as proposal.list gave it. */
  proposal_id: z.string().min(1).max(100),
});
export const REPORT_KINDS = ["audit", "balance", "debts", "vat"] as const;
export const ReportMakePayload = z.object({
  report: z.enum(REPORT_KINDS),
  format: z.enum(["xlsx", "pdf"]),
  /** YYYY-MM-DD; a report of a period. */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const PAYLOADS = {
  "chat.message": ChatMessagePayload,
  "chat.attach": ChatAttachPayload,
  "proposal.list": EmptyPayload,
  "proposal.apply": ProposalApplyPayload,
  "report.make": ReportMakePayload,
  "status.get": EmptyPayload,
} as const satisfies Record<RemoteCommandType, z.ZodType>;

/** A body for POST /remote/commands. The company is named by its INN: a command for one company never runs in another. */
export const CreateCommandInput = z.object({
  type: RemoteCommandType,
  company_inn: z.string().regex(/^\d{9}$/, "a company's INN is 9 digits"),
  payload: z.unknown(),
  /** Apply only: the hash of the proposal the user was shown; the PC refuses it if the proposal changed. */
  proposal_hash: z.string().length(64).optional(),
  /** The client's own id: the same one sent twice (a double tap) makes one command. */
  request_id: z.string().uuid(),
});
export type CreateCommandInput = z.infer<typeof CreateCommandInput>;

/** The payload checked against its command type; an Apply command must carry the proposal's hash. */
export function parsePayload(
  input: Pick<CreateCommandInput, "type" | "payload" | "proposal_hash">,
): { ok: true; payload: unknown } | { ok: false; message: string } {
  const parsed = PAYLOADS[input.type].safeParse(input.payload ?? {});
  if (!parsed.success)
    return {
      ok: false,
      message: parsed.error.issues.map((i) => `${i.path.join(".") || "payload"}: ${i.message}`).join("; "),
    };
  if (input.type === "proposal.apply" && !input.proposal_hash)
    return {
      ok: false,
      message: "proposal_hash: an Apply command carries the hash of the proposal it confirms",
    };
  return { ok: true, payload: parsed.data };
}

// ---- results, one shape per command type ----

export const ProposalCard = z.object({
  id: z.string(),
  title: z.string(),
  /** Lines the Mini App shows (amounts and names live here, never in a chat message). */
  lines: z.array(z.string()).max(50),
  /** The hash of what was shown: an Apply carries it. */
  hash: z.string().length(64),
  status: z.enum(["waiting", "applied", "skipped", "refused", "changed"]),
});
export type ProposalCard = z.infer<typeof ProposalCard>;

export const ChatMessageResult = z.object({ reply: z.string(), cards: z.array(ProposalCard).default([]) });
export const ChatAttachResult = z.object({ summary: z.string() });
export const ProposalListResult = z.object({ cards: z.array(ProposalCard) });
export const ProposalApplyResult = z.object({
  created: z.number().int(),
  skipped: z.number().int(),
  refused: z.number().int(),
  reasons: z.array(z.string()).max(50),
});
export const ReportMakeResult = z.object({ summary: z.string() });
export const StatusResult = z.object({
  online: z.literal(true),
  onec_reachable: z.boolean(),
  company: z.string(),
  app_version: z.string(),
  last_import: z.string().nullable(),
});
export const RESULTS = {
  "chat.message": ChatMessageResult,
  "chat.attach": ChatAttachResult,
  "proposal.list": ProposalListResult,
  "proposal.apply": ProposalApplyResult,
  "report.make": ReportMakeResult,
  "status.get": StatusResult,
} as const satisfies Record<RemoteCommandType, z.ZodType>;

export const BlobRef = z.object({
  id: z.string().uuid(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().length(64),
});
export type BlobRef = z.infer<typeof BlobRef>;

// ---- the desktop's WebSocket (wss://<server>/remote/device) ----

export const RemoteCompany = z.object({ inn: z.string(), name: z.string() });

export const WsHello = z.object({
  type: z.literal("hello"),
  app_version: z.string(),
  companies: z.array(RemoteCompany).max(100),
  capabilities: z.array(z.string()).max(50),
  /** The ids the PC has already run (remote_inbox): the server does not send those again. */
  done_ids: z.array(z.string().uuid()).max(1000).default([]),
});
export const WsCommand = z.object({
  type: z.literal("command"),
  id: z.string().uuid(),
  command_type: RemoteCommandType,
  class: RemoteClass,
  company_inn: z.string(),
  payload: z.unknown(),
  expires_at: z.string(),
  proposal_hash: z.string().length(64).optional(),
  /** The link's ceiling: the PC checks it too and never trusts the server alone. */
  ceiling: RemoteCeiling,
  /** The Telegram user the command came from (for the PC's own log). */
  telegram_user: z.string(),
});
export const WsAck = z.object({ type: z.literal("ack"), id: z.string().uuid() });
export const WsProgress = z.object({
  type: z.literal("progress"),
  id: z.string().uuid(),
  text: z.string().max(200),
});
export const WsResult = z.object({
  type: z.literal("result"),
  id: z.string().uuid(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  blobs: z.array(BlobRef).max(10).default([]),
  error: ErrorBody.optional(),
});
export const WsPing = z.object({ type: z.literal("ping") });
export const WsPong = z.object({ type: z.literal("pong") });
export const WsRevoke = z.object({
  type: z.literal("revoke"),
  reason: z.enum(["link_revoked", "device_disabled"]),
});
export const NOTIFY_EVENTS = ["import.finished", "proposal.waiting", "error", "license.near_end"] as const;
export const WsNotify = z.object({
  type: z.literal("notify"),
  event: z.enum(NOTIFY_EVENTS),
  company_inn: z.string().optional(),
  /** Only a number: documents ready, proposals waiting. Never an amount or a name. */
  count: z.number().int().nonnegative().optional(),
});

export const WsToServer = z.discriminatedUnion("type", [
  WsHello,
  WsAck,
  WsProgress,
  WsResult,
  WsPing,
  WsPong,
  WsNotify,
]);
export const WsToDevice = z.discriminatedUnion("type", [WsCommand, WsPing, WsPong, WsRevoke]);
export type WsHello = z.infer<typeof WsHello>;
export type WsCommand = z.infer<typeof WsCommand>;
export type WsResult = z.infer<typeof WsResult>;
export type WsNotify = z.infer<typeof WsNotify>;
export type WsToServer = z.infer<typeof WsToServer>;
export type WsToDevice = z.infer<typeof WsToDevice>;

// ---- pairing and devices (desktop → server over HTTPS) ----

export const RegisterDeviceInput = z.object({
  name: z.string().trim().min(1).max(100),
  app_version: z.string().max(40),
});
export const RegisterDeviceResult = z.object({ device_id: z.string().uuid(), token: z.string() });
export const PairingResult = z.object({ code: z.string(), link: z.string(), expires_at: z.string() });
export const LinkView = z.object({
  id: z.string().uuid(),
  username: z.string().nullable(),
  ceiling: RemoteCeiling,
  created_at: z.string(),
});
export type LinkView = z.infer<typeof LinkView>;

/** The command as the phone sees it (GET /remote/commands/:id). The payload and the result stay on the server's encrypted rows. */
export const CommandView = z.object({
  id: z.string().uuid(),
  type: RemoteCommandType,
  class: RemoteClass,
  company_inn: z.string(),
  state: RemoteState,
  created_at: z.string(),
  expires_at: z.string(),
  finished_at: z.string().nullable(),
  result: z.unknown().optional(),
  blobs: z.array(BlobRef).default([]),
  error: ErrorBody.nullable().optional(),
  progress: z.string().nullable().optional(),
});
export type CommandView = z.infer<typeof CommandView>;

/** The Telegram message for an event: a count and the app's name, nothing from the books (section 6). */
export function notificationText(
  event: (typeof NOTIFY_EVENTS)[number],
  lang: "uz" | "ru" | "en",
  count = 0,
): string {
  const T = {
    "import.finished": {
      uz: `Import tugadi: ${count} ta hujjat tayyor. Ilovani oching.`,
      ru: `Импорт завершён: готово документов — ${count}. Откройте приложение.`,
      en: `Import finished: ${count} documents are ready. Open the app.`,
    },
    "proposal.waiting": {
      uz: `${count} ta taklif sizni kutyapti. Ilovani oching.`,
      ru: `Предложений ждёт вас: ${count}. Откройте приложение.`,
      en: `${count} proposals are waiting for you. Open the app.`,
    },
    error: {
      uz: "Xatolik yuz berdi. Ilovani oching.",
      ru: "Произошла ошибка. Откройте приложение.",
      en: "Something went wrong. Open the app.",
    },
    "license.near_end": {
      uz: "Litsenziya muddati tugash arafasida. Ilovani oching.",
      ru: "Срок лицензии подходит к концу. Откройте приложение.",
      en: "Your license is near its end. Open the app.",
    },
  } as const;
  return T[event][lang];
}
