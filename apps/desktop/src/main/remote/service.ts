/**
 * The desktop's side of Telegram remote control as one service: registers this PC with the server, makes
 * the pairing code, keeps the connection (client.ts) up while the user is signed in and the switch is on,
 * and tells the phone, with counts only, when something waits for it (notify).
 */
import { createHash } from "node:crypto";

import { PairingResult, RegisterDeviceResult, LinkView, type RemoteCeiling } from "@platform/shared";
import { z } from "zod";

import type { AssistantEvent, RemoteLinkView, RemoteStateView, Result } from "../../shared/ipc.js";
import { ControlError } from "../control-client.js";
import { RemoteClient, type WsFactory } from "./client.js";
import {
  RemoteCommands,
  type CommandDeps,
  type RemoteAssistant,
  type RemoteCompanyInfo,
} from "./commands.js";
import type { RemoteState } from "./state.js";

export interface RemoteServiceDeps {
  state: RemoteState;
  assistant: RemoteAssistant;
  companies: () => RemoteCompanyInfo[];
  /** The account's signed-in access (for registering the PC) and the server address. */
  authorized: () => Promise<{ accessToken: string; serverUrl: string }>;
  deviceName: string;
  appVersion: string;
  onecReachable: CommandDeps["onecReachable"];
  licenseReadOnly: CommandDeps["licenseReadOnly"];
  companyReadOnly: CommandDeps["companyReadOnly"];
  journal: CommandDeps["journal"];
  renderPdf?: CommandDeps["renderPdf"];
  /** The license's end date when the app is signed in (for the "license is near its end" ping). */
  licenseEnds?: () => Promise<string | null>;
  fetch?: typeof fetch;
  ws?: WsFactory;
  onChange?: (view: RemoteStateView) => void;
  backoffMs?: readonly number[];
  settleMs?: number;
}

const fail = (code: string, message: string): { ok: false; code: string; message: string } => ({
  ok: false,
  code,
  message,
});

/** A card waiting is told to the phone at most this often per company. */
const NOTIFY_EVERY_MS = 60_000;

export class RemoteService {
  private readonly client: RemoteClient;
  private readonly http: typeof fetch;
  private readonly lastWaiting = new Map<string, number>();
  private stopObserving: (() => void) | null = null;
  private licenseTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: RemoteServiceDeps) {
    this.http = deps.fetch ?? fetch;
    const commands = new RemoteCommands({
      state: deps.state,
      assistant: deps.assistant,
      companies: deps.companies,
      onecReachable: deps.onecReachable,
      licenseReadOnly: deps.licenseReadOnly,
      companyReadOnly: deps.companyReadOnly,
      appVersion: deps.appVersion,
      files: {
        download: (id) => this.download(id),
        upload: (commandId, name, data) => this.upload(commandId, name, data),
      },
      journal: deps.journal,
      ...(deps.renderPdf ? { renderPdf: deps.renderPdf } : {}),
    });
    this.client = new RemoteClient({
      state: deps.state,
      runner: commands,
      hello: () => ({
        app_version: deps.appVersion,
        companies: deps.companies().map((c) => ({ inn: c.inn, name: c.name })),
        capabilities: [
          "chat.message",
          "chat.attach",
          "proposal.list",
          "proposal.apply",
          "report.make",
          "status.get",
        ],
      }),
      ...(deps.ws ? { ws: deps.ws } : {}),
      ...(deps.backoffMs ? { backoffMs: deps.backoffMs } : {}),
      ...(deps.settleMs !== undefined ? { settleMs: deps.settleMs } : {}),
      onStatus: () => deps.onChange?.(this.view()),
    });
  }

  // ---- lifecycle ----

  /** At sign-out: the PC is switched off on the server (best effort) and forgets its device, so the next account starts clean. */
  async unpair(): Promise<void> {
    const device = this.deps.state.device();
    this.stop();
    if (!device) return;
    try {
      await this.call(device.serverUrl, "/remote/device/enabled", {
        method: "POST",
        body: { enabled: false },
        device: device.token,
      });
    } catch {
      // Offline: the server still holds the device, and the account can switch it off from its cabinet.
    }
    this.deps.state.forgetDevice();
    this.deps.onChange?.(this.view());
  }

  /** After sign-in (and at start): connects if this PC is paired and the switch is on. */
  start(): void {
    this.client.start();
    this.stopObserving ??= this.deps.assistant.observe((event) => this.tell(event));
    if (!this.licenseTimer && this.deps.licenseEnds) {
      void this.checkLicense();
      this.licenseTimer = setInterval(() => void this.checkLicense(), 24 * 3_600_000);
      this.licenseTimer.unref?.();
    }
  }

  /** At sign-out and at quit: the channel closes. */
  stop(): void {
    this.client.stop();
    this.stopObserving?.();
    this.stopObserving = null;
    if (this.licenseTimer) clearInterval(this.licenseTimer);
    this.licenseTimer = null;
  }

  // ---- what the phone is told: counts only, never an amount or a name ----

  private tell(event: AssistantEvent): void {
    const inn = this.deps.companies().find((c) => c.id === event.companyId)?.inn;
    if (!inn) return;
    if (event.type === "confirm") {
      const last = this.lastWaiting.get(event.companyId) ?? 0;
      if (Date.now() - last < NOTIFY_EVERY_MS) return;
      this.lastWaiting.set(event.companyId, Date.now());
      const count = this.deps.assistant
        .pendingProposals()
        .filter((p) => p.companyId === event.companyId).length;
      this.client.notify("proposal.waiting", inn, Math.max(count, 1));
    } else if (event.type === "decided" && event.outcome.status === "batch") {
      const created = event.outcome.results.filter((r) => r?.ok).length;
      if (created > 0) this.client.notify("import.finished", inn, created);
    }
  }

  private async checkLicense(): Promise<void> {
    try {
      const ends = await this.deps.licenseEnds?.();
      if (!ends) return;
      const days = (Date.parse(ends) - Date.now()) / 86_400_000;
      if (days >= 0 && days <= 7) this.client.notify("license.near_end", undefined, Math.ceil(days));
    } catch {
      // A missing license is not a reason to tell the phone anything.
    }
  }

  // ---- the settings screen ----

  view(): RemoteStateView {
    const status = this.client.status();
    const { state } = this.deps;
    return {
      paired: status.paired,
      connected: status.connected,
      enabled: state.enabled,
      ceiling: state.ceiling,
      hasPin: state.hasPin,
    };
  }

  /** The commands of the phones, newest first (no content: who, what, how it ended). */
  log() {
    return this.deps.state.journal();
  }

  async setEnabled(enabled: boolean): Promise<Result<RemoteStateView>> {
    const { state } = this.deps;
    state.setEnabled(enabled);
    // The server learns it too (it refuses every command for a switched-off PC); a PC that is offline still turns off here.
    const device = state.device();
    if (device) {
      try {
        await this.call(device.serverUrl, "/remote/device/enabled", {
          method: "POST",
          body: { enabled },
          device: device.token,
        });
      } catch (e) {
        if (enabled) {
          state.setEnabled(false);
          return fail("SERVER", e instanceof Error ? e.message : "The server could not be reached");
        }
      }
    }
    if (enabled) this.client.start();
    else this.client.stop();
    return { ok: true, data: this.view() };
  }

  setPin(pin: string | null): Result<RemoteStateView> {
    if (pin === null) this.deps.state.clearPin();
    else {
      if (!/^\d{4,12}$/.test(pin)) return fail("VALIDATION", "A PIN is 4 to 12 digits");
      this.deps.state.setPin(pin);
    }
    this.deps.onChange?.(this.view());
    return { ok: true, data: this.view() };
  }

  setCeiling(ceiling: RemoteCeiling): Result<RemoteStateView> {
    this.deps.state.setCeiling(ceiling);
    this.deps.onChange?.(this.view());
    return { ok: true, data: this.view() };
  }

  /** "Connect Telegram": registers this PC the first time, then asks for a one-time code and its link. */
  async connectTelegram(): Promise<Result<z.infer<typeof PairingResult>>> {
    try {
      const { state } = this.deps;
      let device = state.device();
      if (!device) {
        const { accessToken, serverUrl } = await this.deps.authorized();
        const made = RegisterDeviceResult.parse(
          await this.call(serverUrl, "/remote/devices", {
            method: "POST",
            body: { name: this.deps.deviceName, app_version: this.deps.appVersion },
            bearer: accessToken,
          }),
        );
        state.setDevice({ id: made.device_id, token: made.token, serverUrl });
        device = state.device();
      }
      if (!device) return fail("INTERNAL", "The device could not be saved");
      const pairing = PairingResult.parse(
        await this.call(device.serverUrl, "/remote/pairing", {
          method: "POST",
          body: { ceiling: state.ceiling },
          device: device.token,
        }),
      );
      // The channel opens as soon as the PC is paired, so the phone's first command is taken at once.
      if (state.enabled) this.client.start();
      this.deps.onChange?.(this.view());
      return { ok: true, data: pairing };
    } catch (e) {
      return errorResult(e);
    }
  }

  async links(): Promise<Result<RemoteLinkView[]>> {
    const device = this.deps.state.device();
    if (!device) return { ok: true, data: [] };
    try {
      const rows = z
        .array(LinkView)
        .parse(await this.call(device.serverUrl, "/remote/links", { device: device.token }));
      return { ok: true, data: rows };
    } catch (e) {
      return errorResult(e);
    }
  }

  async revokeLink(id: string): Promise<Result<null>> {
    const device = this.deps.state.device();
    if (!device) return fail("NOT_PAIRED", "This PC is not connected to Telegram");
    try {
      await this.call(device.serverUrl, `/remote/links/${encodeURIComponent(id)}`, {
        method: "DELETE",
        device: device.token,
      });
      return { ok: true, data: null };
    } catch (e) {
      return errorResult(e);
    }
  }

  // ---- files ----

  private async download(blobId: string): Promise<{ data: Uint8Array; sha256: string }> {
    const device = this.deps.state.device();
    if (!device) throw new Error("This PC is not connected");
    const response = await this.http(`${device.serverUrl.replace(/\/+$/, "")}/remote/blobs/${blobId}`, {
      headers: { authorization: `Device ${device.token}` },
    });
    if (!response.ok) throw new Error(`The file is gone from the server (${response.status})`);
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      sha256: response.headers.get("x-sha256") ?? "",
    };
  }

  private async upload(commandId: string, name: string, data: Uint8Array) {
    const device = this.deps.state.device();
    if (!device) throw new Error("This PC is not connected");
    const response = await this.http(`${device.serverUrl.replace(/\/+$/, "")}/remote/blobs`, {
      method: "POST",
      headers: {
        authorization: `Device ${device.token}`,
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(name),
        "x-sha256": createHash("sha256").update(data).digest("hex"),
        "x-command-id": commandId,
      },
      body: Buffer.from(data),
    });
    if (!response.ok) throw new Error(`The server did not take the file (${response.status})`);
    return z
      .object({ id: z.string(), name: z.string(), size: z.number(), sha256: z.string() })
      .parse(await response.json());
  }

  private async call(
    serverUrl: string,
    path: string,
    options: { method?: string; body?: unknown; bearer?: string; device?: string } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
    if (options.device) headers.authorization = `Device ${options.device}`;
    const response = await this.http(`${serverUrl.replace(/\/+$/, "")}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    if (response.status === 204) return null;
    const text = await response.text();
    const json: unknown = (() => {
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        return null;
      }
    })();
    if (!response.ok) {
      const body = (json ?? {}) as { code?: string; message?: string };
      throw new ControlError(
        body.code ?? "SERVER",
        body.message ?? `The server answered ${response.status}`,
        response.status,
      );
    }
    return json;
  }
}

function errorResult(e: unknown): { ok: false; code: string; message: string } {
  if (e instanceof ControlError) return fail(e.code, e.message);
  return fail("SERVER", e instanceof Error ? e.message : "The server could not be reached");
}
