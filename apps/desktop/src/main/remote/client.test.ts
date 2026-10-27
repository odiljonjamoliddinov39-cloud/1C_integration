import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WsCommand } from "@platform/shared";
import { describe, expect, it } from "vitest";

import type { SecretBox } from "../store.js";
import { RemoteClient, type CommandRunner, type RunOutcome, type WsLike } from "./client.js";
import { RemoteState } from "./state.js";

const secrets: SecretBox = { encrypt: (p) => `enc:${p}`, decrypt: (e) => e.slice(4) };

class FakeSocket implements WsLike {
  sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: WsLike["onopen"] = null;
  onmessage: WsLike["onmessage"] = null;
  onclose: WsLike["onclose"] = null;
  onerror: WsLike["onerror"] = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  open() {
    this.onopen?.({});
  }
  /** The server sends a message. */
  push(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  /** The link drops. */
  drop(code = 1006) {
    this.onclose?.({ code });
  }
  of(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const command = (n: number, over: Partial<WsCommand> = {}): WsCommand => ({
  type: "command",
  id: ID(n),
  command_type: "status.get",
  class: "read",
  company_inn: "123456789",
  payload: {},
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  ceiling: "apply",
  telegram_user: "42",
  ...over,
});

function setup(
  run: (cmd: WsCommand) => Promise<RunOutcome> | RunOutcome = () => ({ ok: true, result: {}, blobs: [] }),
) {
  const state = new RemoteState(join(mkdtempSync(join(tmpdir(), "remote-client-")), "r.json"), secrets);
  state.setDevice({ id: "dev", token: "secret-token", serverUrl: "https://api.example.com" });
  const sockets: FakeSocket[] = [];
  const ran: string[] = [];
  const runner: CommandRunner = {
    run: async (cmd) => {
      ran.push(cmd.id);
      return run(cmd);
    },
  };
  const client = new RemoteClient({
    state,
    runner,
    hello: () => ({
      app_version: "1.2.3",
      companies: [{ inn: "123456789", name: "Texmash" }],
      capabilities: ["status.get"],
    }),
    ws: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
    backoffMs: [10],
    settleMs: 5,
  });
  return { state, sockets, ran, client };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("RemoteClient", () => {
  it("dials out with the token as a subprotocol and says hello with the ids it already ran", () => {
    const { client, sockets, state } = setup();
    state.finish(ID(9), { type: "result", id: ID(9), ok: true, result: {}, blobs: [] });
    client.start();
    const [ws] = sockets;
    expect(ws?.url).toBe("wss://api.example.com/remote/device");
    expect(ws?.protocols).toEqual(["platform.v1", "bearer.secret-token"]);
    ws?.open();
    expect(ws?.of("hello")[0]).toMatchObject({ app_version: "1.2.3", done_ids: [ID(9)] });
    client.stop();
  });

  it("does not connect when the switch is off or the PC is not paired", () => {
    const off = setup();
    off.state.setEnabled(false);
    off.client.start();
    expect(off.sockets).toHaveLength(0);
    const unpaired = setup();
    unpaired.state.forgetDevice();
    unpaired.client.start();
    expect(unpaired.sockets).toHaveLength(0);
  });

  it("acks, runs and answers a command once; a second delivery sends the same answer without running again", async () => {
    const { client, sockets, ran } = setup(() => ({ ok: true, result: { online: true }, blobs: [] }));
    client.start();
    const ws = sockets[0] as FakeSocket;
    ws.open();
    ws.push(command(1));
    await tick();
    expect(ws.of("ack")).toEqual([{ type: "ack", id: ID(1) }]);
    expect(ws.of("result")).toHaveLength(1);
    expect(ran).toEqual([ID(1)]);
    ws.push(command(1));
    await tick();
    expect(ran).toEqual([ID(1)]);
    expect(ws.of("result")).toHaveLength(2);
    expect(ws.of("result")[1]).toEqual(ws.of("result")[0]);
    client.stop();
  });

  it("sends an answer the server may not have again after a reconnect, without running the command", async () => {
    const { client, sockets, ran } = setup();
    client.start();
    const first = sockets[0] as FakeSocket;
    first.open();
    first.push(command(1));
    await tick();
    // The link drops right after the answer was sent: it may be lost.
    first.drop();
    await tick(30);
    const second = sockets[1] as FakeSocket;
    expect(second).toBeDefined();
    second.open();
    expect(second.of("hello")[0]).toMatchObject({ done_ids: [ID(1)] });
    expect(second.of("result").map((r) => r.id)).toEqual([ID(1)]);
    expect(ran).toEqual([ID(1)]);
    // The link stays up a while: the server has it, so it is not sent a third time.
    await tick(30);
    second.drop();
    await tick(30);
    const third = sockets[2] as FakeSocket;
    third.open();
    expect(third.of("result")).toHaveLength(0);
    client.stop();
  });

  it("fails a write that was running when the app stopped, and runs a Read again", async () => {
    const { client, sockets, ran, state } = setup();
    state.start(ID(1));
    state.start(ID(2));
    client.start();
    const ws = sockets[0] as FakeSocket;
    ws.open();
    ws.push(command(1, { command_type: "chat.attach", class: "prepare" }));
    ws.push(command(2, { command_type: "proposal.list" }));
    await tick();
    const results = ws.of("result");
    expect(results.find((r) => r.id === ID(1))).toMatchObject({ ok: false, error: { code: "INTERRUPTED" } });
    expect(results.find((r) => r.id === ID(2))).toMatchObject({ ok: true });
    expect(ran).toEqual([ID(2)]);
    client.stop();
  });

  it("runs heavy commands one after another and lets a status overtake them", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const { client, sockets } = setup(async (cmd) => {
      order.push(`start ${cmd.command_type}`);
      if (cmd.command_type === "chat.message" && cmd.id === ID(1)) await gate;
      order.push(`end ${cmd.command_type}`);
      return { ok: true, result: {}, blobs: [] };
    });
    client.start();
    const ws = sockets[0] as FakeSocket;
    ws.open();
    ws.push(command(1, { command_type: "chat.message", class: "prepare", payload: { text: "hi" } }));
    ws.push(command(2, { command_type: "chat.message", class: "prepare", payload: { text: "again" } }));
    ws.push(command(3));
    await tick();
    // The status is answered while the first message is still being worked on; the second waits for it.
    expect(order).toContain("end status.get");
    expect(order.filter((o) => o === "start chat.message")).toHaveLength(1);
    release();
    await tick(5);
    expect(order).toEqual([
      "start status.get",
      "end status.get",
      "start chat.message",
      "end chat.message",
      "start chat.message",
      "end chat.message",
    ]);
    client.stop();
  });

  it("answers a thrown error as a failed command, never leaving it silent", async () => {
    const { client, sockets } = setup(() => {
      throw new Error("boom");
    });
    client.start();
    const ws = sockets[0] as FakeSocket;
    ws.open();
    ws.push(command(1));
    await tick();
    expect(ws.of("result")[0]).toMatchObject({ ok: false, error: { code: "INTERNAL", message: "boom" } });
    client.stop();
  });

  it("answers pings", () => {
    const { client, sockets } = setup();
    client.start();
    const ws = sockets[0] as FakeSocket;
    ws.open();
    ws.push({ type: "ping" });
    expect(ws.of("pong")).toHaveLength(1);
    client.stop();
  });

  it("reconnects after a drop, and stops for good when the server says the token is wrong", async () => {
    const { client, sockets } = setup();
    client.start();
    (sockets[0] as FakeSocket).open();
    (sockets[0] as FakeSocket).drop();
    await tick(30);
    expect(sockets).toHaveLength(2);
    (sockets[1] as FakeSocket).drop(4401);
    await tick(30);
    expect(sockets).toHaveLength(2);
    expect(client.status().connected).toBe(false);
  });

  it("switches itself off when the account disables the device", async () => {
    const { client, sockets, state } = setup();
    client.start();
    const ws = sockets[0] as FakeSocket;
    ws.open();
    ws.push({ type: "revoke", reason: "device_disabled" });
    await tick();
    expect(state.enabled).toBe(false);
    expect(ws.closed).not.toBeNull();
    await tick(30);
    expect(sockets).toHaveLength(1);
  });

  it("ignores messages that are not part of the protocol", async () => {
    const { client, sockets, ran } = setup();
    client.start();
    const ws = sockets[0] as FakeSocket;
    ws.open();
    ws.push({ type: "command", id: "not-a-uuid" });
    ws.push({ type: "run-shell", cmd: "calc.exe" });
    ws.onmessage?.({ data: "not json" });
    await tick();
    expect(ran).toEqual([]);
    expect(ws.of("ack")).toHaveLength(0);
    client.stop();
  });
});
