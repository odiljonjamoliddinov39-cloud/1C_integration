import { describe, expect, it } from "vitest";

import {
  CreateCommandInput,
  NOTIFY_EVENTS,
  TTL_HOURS,
  WsToDevice,
  WsToServer,
  classAllowed,
  classOf,
  notificationText,
  parsePayload,
} from "./remote.js";

describe("what a command may do", () => {
  it("each command has a class, and a message is Prepare only for a link that may prepare", () => {
    expect(classOf("status.get", "read")).toBe("read");
    expect(classOf("proposal.list", "apply")).toBe("read");
    expect(classOf("report.make", "read")).toBe("read");
    expect(classOf("chat.attach", "prepare")).toBe("prepare");
    expect(classOf("proposal.apply", "apply")).toBe("apply");
    expect(classOf("chat.message", "read")).toBe("read");
    expect(classOf("chat.message", "prepare")).toBe("prepare");
    expect(classOf("chat.message", "apply")).toBe("prepare");
  });
  it("a ceiling allows its class and the ones below it", () => {
    expect(classAllowed("read", "read")).toBe(true);
    expect(classAllowed("read", "prepare")).toBe(false);
    expect(classAllowed("prepare", "apply")).toBe(false);
    expect(classAllowed("apply", "read")).toBe(true);
  });
  it("Read and Prepare wait a day, Apply two hours", () => {
    expect(TTL_HOURS).toEqual({ read: 24, prepare: 24, apply: 2 });
  });
});

describe("payloads", () => {
  it("are checked per command type; an Apply must carry the proposal's hash", () => {
    expect(parsePayload({ type: "chat.message", payload: { text: " salom " } })).toEqual({
      ok: true,
      payload: { text: "salom" },
    });
    expect(parsePayload({ type: "chat.message", payload: { text: "" } }).ok).toBe(false);
    expect(parsePayload({ type: "chat.message", payload: { text: "x".repeat(4001) } }).ok).toBe(false);
    expect(parsePayload({ type: "status.get", payload: undefined })).toEqual({ ok: true, payload: {} });
    expect(parsePayload({ type: "status.get", payload: { extra: 1 } }).ok).toBe(false);
    expect(parsePayload({ type: "proposal.apply", payload: { proposal_id: "p" } }).ok).toBe(false);
    expect(
      parsePayload({ type: "proposal.apply", payload: { proposal_id: "p" }, proposal_hash: "a".repeat(64) })
        .ok,
    ).toBe(true);
    expect(parsePayload({ type: "report.make", payload: { report: "audit", format: "pdf" } }).ok).toBe(true);
    expect(parsePayload({ type: "report.make", payload: { report: "shell", format: "pdf" } }).ok).toBe(false);
  });
  it("a command that is not in the list is not accepted", () => {
    const base = { company_inn: "311012912", payload: {}, request_id: crypto.randomUUID() };
    expect(CreateCommandInput.safeParse({ ...base, type: "shell.run" }).success).toBe(false);
    expect(CreateCommandInput.safeParse({ ...base, type: "status.get" }).success).toBe(true);
    expect(CreateCommandInput.safeParse({ ...base, type: "status.get", company_inn: "123" }).success).toBe(
      false,
    );
    expect(CreateCommandInput.safeParse({ ...base, type: "status.get", request_id: "nope" }).success).toBe(
      false,
    );
  });
});

describe("the WebSocket messages", () => {
  it("the PC's messages are told apart by their type", () => {
    expect(
      WsToServer.safeParse({ type: "hello", app_version: "1", companies: [], capabilities: [] }).success,
    ).toBe(true);
    expect(WsToServer.safeParse({ type: "result", id: crypto.randomUUID(), ok: true }).success).toBe(true);
    expect(WsToServer.safeParse({ type: "command" }).success).toBe(false);
    expect(WsToDevice.safeParse({ type: "revoke", reason: "device_disabled" }).success).toBe(true);
    expect(WsToDevice.safeParse({ type: "revoke", reason: "because" }).success).toBe(false);
  });
});

describe("what Telegram is told", () => {
  it("is a few words and a count, in the user's language, never an amount or a name", () => {
    for (const event of NOTIFY_EVENTS)
      for (const lang of ["uz", "ru", "en"] as const) {
        const text = notificationText(event, lang, 12);
        expect(text.length).toBeGreaterThan(10);
        expect(text).not.toMatch(/\d{4,}/);
      }
    expect(notificationText("import.finished", "uz", 12)).toContain("12");
    expect(notificationText("error", "en")).toBe("Something went wrong. Open the app.");
  });
});
