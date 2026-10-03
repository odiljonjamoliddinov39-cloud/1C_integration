/**
 * Everything the UI can ask the main process to do. Inputs from the renderer are validated here:
 * the renderer is treated as untrusted.
 */
import {
  AddCompanyInput,
  type AppInfo,
  type CompanyView,
  ConnectionInput,
  type ConnectionTestResult,
  type Result,
  type Session,
  SignInInput,
} from "../shared/ipc.js";
import type { ConnectorRunner } from "./connector.js";
import { type LocalStore, StoreError } from "./store.js";

export interface HandlerDeps {
  store: LocalStore;
  connector: ConnectorRunner;
  info: AppInfo;
  pickFolder: () => Promise<string | null>;
}

function invalid(error: { issues: { message: string }[] }): Result<never> {
  return { ok: false, code: "VALIDATION", message: error.issues.map((i) => i.message).join("; ") };
}

export function createHandlers({ store, connector, info, pickFolder }: HandlerDeps) {
  return {
    appInfo: async (): Promise<AppInfo> => info,

    session: async (): Promise<Session | null> => store.session,

    // Stub: phase 1 signs in against the control system and activates the license on this PC.
    signIn: async (raw: unknown): Promise<Result<Session>> => {
      const input = SignInInput.safeParse(raw);
      if (!input.success) return invalid(input.error);
      const session = { email: input.data.email.toLowerCase(), signedInAt: new Date().toISOString() };
      store.setSession(session);
      return { ok: true, data: session };
    },

    signOut: async (): Promise<void> => store.setSession(null),

    listCompanies: async (): Promise<CompanyView[]> => store.listCompanies(),

    pickFolder: async (): Promise<string | null> => pickFolder(),

    testConnection: async (raw: unknown): Promise<ConnectionTestResult> => {
      const input = ConnectionInput.safeParse(raw);
      if (!input.success) {
        const message = input.error.issues.map((i) => i.message).join("; ");
        return {
          status: { ok: false, checkedAt: new Date().toISOString(), code: "VALIDATION", message },
          organizations: [],
        };
      }
      return connector.check(input.data);
    },

    /** Connects a company only after a fresh successful check of that infobase and organization. */
    addCompany: async (raw: unknown): Promise<Result<CompanyView>> => {
      const input = AddCompanyInput.safeParse(raw);
      if (!input.success) return invalid(input.error);
      const check = await connector.check(input.data);
      if (!check.status.ok) return { ok: false, code: check.status.code, message: check.status.message };
      const org = check.organizations.find((o) => o.ref === input.data.organization.ref);
      if (!org)
        return {
          ok: false,
          code: "ORGANIZATION_NOT_FOUND",
          message: "This organization is not in the infobase",
        };
      try {
        return { ok: true, data: store.addCompany({ ...input.data, organization: org }, check.status) };
      } catch (e) {
        if (e instanceof StoreError) return { ok: false, code: e.code, message: e.message };
        throw e;
      }
    },

    checkStatus: async (id: unknown): Promise<CompanyView> => {
      const check = await connector.check(store.connection(String(id)));
      return store.setStatus(String(id), check.status);
    },

    removeCompany: async (id: unknown): Promise<void> => store.removeCompany(String(id)),
  };
}

export type Handlers = ReturnType<typeof createHandlers>;
