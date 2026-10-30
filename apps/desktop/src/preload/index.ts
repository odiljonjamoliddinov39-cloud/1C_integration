import { contextBridge, ipcRenderer } from "electron";

import { CHANNELS } from "../shared/channels.js";
import type {
  AssistantEvent,
  BillingView,
  PlatformBridge,
  RemoteStateView,
  UpdateState,
} from "../shared/ipc.js";

const bridge: PlatformBridge = {
  app: { info: () => ipcRenderer.invoke(CHANNELS.appInfo) },
  auth: {
    session: () => ipcRenderer.invoke(CHANNELS.session),
    signIn: (input) => ipcRenderer.invoke(CHANNELS.signIn, input),
    register: (input) => ipcRenderer.invoke(CHANNELS.register, input),
    refreshLicense: () => ipcRenderer.invoke(CHANNELS.refreshLicense),
    signOut: () => ipcRenderer.invoke(CHANNELS.signOut),
  },
  companies: {
    list: () => ipcRenderer.invoke(CHANNELS.listCompanies),
    pickInfobaseFolder: () => ipcRenderer.invoke(CHANNELS.pickFolder),
    listInfobases: () => ipcRenderer.invoke(CHANNELS.listInfobases),
    testConnection: (input) => ipcRenderer.invoke(CHANNELS.testConnection, input),
    add: (input) => ipcRenderer.invoke(CHANNELS.addCompany, input),
    checkStatus: (id) => ipcRenderer.invoke(CHANNELS.checkStatus, id),
    remove: (id) => ipcRenderer.invoke(CHANNELS.removeCompany, id),
    updateExtension: (id) => ipcRenderer.invoke(CHANNELS.updateExtension, id),
    installExtension: (input) => ipcRenderer.invoke(CHANNELS.installExtension, input),
    registerComConnector: () => ipcRenderer.invoke(CHANNELS.registerCom),
  },
  reports: {
    run: (input) => ipcRenderer.invoke(CHANNELS.reportsRun, input),
    exportCsv: (defaultName, content) => ipcRenderer.invoke(CHANNELS.reportsExport, defaultName, content),
  },
  billing: {
    get: () => ipcRenderer.invoke(CHANNELS.billingGet),
    refresh: () => ipcRenderer.invoke(CHANNELS.billingRefresh),
    onChange: (listener) => {
      const handler = (_e: unknown, view: BillingView) => listener(view);
      ipcRenderer.on(CHANNELS.billingChanged, handler);
      return () => ipcRenderer.removeListener(CHANNELS.billingChanged, handler);
    },
  },
  didox: {
    keys: () => ipcRenderer.invoke(CHANNELS.didoxKeys),
    test: (input) => ipcRenderer.invoke(CHANNELS.didoxTest, input),
    save: (companyId, settings) => ipcRenderer.invoke(CHANNELS.didoxSave, companyId, settings),
  },
  assistant: {
    enable: (companyId, enabled) => ipcRenderer.invoke(CHANNELS.assistantEnable, companyId, enabled),
    send: (input) => ipcRenderer.invoke(CHANNELS.assistantSend, input),
    stop: (companyId) => ipcRenderer.invoke(CHANNELS.assistantStop, companyId),
    reset: (companyId) => ipcRenderer.invoke(CHANNELS.assistantReset, companyId),
    decide: (companyId, proposalId, approve) =>
      ipcRenderer.invoke(CHANNELS.assistantDecide, companyId, proposalId, approve),
    chats: (companyId) => ipcRenderer.invoke(CHANNELS.assistantChats, companyId),
    openChat: (companyId, chatId) => ipcRenderer.invoke(CHANNELS.assistantOpenChat, companyId, chatId),
    deleteChat: (companyId, chatId) => ipcRenderer.invoke(CHANNELS.assistantDeleteChat, companyId, chatId),
    audit: (input) => ipcRenderer.invoke(CHANNELS.assistantAudit, input),
    exportAudit: (companyId, chatId) => ipcRenderer.invoke(CHANNELS.assistantExportAudit, companyId, chatId),
    onEvent: (listener) => {
      const handler = (_e: unknown, event: AssistantEvent) => listener(event);
      ipcRenderer.on(CHANNELS.assistantEvent, handler);
      return () => ipcRenderer.removeListener(CHANNELS.assistantEvent, handler);
    },
  },
  remote: {
    state: () => ipcRenderer.invoke(CHANNELS.remoteState),
    connect: () => ipcRenderer.invoke(CHANNELS.remoteConnect),
    links: () => ipcRenderer.invoke(CHANNELS.remoteLinks),
    revoke: (linkId) => ipcRenderer.invoke(CHANNELS.remoteRevoke, linkId),
    enable: (enabled) => ipcRenderer.invoke(CHANNELS.remoteEnable, enabled),
    setPin: (pin) => ipcRenderer.invoke(CHANNELS.remotePin, pin),
    setCeiling: (ceiling) => ipcRenderer.invoke(CHANNELS.remoteCeiling, ceiling),
    log: () => ipcRenderer.invoke(CHANNELS.remoteLog),
    onChange: (listener) => {
      const handler = (_e: unknown, state: RemoteStateView) => listener(state);
      ipcRenderer.on(CHANNELS.remoteChanged, handler);
      return () => ipcRenderer.removeListener(CHANNELS.remoteChanged, handler);
    },
  },
  update: {
    state: () => ipcRenderer.invoke(CHANNELS.updateState),
    check: () => ipcRenderer.invoke(CHANNELS.updateCheck),
    install: () => ipcRenderer.invoke(CHANNELS.updateInstall),
    onState: (listener) => {
      const handler = (_e: unknown, state: UpdateState) => listener(state);
      ipcRenderer.on(CHANNELS.updateChanged, handler);
      return () => ipcRenderer.removeListener(CHANNELS.updateChanged, handler);
    },
  },
};

contextBridge.exposeInMainWorld("platform", bridge);
