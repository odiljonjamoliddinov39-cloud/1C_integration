/**
 * The typed bridge between the renderer (React UI) and the main process (TD §4: contextBridge,
 * no nodeIntegration). The renderer only sees `window.platform`; everything that touches 1C,
 * files or secrets runs in the main process.
 */
import type {
  CreateInvoiceResult,
  InvoiceReceivedDraft,
  Organization,
  PingResult,
  SaleSummary,
} from "@platform/shared";
import { z } from "zod";

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

export interface AppInfo {
  /** Control system address baked into this build (editable on the sign-in screen). */
  defaultServerUrl: string;
  version: string;
  platform: string;
  arch: string;
  demo1C: boolean;
}

export const AssistantInput = z.object({
  companyId: z.string().min(1),
  text: z.string().trim().min(1).max(4000),
});
export type AssistantInput = z.infer<typeof AssistantInput>;

/** A document the assistant prepared; nothing is written to 1C until the user confirms it. */
export type Proposal =
  { kind: "invoice_issued"; sale: SaleSummary } | { kind: "invoice_received"; invoice: InvoiceReceivedDraft };

export type ProposalOutcome =
  | { status: "declined" }
  | { status: "created"; document: CreateInvoiceResult }
  | { status: "failed"; code: string; message: string };

/** What the assistant is doing, pushed from the main process while it answers. */
export type AssistantEvent = { companyId: string } & (
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail: string }
  /** Waits for assistant.decide(companyId, id, …). */
  | { type: "confirm"; id: string; proposal: Proposal }
  | { type: "decided"; id: string; outcome: ProposalOutcome }
  | { type: "done" }
  | { type: "error"; code: string; message: string }
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
  };
  assistant: {
    /** Turns the assistant on or off for a company (on only after the user agreed). */
    enable(companyId: string, enabled: boolean): Promise<CompanyView>;
    /** Sends a question; the answer arrives through onEvent. Resolves when the answer is complete. */
    send(input: AssistantInput): Promise<Result<null>>;
    stop(companyId: string): Promise<void>;
    /** Forgets the conversation of a company. */
    reset(companyId: string): Promise<void>;
    /** The user's answer to a "confirm" event: create the document in 1C, or not. */
    decide(companyId: string, proposalId: string, approve: boolean): Promise<void>;
    onEvent(listener: (event: AssistantEvent) => void): () => void;
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
