/**
 * The typed bridge between the renderer (React UI) and the main process (TD §4: contextBridge,
 * no nodeIntegration). The renderer only sees `window.platform`; everything that touches 1C,
 * files or secrets runs in the main process.
 */
import type { Organization, PingResult } from "@platform/shared";
import { z } from "zod";

export const InfobaseInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), file: z.string().min(1) }),
  z.object({ kind: z.literal("server"), server: z.string().min(1), ref: z.string().min(1) }),
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

export const SignInInput = z.object({ email: z.email(), password: z.string().min(1) });
export type SignInInput = z.infer<typeof SignInInput>;

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

export interface Session {
  email: string;
  signedInAt: string;
}

export interface AppInfo {
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
