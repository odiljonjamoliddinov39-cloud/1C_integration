/**
 * The app updates itself (electron-updater, NSIS). Every desktop build gets a new version and is
 * published to https://<server>/download/ with latest.yml next to it (.github/workflows/desktop.yml).
 * The app looks there at start and every few hours, downloads a newer version in the background,
 * and installs it when the user restarts from the banner, or by itself when the app quits.
 */
import type { UpdateState } from "../shared/ipc.js";

/** How often a running app looks for a new version. */
const CHECK_HOURS = 4;

export type UpdaterEvent =
  | { type: "checking" }
  | { type: "available"; version: string }
  | { type: "none" }
  | { type: "progress"; percent: number }
  | { type: "downloaded"; version: string }
  | { type: "error"; message: string };

/** The part of electron-updater the app uses; a stand-in in tests. */
export interface Updater {
  /** Resolves once it is known whether there is a newer version; rejects if the check failed. */
  check(): Promise<void>;
  /** Quits and runs the downloaded installer silently, then starts the new version. */
  install(): void;
  onEvent(listener: (event: UpdaterEvent) => void): void;
}

export interface UpdateDeps {
  /** null where the app does not update itself (development, non-Windows). */
  updater: Updater | null;
  emit: (state: UpdateState) => void;
  now?: () => Date;
}

export class UpdateService {
  private state: UpdateState;
  private checking: Promise<UpdateState> | null = null;

  constructor(private readonly deps: UpdateDeps) {
    this.state = deps.updater ? { status: "idle" } : { status: "unsupported" };
    deps.updater?.onEvent((event) => this.apply(event));
  }

  current(): UpdateState {
    return this.state;
  }

  /** Checks now, then every few hours. */
  start(): void {
    if (!this.deps.updater) return;
    void this.check();
    setInterval(() => void this.check(), CHECK_HOURS * 3600 * 1000).unref();
  }

  check(): Promise<UpdateState> {
    const updater = this.deps.updater;
    // A version already found is downloading or waiting for the restart.
    if (!updater || this.state.status === "downloading" || this.state.status === "ready")
      return Promise.resolve(this.state);
    this.checking ??= updater
      .check()
      .catch((error: unknown) => this.apply({ type: "error", message: errorMessage(error) }))
      .then(() => this.state)
      .finally(() => {
        this.checking = null;
      });
    return this.checking;
  }

  install(): void {
    if (this.state.status === "ready") this.deps.updater?.install();
  }

  private apply(event: UpdaterEvent): void {
    const busy = this.state.status === "downloading" || this.state.status === "ready";
    switch (event.type) {
      case "checking":
        if (!busy) this.set({ status: "checking" });
        return;
      case "available":
        this.set({ status: "downloading", version: event.version, percent: 0 });
        return;
      case "none":
        this.set({ status: "latest", checkedAt: (this.deps.now?.() ?? new Date()).toISOString() });
        return;
      case "progress": {
        const percent = Math.floor(event.percent);
        // Progress comes many times a second; the window only needs whole percents.
        if (this.state.status === "downloading" && percent !== this.state.percent)
          this.set({ ...this.state, percent });
        return;
      }
      case "downloaded":
        this.set({ status: "ready", version: event.version });
        return;
      case "error":
        // A failed download is tried again on the next check.
        if (this.state.status !== "ready") this.set({ status: "error", message: event.message });
        return;
    }
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.deps.emit(state);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** electron-updater, reading https://<server>/download/latest.yml. Loaded only in installed builds. */
export async function loadElectronUpdater(feedUrl: string): Promise<Updater> {
  const { autoUpdater } = (await import("electron-updater")).default;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
  return {
    async check() {
      const result = await autoUpdater.checkForUpdates();
      // A failed download is reported through the "error" event.
      result?.downloadPromise?.catch(() => undefined);
    },
    install: () => autoUpdater.quitAndInstall(true, true),
    onEvent(listener) {
      autoUpdater.on("checking-for-update", () => listener({ type: "checking" }));
      autoUpdater.on("update-available", (info) => listener({ type: "available", version: info.version }));
      autoUpdater.on("update-not-available", () => listener({ type: "none" }));
      autoUpdater.on("download-progress", (progress) =>
        listener({ type: "progress", percent: progress.percent }),
      );
      autoUpdater.on("update-downloaded", (info) => listener({ type: "downloaded", version: info.version }));
      autoUpdater.on("error", (error) => listener({ type: "error", message: errorMessage(error) }));
    },
  };
}
