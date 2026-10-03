import { contextBridge, ipcRenderer } from "electron";

import { CHANNELS } from "../shared/channels.js";
import type { PlatformBridge } from "../shared/ipc.js";

const bridge: PlatformBridge = {
  app: { info: () => ipcRenderer.invoke(CHANNELS.appInfo) },
  auth: {
    session: () => ipcRenderer.invoke(CHANNELS.session),
    signIn: (input) => ipcRenderer.invoke(CHANNELS.signIn, input),
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
};

contextBridge.exposeInMainWorld("platform", bridge);
