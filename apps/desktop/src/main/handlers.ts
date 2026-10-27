/**
 * Everything the UI can ask the main process to do. Inputs from the renderer are validated here:
 * the renderer is treated as untrusted.
 */
import { isOlderExtension } from "@platform/shared";
import { z } from "zod";

import {
  AddCompanyInput,
  AssistantInput,
  AuditInput,
  type AppInfo,
  type BillingView,
  type DidoxKeyView,
  DidoxSettings,
  DidoxTestInput,
  type DidoxTestResult,
  type ChatSummary,
  type ChatView,
  type CompanyView,
  ConnectionInput,
  type ConnectionTestResult,
  RegisterAccountInput,
  ReportRunInput,
  type ReportView,
  type RemoteLinkView,
  type RemoteLogRow,
  type RemoteStateView,
  type Result,
  type Session,
  SignInInput,
} from "../shared/ipc.js";
import type { AssistantService } from "./assistant.js";
import type { BillingState } from "./billing.js";
import { EImzoClient, EImzoError } from "./didox/eimzo.js";
import { listKeys, runDidoxTest } from "./didox/test-run.js";
import type { ConnectorRunner } from "./connector.js";
import type { RemoteService } from "./remote/service.js";
import type { SessionService } from "./session.js";
import { type LocalStore, StoreError } from "./store.js";

export interface HandlerDeps {
  store: LocalStore;
  session: SessionService;
  connector: ConnectorRunner;
  assistant: AssistantService;
  billing: BillingState;
  info: AppInfo;
  pickFolder: () => Promise<string | null>;
  /** Asks where to save a file and writes it there; false when the user cancelled. */
  saveFile: (defaultName: string, content: string) => Promise<boolean>;
  /** Loads the app's PlatformAPI extension into a base (1C Designer, batch mode). */
  installExtension: (connection: ConnectionInput) => Promise<Result<unknown>>;
  /** Registers 1C's COM connector for this app (regsvr32, administrator approval asked by Windows). */
  registerComConnector: () => Promise<Result<{ version: string; dll: string }>>;
  /** E-IMZO and the network for the Didox test; the real ones unless a test hands in fakes. */
  didox?: { eimzo?: EImzoClient; fetch?: typeof fetch };
  /** Telegram remote control; absent in tests that do not cover it. */
  remote?: RemoteService;
}

/** Chats are files named by these ids: anything but a UUID is refused before it reaches the disk. */
const chatIds = z.object({ companyId: z.uuid(), chatId: z.uuid() });

function invalid(error: { issues: { message: string }[] }): Result<never> {
  return { ok: false, code: "VALIDATION", message: error.issues.map((i) => i.message).join("; ") };
}

export function createHandlers({
  store,
  session,
  connector,
  assistant,
  billing,
  info,
  pickFolder,
  saveFile,
  installExtension,
  registerComConnector,
  didox,
  remote,
}: HandlerDeps) {
  const noRemote = { ok: false, code: "UNAVAILABLE", message: "Remote control is not available" } as const;
  return {
    appInfo: async (): Promise<AppInfo> => info,

    session: async (): Promise<Session | null> => session.view(),

    signIn: async (raw: unknown): Promise<Result<Session>> => {
      const input = SignInInput.safeParse(raw);
      if (!input.success) return invalid(input.error);
      const result = await session.signIn(input.data);
      if (result.ok) void billing.refresh();
      return result;
    },

    register: async (raw: unknown): Promise<Result<Session>> => {
      const input = RegisterAccountInput.safeParse(raw);
      if (!input.success) return invalid(input.error);
      const result = await session.register(input.data);
      if (result.ok) void billing.refresh();
      return result;
    },

    refreshLicense: async (): Promise<Session | null> => {
      const view = await session.refreshLicense();
      void billing.refresh();
      return view;
    },

    billing: async (): Promise<BillingView | null> => billing.current(),

    billingRefresh: async (): Promise<BillingView | null> => billing.refresh(),

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
      // The plan decides how many companies: the server refuses one over the limit.
      const allowed = await billing.registerCompany({ inn: org.inn, name: org.name });
      if (!allowed.ok) return allowed;
      try {
        const added = store.addCompany({ ...input.data, organization: org }, check.status);
        void billing.refresh();
        return { ok: true, data: added };
      } catch (e) {
        if (e instanceof StoreError) return { ok: false, code: e.code, message: e.message };
        throw e;
      }
    },

    checkStatus: async (id: unknown): Promise<CompanyView> => {
      const check = await connector.check(store.connection(String(id)));
      return store.setStatus(String(id), check.status);
    },

    /**
     * Updates the company's 1C base to the PlatformAPI extension this app ships, then checks it again.
     * The app's own connection is closed first, so 1C is not held open by us while it updates.
     */
    updateExtension: async (id: unknown): Promise<Result<CompanyView>> => {
      const companyId = String(id);
      const connection = store.connection(companyId);
      await connector.release(connection);
      const installed = await installExtension(connection);
      const check = await connector.check(connection);
      const company = store.setStatus(companyId, check.status);
      if (!installed.ok) return installed;
      if (!check.status.ok) return { ok: false, code: check.status.code, message: check.status.message };
      if (isOlderExtension(check.status.ping.extensionVersion)) {
        return {
          ok: false,
          code: "EXTENSION_NOT_UPDATED",
          message: `1C still reports PlatformAPI ${check.status.ping.extensionVersion} after the update`,
        };
      }
      return { ok: true, data: company };
    },

    /**
     * Puts the app's PlatformAPI extension into a base the user is still connecting (the check found
     * none), then checks it again. A failed install comes back as a failed check, shown in the dialog.
     */
    installExtensionInto: async (raw: unknown): Promise<ConnectionTestResult> => {
      const input = ConnectionInput.safeParse(raw);
      const failed = (code: string, message: string): ConnectionTestResult => ({
        status: { ok: false, checkedAt: new Date().toISOString(), code, message },
        organizations: [],
      });
      if (!input.success) return failed("VALIDATION", input.error.issues.map((i) => i.message).join("; "));
      await connector.release(input.data);
      const installed = await installExtension(input.data);
      if (!installed.ok) return failed(installed.code, installed.message);
      return connector.check(input.data);
    },

    /** Registers 1C's COM connector; Windows asks the user to approve it. */
    registerComConnector: async (): Promise<Result<{ version: string; dll: string }>> =>
      registerComConnector(),

    didoxKeys: async (): Promise<Result<DidoxKeyView[]>> => {
      try {
        return { ok: true, data: await listKeys(didox?.eimzo ?? new EImzoClient()) };
      } catch (e) {
        if (e instanceof EImzoError) return { ok: false, code: e.code, message: e.message };
        throw e;
      }
    },

    didoxTest: async (raw: unknown): Promise<Result<DidoxTestResult>> => {
      const input = DidoxTestInput.safeParse(raw ?? {});
      if (!input.success) return invalid(input.error);
      const baseUrl = input.data.baseUrl;
      if (baseUrl && !/^https:\/\//i.test(baseUrl)) {
        return { ok: false, code: "VALIDATION", message: "Didox's address must start with https://" };
      }
      return {
        ok: true,
        data: await runDidoxTest(input.data, {
          eimzo: didox?.eimzo ?? new EImzoClient(),
          ...(didox?.fetch ? { fetch: didox.fetch } : {}),
        }),
      };
    },

    didoxSave: async (id: unknown, raw: unknown): Promise<Result<CompanyView>> => {
      if (raw === null) return { ok: true, data: store.setDidox(String(id), null) };
      const settings = DidoxSettings.safeParse(raw);
      if (!settings.success) return invalid(settings.error);
      if (!/^https:\/\//i.test(settings.data.baseUrl)) {
        return { ok: false, code: "VALIDATION", message: "Didox's address must start with https://" };
      }
      return { ok: true, data: store.setDidox(String(id), settings.data) };
    },

    removeCompany: async (id: unknown): Promise<void> => {
      assistant.removeCompany(String(id));
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

    assistantAudit: async (raw: unknown): Promise<Result<null>> => {
      const input = AuditInput.safeParse(raw);
      return input.success ? assistant.audit(input.data) : invalid(input.error);
    },

    assistantExportAudit: async (id: unknown, chatId: unknown): Promise<Result<{ saved: boolean }>> => {
      const ids = chatIds.safeParse({ companyId: id, chatId });
      if (!ids.success) return invalid(ids.error);
      const file = assistant.auditCsv(ids.data.companyId, ids.data.chatId);
      if (!file.ok) return file;
      return { ok: true, data: { saved: await saveFile(file.data.name, file.data.csv) } };
    },

    /** A report worked out from the company's 1C, with no model: the figures and the same in words. */
    reportsRun: async (raw: unknown): Promise<Result<ReportView>> => {
      const input = ReportRunInput.safeParse(raw);
      return input.success ? assistant.report(input.data) : invalid(input.error);
    },

    reportsExport: async (name: unknown, content: unknown): Promise<Result<{ saved: boolean }>> => {
      if (typeof name !== "string" || typeof content !== "string" || !/^[\w .-]{1,80}\.csv$/.test(name))
        return { ok: false, code: "VALIDATION", message: "A CSV file name and its content are needed" };
      return { ok: true, data: { saved: await saveFile(name, content) } };
    },

    assistantReset: async (id: unknown): Promise<void> => assistant.reset(String(id)),
    assistantDecide: async (id: unknown, proposalId: unknown, approve: unknown): Promise<void> =>
      assistant.decide(String(id), String(proposalId), approve === true),

    remoteState: async (): Promise<RemoteStateView> =>
      remote?.view() ?? { paired: false, connected: false, enabled: false, ceiling: "apply", hasPin: false },
    remoteConnect: async (): Promise<Result<{ code: string; link: string; expires_at: string }>> =>
      remote ? remote.connectTelegram() : noRemote,
    remoteLinks: async (): Promise<Result<RemoteLinkView[]>> => (remote ? remote.links() : noRemote),
    remoteRevoke: async (id: unknown): Promise<Result<null>> =>
      remote && z.uuid().safeParse(id).success
        ? remote.revokeLink(String(id))
        : { ok: false, code: "VALIDATION", message: "Which connection?" },
    remoteEnable: async (enabled: unknown): Promise<Result<RemoteStateView>> =>
      remote ? remote.setEnabled(enabled === true) : noRemote,
    remotePin: async (pin: unknown): Promise<Result<RemoteStateView>> =>
      !remote
        ? noRemote
        : pin === null || typeof pin === "string"
          ? remote.setPin(pin)
          : { ok: false, code: "VALIDATION", message: "A PIN is 4 to 12 digits" },
    remoteCeiling: async (ceiling: unknown): Promise<Result<RemoteStateView>> => {
      const parsed = z.enum(["read", "prepare", "apply"]).safeParse(ceiling);
      if (!remote) return noRemote;
      return parsed.success
        ? remote.setCeiling(parsed.data)
        : { ok: false, code: "VALIDATION", message: "Read, prepare or apply" };
    },
    remoteLog: async (): Promise<RemoteLogRow[]> => remote?.log() ?? [],

    assistantChats: async (id: unknown): Promise<ChatSummary[]> =>
      z.uuid().safeParse(id).success ? assistant.chats(String(id)) : [],

    assistantOpenChat: async (id: unknown, chatId: unknown): Promise<Result<ChatView>> => {
      const ids = chatIds.safeParse({ companyId: id, chatId });
      return ids.success ? assistant.openChat(ids.data.companyId, ids.data.chatId) : invalid(ids.error);
    },

    assistantDeleteChat: async (id: unknown, chatId: unknown): Promise<Result<null>> => {
      const ids = chatIds.safeParse({ companyId: id, chatId });
      return ids.success ? assistant.deleteChat(ids.data.companyId, ids.data.chatId) : invalid(ids.error);
    },
  };
}

export type Handlers = ReturnType<typeof createHandlers>;
