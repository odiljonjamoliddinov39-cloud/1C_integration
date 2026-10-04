/**
 * The typed bridge between the renderer (React UI) and the main process (TD §4: contextBridge,
 * no nodeIntegration). The renderer only sees `window.platform`; everything that touches 1C,
 * files or secrets runs in the main process.
 */
import type { Organization, PingResult } from "@platform/shared";
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
}

export { CHANNELS } from "./channels.js";
