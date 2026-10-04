/**
 * Everything the UI can ask the main process to do. Inputs from the renderer are validated here:
 * the renderer is treated as untrusted.
 */
import {
  AddCompanyInput,
  AssistantInput,
  type AppInfo,
  type CompanyView,
  ConnectionInput,
  type ConnectionTestResult,
  RegisterAccountInput,
  type Result,
  type Session,
  SignInInput,
} from "../shared/ipc.js";
import type { AssistantService } from "./assistant.js";
import type { ConnectorRunner } from "./connector.js";
import type { SessionService } from "./session.js";
import { type LocalStore, StoreError } from "./store.js";

export interface HandlerDeps {
  store: LocalStore;
  session: SessionService;
  connector: ConnectorRunner;
  assistant: AssistantService;
  info: AppInfo;
  pickFolder: () => Promise<string | null>;
}

function invalid(error: { issues: { message: string }[] }): Result<never> {
  return { ok: false, code: "VALIDATION", message: error.issues.map((i) => i.message).join("; ") };
}

export function createHandlers({ store, session, connector, assistant, info, pickFolder }: HandlerDeps) {
  return {
    appInfo: async (): Promise<AppInfo> => info,

    session: async (): Promise<Session | null> => session.view(),

    signIn: async (raw: unknown): Promise<Result<Session>> => {
      const input = SignInInput.safeParse(raw);
      return input.success ? session.signIn(input.data) : invalid(input.error);
    },

    register: async (raw: unknown): Promise<Result<Session>> => {
      const input = RegisterAccountInput.safeParse(raw);
      return input.success ? session.register(input.data) : invalid(input.error);
    },

    refreshLicense: async (): Promise<Session | null> => session.refreshLicense(),

    signOut: async (): Promise<void> => session.signOut(),

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

    removeCompany: async (id: unknown): Promise<void> => {
      assistant.reset(String(id));
      store.removeCompany(String(id));
    },

    assistantEnable: async (id: unknown, enabled: unknown): Promise<CompanyView> => {
      if (enabled !== true) assistant.reset(String(id));
      return store.setAiEnabled(String(id), enabled === true);
    },

    assistantSend: async (raw: unknown): Promise<Result<null>> => {
      const input = AssistantInput.safeParse(raw);
      return input.success ? assistant.send(input.data) : invalid(input.error);
    },

    assistantStop: async (id: unknown): Promise<void> => assistant.stop(String(id)),

    assistantReset: async (id: unknown): Promise<void> => assistant.reset(String(id)),
  };
}

export type Handlers = ReturnType<typeof createHandlers>;
