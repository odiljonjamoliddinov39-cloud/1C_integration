import type { CommandView } from "@platform/shared";
import { describe, expect, it } from "vitest";

import { Api, ApiError, MAX_FILE_BYTES } from "./api.js";
import { follow, formatBytes, isTerminal, resultOf, isCardsResult } from "./commands.js";

const view = (state: CommandView["state"], over: Partial<CommandView> = {}): CommandView => ({
  id: "11111111-1111-4111-8111-111111111111",
  type: "chat.message",
  class: "prepare",
  company_inn: "123456789",
  state,
  created_at: "2026-01-01T00:00:00Z",
  expires_at: "2026-01-02T00:00:00Z",
  finished_at: null,
  blobs: [],
  ...over,
});

describe("follow", () => {
  it("polls until the request ends, reporting each state, and slows down", async () => {
    const states = ["queued", "queued", "delivered", "running", "done"] as const;
    let call = 0;
    const waits: number[] = [];
    const seen: string[] = [];
    const final = await follow(
      { command: async () => view(states[call++] ?? "done") },
      "id",
      (v) => seen.push(v.state),
      undefined,
      async (ms) => void waits.push(ms),
    );
    expect(final?.state).toBe("done");
    expect(seen).toEqual(["queued", "queued", "delivered", "running", "done"]);
    expect(waits).toEqual([1500, 2000, 2500, 3000]);
  });

  it("asks again after a failed poll instead of giving up", async () => {
    let call = 0;
    const final = await follow(
      {
        command: async () => {
          if (call++ === 0) throw new ApiError("NETWORK", "No connection");
          return view("failed");
        },
      },
      "id",
      () => undefined,
      undefined,
      async () => undefined,
    );
    expect(final?.state).toBe("failed");
  });

  it("stops when the screen closes", async () => {
    const abort = new AbortController();
    let calls = 0;
    const final = await follow(
      {
        command: async () => {
          calls++;
          abort.abort();
          return view("queued");
        },
      },
      "id",
      () => undefined,
      abort.signal,
      async () => undefined,
    );
    expect(final).toBeNull();
    expect(calls).toBe(1);
  });

  it("knows which states are final", () => {
    expect(
      ["done", "failed", "expired", "cancelled"].every((s) => isTerminal(s as CommandView["state"])),
    ).toBe(true);
    expect(["queued", "delivered", "running"].some((s) => isTerminal(s as CommandView["state"]))).toBe(false);
  });
});

describe("helpers", () => {
  it("formats sizes", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("reads a result only from a done request of the right shape", () => {
    expect(resultOf(view("done", { result: { cards: [] } }), isCardsResult)).toEqual({ cards: [] });
    expect(resultOf(view("running", { result: { cards: [] } }), isCardsResult)).toBeNull();
    expect(resultOf(view("done", { result: { nope: 1 } }), isCardsResult)).toBeNull();
  });
});

describe("Api", () => {
  const recorder = () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const http = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(view("queued")), { status: 201 });
    }) as unknown as typeof fetch;
    return { calls, api: new Api(() => "signed-init-data", http) };
  };

  it("signs every call with Telegram's initData", async () => {
    const { api, calls } = recorder();
    await api.command("abc");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("tma signed-init-data");
  });

  it("creates a request with its own id and the PC it goes to", async () => {
    const { api, calls } = recorder();
    await api.create({
      type: "chat.message",
      inn: "123456789",
      deviceId: "dev",
      payload: { text: "hi" },
      requestId: "r1",
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      type: "chat.message",
      company_inn: "123456789",
      device_id: "dev",
      payload: { text: "hi" },
      request_id: "r1",
    });
  });

  it("refuses a file over 20 MB before sending anything", async () => {
    const { api, calls } = recorder();
    const big = { size: MAX_FILE_BYTES + 1, name: "big.xlsx" } as File;
    await expect(api.upload(big, "dev")).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(calls).toHaveLength(0);
  });

  it("turns a server refusal into an error with its code, and a dead network into NETWORK", async () => {
    const refused = new Api(
      () => "x",
      (async () =>
        new Response(JSON.stringify({ code: "RATE_LIMIT", message: "slow down" }), {
          status: 429,
        })) as unknown as typeof fetch,
    );
    await expect(refused.me()).rejects.toMatchObject({ code: "RATE_LIMIT", status: 429 });
    const offline = new Api(() => "x", (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    await expect(offline.me()).rejects.toMatchObject({ code: "NETWORK" });
  });
});
