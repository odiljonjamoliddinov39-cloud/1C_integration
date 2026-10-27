import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WsResult } from "@platform/shared";
import { describe, expect, it } from "vitest";

import type { SecretBox } from "../store.js";
import { INBOX_MAX, PIN_LOCK_MS, PIN_TRIES, RemoteState } from "./state.js";

const secrets: SecretBox = { encrypt: (p) => `enc:${p}`, decrypt: (e) => e.slice(4) };
const file = () => join(mkdtempSync(join(tmpdir(), "remote-state-")), "remote.json");
const result = (id: string): WsResult => ({ type: "result", id, ok: true, result: { a: 1 }, blobs: [] });

describe("RemoteState", () => {
  it("keeps the device token sealed and gives it back after a restart", () => {
    const path = file();
    new RemoteState(path, secrets).setDevice({ id: "d1", token: "tok", serverUrl: "https://s" });
    const reopened = new RemoteState(path, secrets);
    expect(reopened.device()).toEqual({ id: "d1", token: "tok", serverUrl: "https://s" });
    expect(readFileSync(path, "utf8")).not.toContain('"tok"');
  });

  it("remembers what ran: new, started, done with its answer; the answer survives a restart", () => {
    const path = file();
    const state = new RemoteState(path, secrets);
    const id = "11111111-1111-4111-8111-111111111111";
    expect(state.seen(id)).toEqual({ state: "new" });
    state.start(id);
    expect(state.seen(id)).toEqual({ state: "started" });
    state.finish(id, result(id));
    const again = new RemoteState(path, secrets);
    expect(again.seen(id)).toEqual({ state: "done", result: result(id) });
    expect(again.doneIds()).toEqual([id]);
    expect(again.undelivered().map((r) => r.id)).toEqual([id]);
    again.delivered(id);
    expect(again.undelivered()).toEqual([]);
    // Still known: a repeat delivery is not run.
    expect(again.seen(id).state).toBe("done");
  });

  it("keeps the newest ids and forgets what is older than two days", () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const state = new RemoteState(file(), secrets, () => now);
    for (let i = 0; i < INBOX_MAX + 5; i++) state.finish(`id-${i}`, result(`id-${i}`));
    expect(state.doneIds()).toHaveLength(INBOX_MAX);
    expect(state.doneIds()).not.toContain("id-0");
    now += 49 * 3_600_000;
    state.start("fresh");
    expect(state.doneIds()).toEqual([]);
  });

  it("checks the PIN, counts wrong ones and locks after too many", () => {
    let now = 1_000_000;
    const state = new RemoteState(file(), secrets, () => now);
    expect(state.checkPin("1234")).toBe("unset");
    state.setPin("1234");
    expect(state.checkPin("1234")).toBe("ok");
    expect(state.checkPin(undefined)).toBe("wrong");
    for (let i = 0; i < PIN_TRIES - 2; i++) expect(state.checkPin("0000")).toBe("wrong");
    expect(state.checkPin("0000")).toBe("locked");
    // Locked even for the right PIN, until the time passes.
    expect(state.checkPin("1234")).toBe("locked");
    now += PIN_LOCK_MS + 1;
    expect(state.checkPin("1234")).toBe("ok");
  });

  it("keeps a short journal, newest first, without content", () => {
    const state = new RemoteState(file(), secrets);
    state.log({
      id: "a",
      type: "status.get",
      class: "read",
      companyInn: "123456789",
      telegramUser: "1",
      status: "done",
    });
    state.log({
      id: "b",
      type: "proposal.apply",
      class: "apply",
      companyInn: "123456789",
      telegramUser: "1",
      status: "refused",
      code: "PIN_WRONG",
    });
    expect(state.journal().map((r) => r.id)).toEqual(["b", "a"]);
  });
});
