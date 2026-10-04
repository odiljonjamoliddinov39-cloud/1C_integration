import { contextBridge, ipcRenderer } from "electron";

import { CHANNELS } from "../shared/channels.js";
import type { AssistantEvent, PlatformBridge, UpdateState } from "../shared/ipc.js";

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
    testConnection: (input) => ipcRenderer.invoke(CHANNELS.testConnection, input),
    add: (input) => ipcRenderer.invoke(CHANNELS.addCompany, input),
    checkStatus: (id) => ipcRenderer.invoke(CHANNELS.checkStatus, id),
    remove: (id) => ipcRenderer.invoke(CHANNELS.removeCompany, id),
  },
  assistant: {
    enable: (companyId, enabled) => ipcRenderer.invoke(CHANNELS.assistantEnable, companyId, enabled),
    send: (input) => ipcRenderer.invoke(CHANNELS.assistantSend, input),
    stop: (companyId) => ipcRenderer.invoke(CHANNELS.assistantStop, companyId),
    reset: (companyId) => ipcRenderer.invoke(CHANNELS.assistantReset, companyId),
    onEvent: (listener) => {
      const handler = (_e: unknown, event: AssistantEvent) => listener(event);
      ipcRenderer.on(CHANNELS.assistantEvent, handler);
      return () => ipcRenderer.removeListener(CHANNELS.assistantEvent, handler);
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
