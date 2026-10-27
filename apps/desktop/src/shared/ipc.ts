/**
 * The typed bridge between the renderer (React UI) and the main process (TD §4: contextBridge,
 * no nodeIntegration). The renderer only sees `window.platform`; everything that touches 1C,
 * files or secrets runs in the main process.
 */
import type {
  AuditFinding,
  ChangePreview,
  DeleteMarkedPreview,
  DeleteMarkedResult,
  CreateInvoiceResult,
  EntitlementsResponse,
  InvoiceReceivedDraft,
  ObjectState,
  Organization,
  PingResult,
  SaleSummary,
} from "@platform/shared";
import { FinancialReportInput } from "@platform/shared";
import { z } from "zod";

import type { ChatEntry } from "./transcript.js";

export const InfobaseInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), file: z.string().trim().min(1) }),
  z.object({ kind: z.literal("server"), server: z.string().trim().min(1), ref: z.string().trim().min(1) }),
]);
export type InfobaseInput = z.infer<typeof InfobaseInput>;

export const ConnectionInput = z.object({
  infobase: InfobaseInput,
  user: z.string(),
  password: z.string(),
});
export type ConnectionInput = z.infer<typeof ConnectionInput>;

export const AddCompanyInput = ConnectionInput.extend({
  organization: z.object({ ref: z.string(), name: z.string(), inn: z.string() }),
});
export type AddCompanyInput = z.infer<typeof AddCompanyInput>;

export const SignInInput = z.object({
  serverUrl: z.url({ protocol: /^https?$/ }),
  email: z.email(),
  password: z.string().min(1),
});
export type SignInInput = z.infer<typeof SignInInput>;

export const RegisterAccountInput = SignInInput.extend({
  password: z.string().min(10),
  name: z.string().trim().min(1),
  accountName: z.string().trim().min(1),
});
export type RegisterAccountInput = z.infer<typeof RegisterAccountInput>;

/** A key E-IMZO shows on this PC (never its password). */
export interface DidoxKeyView {
  serialNumber: string;
  tin: string;
  commonName: string;
  organization: string;
  validTo: string | null;
}

/** How a company reaches Didox: the API address and the E-IMZO key (its serial number) to sign in with. Not secret. */
export const DidoxSettings = z.object({
  baseUrl: z.string().trim().min(1).max(200),
  serialNumber: z.string().trim().min(1).max(100),
});
export type DidoxSettings = z.infer<typeof DidoxSettings>;

export const DidoxTestInput = z.object({
  /** Didox's address; the development server when empty. */
  baseUrl: z.string().trim().max(200).optional(),
  /** The partner key Didox gave (header api-key). */
  apiKey: z.string().trim().max(200).optional(),
  /** The key (hex serial number) to sign with when E-IMZO shows several. */
  serialNumber: z.string().trim().max(100).optional(),
});
export type DidoxTestInput = z.infer<typeof DidoxTestInput>;

export interface DidoxTestStep {
  name: "eimzo" | "keys" | "login" | "profile" | "documents" | "document" | "file";
  ok: boolean;
  /** What was found, or why it failed; the answers of Didox in full are cut at a few lines. */
  detail: string;
}
export interface DidoxTestResult {
  baseUrl: string;
  steps: DidoxTestStep[];
}

/** Result of reaching 1C; never throws across the bridge. */
export type ConnectorStatus =
  | { ok: true; checkedAt: string; ping: PingResult }
  | { ok: false; checkedAt: string; code: string; message: string };

export interface ConnectionTestResult {
  status: ConnectorStatus;
  organizations: Organization[];
}

export interface CompanyView {
  id: string;
  name: string;
  inn: string;
  infobase: InfobaseInput;
  user: string;
  createdAt: string;
  lastStatus: ConnectorStatus | null;
  lastSyncAt: string | null;
  aiEnabled: boolean;
  /** Set once the Didox test worked and was saved for this company; null: Didox is not connected. */
  didox: DidoxSettings | null;
}

/** The license as the desktop sees it (TD §4 "Licensing behavior"). */
export interface LicenseView {
  plan: string;
  status: string;
  /** End of the trial or paid period. */
  paidUntil: string;
  /** End of the offline grace: after this, without a check, the app is read-only. */
  expiresAt: string;
  checkedAt: string;
  mode: "active" | "read_only";
  reason: null | "expired_offline" | "suspended" | "cancelled" | "wrong_machine" | "invalid";
}

export interface Session {
  email: string;
  name: string;
  accountName: string;
  serverUrl: string;
  signedInAt: string;
  license: LicenseView | null;
}

/** The plan, its limits and what is used: from the server, with the companies this PC could not register. */
export type BillingView = EntitlementsResponse;

export interface AppInfo {
  /** Control system address baked into this build (editable on the sign-in screen). */
  defaultServerUrl: string;
  version: string;
  platform: string;
  arch: string;
  demo1C: boolean;
}

/** Files the user can attach to a question, and how many and how large. */
export const ATTACHMENTS = {
  /** Extensions the assistant reads; the window offers only these. */
  extensions: [
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".xlsx",
    ".docx",
    ".csv",
    ".txt",
    ".xml",
    ".json",
    ".zip",
  ],
  maxFiles: 20,
  maxBytes: 10 * 1024 * 1024,
} as const;

export const AssistantFile = z.object({
  name: z.string().trim().min(1).max(200),
  data: z.instanceof(Uint8Array).refine((d) => d.byteLength <= ATTACHMENTS.maxBytes, {
    message: "The file is larger than 10 MB",
  }),
});
export type AssistantFile = z.infer<typeof AssistantFile>;

export const AssistantInput = z
  .object({
    companyId: z.string().min(1),
    /** The chat this question belongs to; a new id starts a new chat. Absent: the open chat. */
    chatId: z.uuid().optional(),
    text: z.string().trim().max(4000),
    files: z.array(AssistantFile).max(ATTACHMENTS.maxFiles).optional(),
    /** Ask the model even if a template or a stored answer could answer ("Ask AI anyway"). */
    skipFree: z.boolean().optional(),
    /** The learned template whose answer was not wanted: the server turns it off. */
    rejectTemplate: z.string().max(60).optional(),
  })
  .refine((input) => input.text.length > 0 || (input.files?.length ?? 0) > 0, {
    message: "Write a question or attach a file",
  });
export type AssistantInput = z.input<typeof AssistantInput>;

export const UiLanguage = z.enum(["en", "ru", "uz"]);

/** One report asked for on the Reports screen: which company, which report, the period or day, in which language. */
export const ReportRunInput = FinancialReportInput.extend({
  companyId: z.string().min(1),
  lang: z.enum(["en", "ru", "uz"]),
});
export type ReportRunInput = z.input<typeof ReportRunInput>;

/** A report as the screen shows it: its figures (by the report's own shape) and the same in words. */
export interface ReportView {
  report: string;
  data: unknown;
  text: string;
}
export type UiLanguage = z.infer<typeof UiLanguage>;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date as YYYY-MM-DD");

/** Starts an audit of a company's base: a fixed checklist over a period, in a new chat. */
export const AuditInput = z
  .object({
    companyId: z.uuid(),
    /** The new chat the audit is kept in; the window picks it, as for a new question. */
    chatId: z.uuid(),
    from: IsoDate,
    to: IsoDate,
    /** The window's language: the findings are written in it. */
    language: UiLanguage,
  })
  .refine((input) => input.from <= input.to, { message: "The period starts after it ends", path: ["from"] });
export type AuditInput = z.infer<typeof AuditInput>;

export type AuditStatus = "pending" | "running" | "ok" | "issues" | "not_applicable" | "failed";

export interface AuditCheckView {
  id: string;
  section: string;
  title: string;
  status: AuditStatus;
  /** What the check is doing now (the last 1C lookup), while it runs. */
  activity?: string;
  summary?: string;
  findings?: AuditFinding[];
  ms?: number;
}

export interface AuditView {
  from: string;
  to: string;
  language: UiLanguage;
  checks: AuditCheckView[];
  finished: boolean;
}

export type AttachmentKind = "image" | "pdf" | "spreadsheet" | "document" | "text" | "archive";

/** An attached file as the chat shows it; its content goes to the model, not to the screen. */
export interface AttachmentInfo {
  name: string;
  kind: AttachmentKind;
  size: number;
}

/** A saved chat in the list. */
export interface ChatSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatView extends ChatSummary {
  entries: ChatEntry[];
}

/** One change of a batch: 1C's preview of it, or why 1C refused it (then it is left out). */
export interface BatchItem {
  action: string;
  object: string;
  preview: ChangePreview | null;
  error: { code: string; message: string } | null;
}

/** What happened to one change of a batch; null for one 1C refused before (not applied). */
export type BatchItemResult =
  { ok: true; state: ObjectState } | { ok: false; code: string; message: string } | null;

/** An outgoing invoice as the card shows it before the draft is made in Didox (sums as "1234.50"). */
export interface DidoxDraftPreview {
  number: string;
  date: string;
  seller: { tin: string; name: string };
  buyer: { tin: string; name: string };
  contract: { number: string; date: string } | null;
  lines: {
    n: number;
    name: string;
    unit: string;
    qty: number;
    price: string;
    amount: string;
    vatRate: number;
    vat: string;
    total: string;
  }[];
  totals: { amount: string; vat: string; total: string };
}

/** Debit and credit of the company ("owner") and of the counterparty, as sums "1234.50". */
export interface DidoxBalanceView {
  ownerDebit: string;
  ownerCredit: string;
  partnerDebit: string;
  partnerCredit: string;
}

/** A reconciliation act as the card shows it before the draft is made in Didox. */
export interface DidoxReconciliationPreview {
  number: string;
  date: string;
  from: string;
  to: string;
  seller: { tin: string; name: string };
  buyer: { tin: string; name: string };
  /** The counterparty as the 1C act names it. */
  counterparty1c: string;
  contracts: {
    number: string;
    date: string;
    rows: {
      ownerDate: string;
      ownerName: string;
      ownerDebit: string;
      ownerCredit: string;
      partnerDate: string;
      partnerName: string;
      partnerDebit: string;
      partnerCredit: string;
    }[];
    open: DidoxBalanceView;
    total: DidoxBalanceView;
    close: DidoxBalanceView;
  }[];
  open: DidoxBalanceView;
  turnover: DidoxBalanceView;
  close: DidoxBalanceView;
  /** Things to look at before confirming (a counterparty's name that differs, an empty side). */
  warnings: string[];
}

/** A draft in Didox that is about to be deleted. */
export interface DidoxDraftDeletePreview {
  id: string;
  /** What Didox says about it; empty when it did not say. */
  number: string;
  date: string;
  recipient: string;
}

/** A free-form document (a letter, an act, ...) as the card shows it before the draft is made in Didox. */
export interface DidoxDocumentPreview {
  /** "letter", "work_act", ... */
  type: string;
  number: string;
  date: string;
  /** What the document is about, one line. */
  subject: string;
  /** The text that goes into the PDF (the start of it when it is long). */
  text: string;
  seller: { tin: string; name: string };
  buyer: { tin: string; name: string };
}

/** A document the assistant prepared; nothing is written to 1C until the user confirms it. */
export type Proposal =
  /** A reconciliation act built from the 1C document, to be made in Didox as a draft. */
  | { kind: "didox_reconciliation"; act: DidoxReconciliationPreview }
  /** A wrong draft to be deleted in Didox (it is not signed, so it was never sent). */
  | { kind: "didox_delete"; draft: DidoxDraftDeletePreview }
  /** A letter or another free-form document to be made in Didox as a draft (not signed, not sent). */
  | { kind: "didox_document"; document: DidoxDocumentPreview }
  /** An invoice to be made in Didox as a draft (not signed, not sent). */
  | { kind: "didox_draft"; draft: DidoxDraftPreview }
  | { kind: "change"; preview: ChangePreview }
  | { kind: "batch"; title: string; items: BatchItem[] }
  | { kind: "invoice_issued"; sale: SaleSummary }
  | { kind: "invoice_received"; invoice: InvoiceReceivedDraft }
  /** The marked objects, by type, to be removed for good; and who else has the base open. */
  | { kind: "delete_marked"; preview: DeleteMarkedPreview };

export type ProposalOutcome =
  | { status: "declined" }
  | { status: "created"; document: CreateInvoiceResult }
  | { status: "applied"; state: ObjectState }
  | { status: "batch"; results: BatchItemResult[] }
  | { status: "removed"; result: DeleteMarkedResult }
  | { status: "didox_draft"; id: string }
  | { status: "didox_deleted"; id: string }
  | { status: "failed"; code: string; message: string };

export interface ElapsedParts {
  /** Waiting for the AI service, all steps. */
  modelMs: number;
  /** Running tools in 1C (queries, checks of cards, writing), cards waiting for the user not counted. */
  onecMs: number;
  /** Model steps. */
  steps: number;
  /** The slowest tool calls, so a slow one can be named. */
  slowest: { tool: string; ms: number }[];
}

/** What the assistant is doing, pushed from the main process while it answers. */
export type AssistantEvent = { companyId: string } & (
  | { type: "text"; text: string }
  /** The model's short progress note between tool calls, as it is written. */
  | { type: "progress"; text: string }
  /** The connection dropped and the step is being tried again: take back what it had shown. */
  | { type: "retry"; attempt: number }
  | { type: "tool"; name: string; detail: string }
  /** Waits for assistant.decide(companyId, id, …). */
  | { type: "confirm"; id: string; proposal: Proposal }
  | { type: "decided"; id: string; outcome: ProposalOutcome }
  | { type: "done" }
  | { type: "error"; code: string; message: string }
  /** The audit's state, whole, each time a check starts, moves on or finishes. */
  | { type: "audit"; audit: AuditView }
  /** After a task (answered, failed or stopped): how long the assistant worked on it. */
  /** Where the time went, when the task was a conversation: the model, 1C, and the number of steps. */
  | { type: "elapsed"; ms: number; parts?: ElapsedParts }
  /** A heads-up that is not a failure, e.g. the AI budget is almost used (AI_BUDGET_WARNING). */
  | { type: "notice"; code: string; message: string }
  /** The next answer did not come from the model: from a query template, or from the answer cache. */
  | {
      type: "route";
      route: "template" | "cache";
      /** The question, so "Ask AI anyway" can send it again. */
      question: string;
      title?: string;
      ageSeconds?: number;
      /** A learned template's code (it can be rejected with "Ask AI anyway"). */
      learnedCode?: string;
    }
);

/** The app's own updates (electron-updater), pushed from the main process as they change. */
export type UpdateState =
  /** Development runs and non-Windows builds do not update themselves. */
  | { status: "unsupported" }
  | { status: "idle" }
  | { status: "checking" }
  | { status: "latest"; checkedAt: string }
  | { status: "downloading"; version: string; percent: number }
  /** Downloaded: installs on restart (or when the app quits). */
  | { status: "ready"; version: string }
  | { status: "error"; message: string };

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

/** Telegram remote control as the settings screen shows it. */
export interface RemoteStateView {
  /** This PC has been registered with the server. */
  paired: boolean;
  /** The channel to the server is open right now. */
  connected: boolean;
  /** The kill switch: off, nothing from the phone runs. */
  enabled: boolean;
  /** The most a phone may do on this PC: read, prepare proposals, or apply them (with the PIN). */
  ceiling: "read" | "prepare" | "apply";
  hasPin: boolean;
}

export interface RemoteLinkView {
  id: string;
  username: string | null;
  ceiling: "read" | "prepare" | "apply";
  created_at: string;
}

/** One command that came from a phone: who asked, what, how it ended. No content. */
export interface RemoteLogRow {
  at: string;
  id: string;
  type: string;
  class: "read" | "prepare" | "apply";
  companyInn: string;
  telegramUser: string;
  status: "done" | "failed" | "refused" | "expired";
  code?: string;
}

export interface PlatformBridge {
  app: { info(): Promise<AppInfo> };
  auth: {
    session(): Promise<Session | null>;
    signIn(input: SignInInput): Promise<Result<Session>>;
    register(input: RegisterAccountInput): Promise<Result<Session>>;
    refreshLicense(): Promise<Session | null>;
    signOut(): Promise<void>;
  };
  companies: {
    list(): Promise<CompanyView[]>;
    pickInfobaseFolder(): Promise<string | null>;
    testConnection(input: ConnectionInput): Promise<ConnectionTestResult>;
    add(input: AddCompanyInput): Promise<Result<CompanyView>>;
    checkStatus(id: string): Promise<CompanyView>;
    remove(id: string): Promise<void>;
    /** Loads this app's PlatformAPI extension into the company's 1C base (1C Designer, batch mode). */
    updateExtension(id: string): Promise<Result<CompanyView>>;
    /**
     * Loads the extension into a base that is not connected yet (the connect dialog found none), then
     * checks the base again; the result is a check like testConnection's.
     */
    installExtension(input: ConnectionInput): Promise<ConnectionTestResult>;
    /**
     * Registers 1C's COM connector (regsvr32 on comcntr.dll, Windows asks for administrator approval) when
     * 1C is installed without it; the dialog checks the base again afterwards.
     */
    registerComConnector(): Promise<Result<{ version: string; dll: string }>>;
  };
  billing: {
    /** The plan, its limits and what is used (the last answer of the server; null before the first one). */
    get(): Promise<BillingView | null>;
    /** Asks the server now. */
    refresh(): Promise<BillingView | null>;
    onChange(listener: (view: BillingView) => void): () => void;
  };
  didox: {
    /** The keys E-IMZO shows (it must be running on this PC). */
    keys(): Promise<Result<DidoxKeyView[]>>;
    /** Signs in to Didox with the key and reads what it answers, step by step; E-IMZO asks for the password. */
    test(input: DidoxTestInput): Promise<Result<DidoxTestResult>>;
    /** Keeps (or, with null, forgets) how this company reaches Didox, for the assistant. */
    save(companyId: string, settings: DidoxSettings | null): Promise<Result<CompanyView>>;
  };
  assistant: {
    /** Turns the assistant on or off for a company (on only after the user agreed). */
    enable(companyId: string, enabled: boolean): Promise<CompanyView>;
    /** Sends a question; the answer arrives through onEvent. Resolves when the answer is complete. */
    send(input: AssistantInput): Promise<Result<null>>;
    stop(companyId: string): Promise<void>;
    /** Stops the assistant and closes the open chat of a company (saved chats stay). */
    reset(companyId: string): Promise<void>;
    /** Saved chats of a company, newest first. */
    chats(companyId: string): Promise<ChatSummary[]>;
    /** Opens a saved chat: the next question continues it. */
    openChat(companyId: string, chatId: string): Promise<Result<ChatView>>;
    deleteChat(companyId: string, chatId: string): Promise<Result<null>>;
    /** Runs an audit of the company's base in a new chat; its progress comes as "audit" events. */
    audit(input: AuditInput): Promise<Result<null>>;
    /** Saves an audit's findings as a CSV file that Excel opens; false when the user cancelled. */
    exportAudit(companyId: string, chatId: string): Promise<Result<{ saved: boolean }>>;
    /** The user's answer to a "confirm" event: create the document in 1C, or not. */
    decide(companyId: string, proposalId: string, approve: boolean): Promise<void>;
    onEvent(listener: (event: AssistantEvent) => void): () => void;
  };
  reports: {
    /** Works out a report from the company's 1C with no model: the figures and the same in words. */
    run(input: ReportRunInput): Promise<Result<ReportView>>;
    /** Saves a table as a CSV file that Excel opens; false when the user cancelled. */
    exportCsv(defaultName: string, content: string): Promise<Result<{ saved: boolean }>>;
  };
  remote: {
    state(): Promise<RemoteStateView>;
    /** A one-time code (10 minutes) and the link that connects a phone. */
    connect(): Promise<Result<{ code: string; link: string; expires_at: string }>>;
    links(): Promise<Result<RemoteLinkView[]>>;
    revoke(linkId: string): Promise<Result<null>>;
    /** The kill switch. */
    enable(enabled: boolean): Promise<Result<RemoteStateView>>;
    /** Sets the PIN a phone must send to apply a proposal; null removes it. */
    setPin(pin: string | null): Promise<Result<RemoteStateView>>;
    setCeiling(ceiling: "read" | "prepare" | "apply"): Promise<Result<RemoteStateView>>;
    log(): Promise<RemoteLogRow[]>;
    onChange(listener: (state: RemoteStateView) => void): () => void;
  };
  update: {
    state(): Promise<UpdateState>;
    /** Looks for a newer version now; one found is downloaded in the background. */
    check(): Promise<UpdateState>;
    /** Restarts the app into the downloaded version. */
    install(): Promise<void>;
    onState(listener: (state: UpdateState) => void): () => void;
  };
}

export { CHANNELS } from "./channels.js";
