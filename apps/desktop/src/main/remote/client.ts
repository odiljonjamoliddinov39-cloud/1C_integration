/**
 * The PC's outbound WebSocket to the server (the server never calls the PC). It says hello with the ids it
 * already ran, takes what is queued oldest first, acknowledges each command, runs it through the runner, and
 * sends the answer; an answer the server may not have is sent again at the next connection. A command seen
 * twice (remote_inbox) runs once.
 */
import { REMOTE_LIMITS, WsToDevice, type WsCommand, type WsResult, type WsToServer } from "@platform/shared";

import type { RemoteState } from "./state.js";

/** The part of a WebSocket the client uses (the global one in Electron, a fake in tests). */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export type WsFactory = (url: string, protocols: string[]) => WsLike;

export type RunOutcome = Omit<WsResult, "type" | "id">;

export interface CommandRunner {
  run(command: WsCommand, progress: (text: string) => void): Promise<RunOutcome>;
}

export interface RemoteClientDeps {
  state: RemoteState;
  runner: CommandRunner;
  /** What the hello says about this PC; asked at each connection. */
  hello: () => { app_version: string; companies: { inn: string; name: string }[]; capabilities: string[] };
  ws?: WsFactory;
  /** Tells the app that the connection or the switch changed. */
  onStatus?: (status: RemoteStatus) => void;
  /** Reconnect waits (ms), growing to the last one. */
  backoffMs?: readonly number[];
  /** How long an answer sent stays "maybe lost" if the socket drops (ms). */
  settleMs?: number;
}

export interface RemoteStatus {
  connected: boolean;
  enabled: boolean;
  paired: boolean;
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

/** Commands that only read the app's own state and may run beside a long one. */
const LIGHT = new Set(["status.get", "proposal.list", "proposal.decline"]);

const toWs = (serverUrl: string) => `${serverUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/remote/device`;

export class RemoteClient {
  private ws: WsLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private stopped = true;
  private connected = false;
  /** The heavy commands (chat, files, reports, writes) run one after another. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RemoteClientDeps) {}

  status(): RemoteStatus {
    return {
      connected: this.connected,
      enabled: this.deps.state.enabled,
      paired: this.deps.state.device() !== null,
    };
  }

  private emitStatus(): void {
    this.deps.onStatus?.(this.status());
  }

  /** Connects when the PC is paired and the switch is on; harmless to call again. */
  start(): void {
    this.stopped = false;
    if (this.ws || this.timer) return;
    if (!this.deps.state.enabled || !this.deps.state.device()) {
      this.emitStatus();
      return;
    }
    this.connect();
  }

  /** Closes the connection and does not come back until start(). */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.drop();
    this.emitStatus();
  }

  private drop(): void {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close(1000, "bye");
      } catch {
        // Already closed.
      }
    }
    this.connected = false;
  }

  private connect(): void {
    const device = this.deps.state.device();
    if (!device) return;
    const make: WsFactory =
      this.deps.ws ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as WsLike);
    let ws: WsLike;
    try {
      ws = make(toWs(device.serverUrl), ["platform.v1", `bearer.${device.token}`]);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.connected = true;
      const hello = this.deps.hello();
      this.send(ws, {
        type: "hello",
        ...hello,
        done_ids: this.deps.state.doneIds(),
      });
      // Answers the server may not have; the ones it already has are ignored there.
      for (const result of this.deps.state.undelivered()) this.sendResult(ws, result);
      this.ping = setInterval(() => this.send(ws, { type: "ping" }), REMOTE_LIMITS.pingSeconds * 1000);
      this.ping.unref?.();
      this.emitStatus();
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      void this.receive(ws, event.data).catch(() => undefined);
    };
    ws.onerror = () => undefined;
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.drop();
      this.emitStatus();
      // 4401: the token is wrong (the device was deleted or the switch is off); trying again would only repeat it.
      if (event.code === 4401) {
        this.stopped = true;
        return;
      }
      this.retry();
    };
  }

  private retry(): void {
    if (this.stopped || this.timer) return;
    const waits = this.deps.backoffMs ?? BACKOFF_MS;
    const wait = waits[Math.min(this.attempt, waits.length - 1)] ?? 1_000;
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped && this.deps.state.enabled) this.connect();
    }, wait);
    this.timer.unref?.();
  }

  private send(ws: WsLike, message: WsToServer): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // The close handler brings the connection back.
    }
  }

  private sendResult(ws: WsLike, result: WsResult): void {
    this.send(ws, result);
    // Sent and the link stayed up a while: the server has it. A drop right after leaves it to be sent again.
    const settle = setTimeout(() => {
      if (this.ws === ws) this.deps.state.delivered(result.id);
    }, this.deps.settleMs ?? 10_000);
    settle.unref?.();
  }

  private async receive(ws: WsLike, data: unknown): Promise<void> {
    let message: WsToDevice;
    try {
      const parsed = WsToDevice.safeParse(JSON.parse(String(data)));
      if (!parsed.success) return;
      message = parsed.data;
    } catch {
      return;
    }
    switch (message.type) {
      case "ping":
        this.send(ws, { type: "pong" });
        return;
      case "pong":
        return;
      case "revoke":
        // The switch was turned off from the account: nothing runs until it is turned on here.
        if (message.reason === "device_disabled") {
          this.deps.state.setEnabled(false);
          this.stop();
        }
        return;
      case "command":
        return this.accept(ws, message);
    }
  }

  private accept(ws: WsLike, command: WsCommand): Promise<void> {
    const { state } = this.deps;
    const seen = state.seen(command.id);
    if (seen.state === "done") {
      // Delivered twice: it is not run again, the answer it had is sent again.
      this.sendResult(ws, seen.result);
      return Promise.resolve();
    }
    const run = async () => {
      this.send(ws, { type: "ack", id: command.id });
      let outcome: RunOutcome;
      if (seen.state === "started" && command.class !== "read") {
        // A write that was running when the app stopped may have partly happened: it is not repeated.
        outcome = {
          ok: false,
          blobs: [],
          error: { code: "INTERRUPTED", message: "The app stopped while this ran: check what was made" },
        };
      } else {
        state.start(command.id);
        try {
          outcome = await this.deps.runner.run(command, (text) =>
            this.send(ws, { type: "progress", id: command.id, text: text.slice(0, 200) }),
          );
        } catch (e) {
          outcome = {
            ok: false,
            blobs: [],
            error: { code: "INTERNAL", message: e instanceof Error ? e.message.slice(0, 300) : "Failed" },
          };
        }
      }
      const result: WsResult = { type: "result", id: command.id, ...outcome };
      state.finish(command.id, result);
      this.sendResult(this.ws ?? ws, result);
    };
    if (LIGHT.has(command.command_type)) return run();
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** A notification to the phone (a count only); dropped when the PC is not connected. */
  notify(event: Extract<WsToServer, { type: "notify" }>["event"], companyInn?: string, count?: number): void {
    if (!this.ws || !this.connected) return;
    this.send(this.ws, { type: "notify", event, company_inn: companyInn, count });
  }
}
