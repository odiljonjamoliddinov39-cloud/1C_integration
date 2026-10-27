/**
 * The desktop apps' WebSockets (wss://<server>/remote/device). The server never calls a PC: the PC dials out, says hello with the ids
 * it already holds, and the server sends what is queued, oldest first. One socket per device (a new one replaces the old).
 */
import { REMOTE_LIMITS, WsToServer, type WsToDevice } from "@platform/shared";

import type { Bot } from "./telegram.js";
import type { DeviceChannel, DeviceRow, RemoteService } from "./service.js";

/** The part of a WebSocket the hub uses (the `ws` socket, or a fake in a test). */
export interface Socket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(event: "message", listener: (data: Buffer | string) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

interface Conn {
  socket: Socket;
  device: DeviceRow;
  lastSeen: number;
  /** Sends are chained so the order of the queue is kept. */
  chain: Promise<void>;
  helloed: boolean;
}

export class DeviceHub implements DeviceChannel {
  private readonly conns = new Map<string, Conn>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly service: RemoteService,
    private readonly bot: Bot | null,
    private readonly now: () => number = () => Date.now(),
  ) {
    service.attach(this);
  }

  online(deviceId: string): boolean {
    return this.conns.has(deviceId);
  }

  private send(conn: Conn, msg: WsToDevice): void {
    try {
      conn.socket.send(JSON.stringify(msg));
    } catch {
      // A dead socket is seen at its close.
    }
  }

  /** Sends what is queued for the device, if it has said hello. */
  async dispatch(deviceId: string): Promise<void> {
    const conn = this.conns.get(deviceId);
    if (!conn?.helloed) return;
    conn.chain = conn.chain
      .then(async () => {
        if (this.conns.get(deviceId) !== conn) return;
        const claimed = await this.service.claimQueued(conn.device);
        // The link may have dropped while the commands were being claimed: they were not sent, so they go back to the queue.
        if (this.conns.get(deviceId) !== conn) await this.service.release(claimed.map((c) => c.id));
        else for (const command of claimed) this.send(conn, command);
      })
      .catch(() => undefined);
    await conn.chain;
  }

  revoke(deviceId: string, reason: "link_revoked" | "device_disabled"): void {
    const conn = this.conns.get(deviceId);
    if (!conn) return;
    this.send(conn, { type: "revoke", reason });
    conn.socket.close(1000, reason);
  }

  /** A device connected (already authenticated): its messages are handled until the socket closes. */
  attachSocket(socket: Socket, device: DeviceRow, early: (Buffer | string)[] = []): void {
    const previous = this.conns.get(device.id);
    if (previous) previous.socket.close(1000, "replaced");
    const conn: Conn = { socket, device, lastSeen: this.now(), chain: Promise.resolve(), helloed: false };
    this.conns.set(device.id, conn);

    const onMessage = (raw: Buffer | string) => {
      conn.lastSeen = this.now();
      let msg: WsToServer;
      try {
        const parsed = WsToServer.safeParse(JSON.parse(raw.toString()));
        if (!parsed.success) return;
        msg = parsed.data;
      } catch {
        return;
      }
      void this.handle(conn, msg).catch(() => undefined);
    };
    socket.on("message", onMessage);
    // What the PC sent while its token was being checked (its hello comes at once) is handled first, in order.
    for (const raw of early) onMessage(raw);
    const closed = () => {
      if (this.conns.get(device.id) !== conn) return;
      this.conns.delete(device.id);
      void this.service.onDisconnect(device).catch(() => undefined);
    };
    socket.on("close", closed);
    socket.on("error", () => undefined);
  }

  private async handle(conn: Conn, msg: WsToServer): Promise<void> {
    const { device } = conn;
    switch (msg.type) {
      case "hello": {
        await this.service.hello(device.id, { app_version: msg.app_version, companies: msg.companies });
        await this.service.reconcile(device, msg.done_ids);
        conn.helloed = true;
        await this.dispatch(device.id);
        return;
      }
      case "ack":
        return this.service.ack(device, msg.id);
      case "progress":
        return this.service.progress(device, msg.id, msg.text);
      case "result":
        return this.service.complete(device, msg);
      case "ping":
        this.send(conn, { type: "pong" });
        return;
      case "pong":
        return;
      case "notify":
        // Only a count goes to Telegram, and only to the links of this device.
        await this.bot?.notify(device.id, msg.event, msg.count);
        return;
    }
  }

  /** Pings every connection and closes the ones silent for 60 seconds (the PC is then offline and its commands go back to the queue). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = this.now();
      for (const conn of this.conns.values()) {
        if (now - conn.lastSeen > REMOTE_LIMITS.offlineAfterSeconds * 1000) {
          (conn.socket.terminate ?? conn.socket.close).call(conn.socket);
          continue;
        }
        this.send(conn, { type: "ping" });
      }
    }, REMOTE_LIMITS.pingSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const conn of this.conns.values()) conn.socket.close(1001, "server stopping");
    this.conns.clear();
  }
}
