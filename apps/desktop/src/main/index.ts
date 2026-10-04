import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LICENSE_CHECK_HOURS } from "@platform/shared";
import { BrowserWindow, app, dialog, ipcMain, safeStorage, shell } from "electron";

import onecWorkerPath from "./onec-worker?modulePath";
import { CHANNELS } from "../shared/ipc.js";
import { WorkerConnector } from "./connector.js";
import { createHandlers } from "./handlers.js";
import { machineIdHash, newFallbackId } from "./machine-id.js";
import { SessionService } from "./session.js";
import { LocalStore, type SecretBox, StoreError } from "./store.js";

const here = dirname(fileURLToPath(import.meta.url));

// Set at build time (PLATFORM_API_URL, PLATFORM_LICENSE_PUBLIC_KEY); see electron.vite.config.ts.
const defaultServerUrl = process.env.PLATFORM_API_URL || __DEFAULT_SERVER_URL__;
const bakedPublicKey = __LICENSE_PUBLIC_KEY__;

// PLATFORM_DEMO_1C=1 replaces 1C with an in-memory base, to try the app without Windows or 1C.
const demo1C = process.env.PLATFORM_DEMO_1C === "1";

// 1C passwords: Windows DPAPI through safeStorage. Demo mode (fake 1C, fake passwords) may run where
// no OS keyring exists, and then keeps them unencrypted, marked as such.
const INSECURE = "insecure:";
const secrets: SecretBox = {
  encrypt(plain) {
    if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(plain).toString("base64");
    if (demo1C) return INSECURE + plain;
    throw new StoreError("SECURE_STORAGE", "Secure storage for passwords is not available on this system");
  },
  decrypt(encrypted) {
    if (encrypted.startsWith(INSECURE)) return encrypted.slice(INSECURE.length);
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  },
};

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "1C Platform",
    webPreferences: {
      preload: join(here, "../preload/index.cjs"), // sandboxed preloads must be CommonJS
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.on("ready-to-show", () => window.show());
  // Links open in the browser; the app window never navigates away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(here, "../renderer/index.html"));
  return window;
}

void app.whenReady().then(() => {
  const store = new LocalStore(join(app.getPath("userData"), "platform.json"), secrets);
  const connector = new WorkerConnector(onecWorkerPath, demo1C);
  let machineId: Promise<string> | undefined;
  const session = new SessionService({
    store,
    machineId: () => (machineId ??= machineIdHash(() => store.machineIdFallback(newFallbackId))),
    deviceName: hostname(),
    bakedPublicKey,
  });
  const handlers = createHandlers({
    store,
    session,
    connector,
    info: {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      demo1C,
      defaultServerUrl,
    },
    pickFolder: async () => {
      const result = await dialog.showOpenDialog({
        title: "1C infobase folder",
        properties: ["openDirectory"],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  });

  ipcMain.handle(CHANNELS.appInfo, () => handlers.appInfo());
  ipcMain.handle(CHANNELS.session, () => handlers.session());
  ipcMain.handle(CHANNELS.signIn, (_e, input: unknown) => handlers.signIn(input));
  ipcMain.handle(CHANNELS.register, (_e, input: unknown) => handlers.register(input));
  ipcMain.handle(CHANNELS.refreshLicense, () => handlers.refreshLicense());
  ipcMain.handle(CHANNELS.signOut, () => handlers.signOut());
  ipcMain.handle(CHANNELS.listCompanies, () => handlers.listCompanies());
  ipcMain.handle(CHANNELS.pickFolder, () => handlers.pickFolder());
  ipcMain.handle(CHANNELS.testConnection, (_e, input: unknown) => handlers.testConnection(input));
  ipcMain.handle(CHANNELS.addCompany, (_e, input: unknown) => handlers.addCompany(input));
  ipcMain.handle(CHANNELS.checkStatus, (_e, id: unknown) => handlers.checkStatus(id));
  ipcMain.handle(CHANNELS.removeCompany, (_e, id: unknown) => handlers.removeCompany(id));

  // License check at start and every 6 hours (TD §4).
  void session.refreshLicense();
  setInterval(() => void session.refreshLicense(), LICENSE_CHECK_HOURS * 3600 * 1000);

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on("before-quit", () => void connector.dispose());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
