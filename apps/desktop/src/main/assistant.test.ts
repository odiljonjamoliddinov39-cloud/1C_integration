import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakePlatform } from "@platform/onec-client/testing";
import type { AiChatInput, AiEvent } from "@platform/shared";
import { describe, expect, it } from "vitest";

import type { AssistantEvent } from "../shared/ipc.js";
import { AssistantService } from "./assistant.js";
import { InProcessConnector } from "./connector.js";
import { ControlClient } from "./control-client.js";
import type { SessionService } from "./session.js";
import { LocalStore, type SecretBox } from "./store.js";

const secrets: SecretBox = { encrypt: (p) => `enc:${p}`, decrypt: (e) => e.slice(4) };

/**
 * A stand-in for the AI proxy: answers each turn from a script and records what the app sent.
 * Turns are written as the proxy streams them: one JSON event per line.
 */
function fakeProxy(script: ((input: AiChatInput) => AiEvent[] | Response)[]) {
  const requests: AiChatInput[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body)) as AiChatInput;
    requests.push(structuredClone(input));
    const turn = script[requests.length - 1];
    if (!turn) throw new Error("no more scripted turns");
    const events = turn(input);
    if (events instanceof Response) return events;
    return new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", {
      headers: { "content-type": "application/x-ndjson" },
    });
  };
  return { requests, fetchImpl };
}

function setup(script: Parameters<typeof fakeProxy>[0]) {
  const base = new FakePlatform();
  const store = new LocalStore(join(mkdtempSync(join(tmpdir(), "platform-")), "p.json"), secrets);
  const company = store.addCompany(
    {
      infobase: { kind: "file", file: "D:\\Bases\\TEST" },
      user: "Admin",
      password: "pw",
      organization: base.organizations[0]!,
    },
    { ok: false, checkedAt: "", code: "X", message: "" },
  );
  const proxy = fakeProxy(script);
  const session = {
    authorized: async () => ({
      client: new ControlClient("https://control.test", proxy.fetchImpl),
      accessToken: "access",
    }),
  } as unknown as SessionService;
  const events: AssistantEvent[] = [];
  const assistant = new AssistantService({
    store,
    session,
    connector: new InProcessConnector(() => base),
    emit: (e) => events.push(e),
  });
  return { assistant, store, company, events, proxy, base };
}

const thinking = { type: "thinking", thinking: "", signature: "opaque-signature" };

describe("assistant", () => {
  it("is off until the user turns it on for the company", async () => {
    const { assistant, company, proxy } = setup([]);
    const result = await assistant.send({ companyId: company.id, text: "Hi" });
    expect(result).toMatchObject({ ok: false, code: "AI_DISABLED" });
    expect(proxy.requests).toHaveLength(0);
  });

  it("runs the model's 1C query on this PC and sends back only the result", async () => {
    const { assistant, store, company, events, proxy } = setup([
      () => [
        { type: "text", text: "Checking 1C… " },
        {
          type: "message",
          stopReason: "tool_use",
          content: [
            thinking,
            { type: "text", text: "Checking 1C… " },
            {
              type: "tool_use",
              id: "tu_1",
              name: "run_query",
              input: {
                query: "ВЫБРАТЬ Счет ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки(&Д)",
                params: { Д: "2026-10-04" },
              },
            },
          ],
        },
      ],
      () => [
        { type: "text", text: "5110: 125 000 000 so'm." },
        {
          type: "message",
          stopReason: "end_turn",
          content: [{ type: "text", text: "5110: 125 000 000 so'm." }],
        },
      ],
    ]);
    store.setAiEnabled(company.id, true);

    const result = await assistant.send({ companyId: company.id, text: "5110 qoldig'i qancha?" });
    expect(result).toEqual({ ok: true, data: null });

    // The first request carries the question and the company name.
    expect(proxy.requests[0]).toEqual({
      company: company.name,
      messages: [{ role: "user", content: "5110 qoldig'i qancha?" }],
    });
    // The second sends the assistant turn back unchanged (thinking included), then the 1C rows.
    const second = proxy.requests[1]!.messages;
    expect(second[1]).toEqual({ role: "assistant", content: expect.arrayContaining([thinking]) });
    const toolResult = (
      second[2]!.content as unknown as { tool_use_id: string; content: string; is_error?: boolean }[]
    )[0]!;
    expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
    expect(toolResult.is_error).toBeUndefined();
    expect(JSON.parse(toolResult.content).rows[0]).toEqual(["5110 Расчетный счет", 125_000_000, 0]);

    expect(events.map((e) => e.type)).toEqual(["text", "tool", "text", "done"]);
    expect(events[1]).toMatchObject({ type: "tool", name: "run_query", companyId: company.id });
  });

  it("returns 1C query errors and bad tool input to the model as errors, so it can fix them", async () => {
    const { assistant, store, company, proxy } = setup([
      () => [
        {
          type: "message",
          stopReason: "tool_use",
          content: [
            { type: "tool_use", id: "a", name: "run_query", input: { query: "УДАЛИТЬ" } },
            { type: "tool_use", id: "b", name: "run_query", input: { query: 42 } },
            { type: "tool_use", id: "c", name: "write_document", input: {} },
          ],
        },
      ],
      () => [{ type: "message", stopReason: "end_turn", content: [{ type: "text", text: "Sorry." }] }],
    ]);
    store.setAiEnabled(company.id, true);
    await assistant.send({ companyId: company.id, text: "?" });
    const results = proxy.requests[1]!.messages[2]!.content as unknown as {
      content: string;
      is_error?: boolean;
    }[];
    expect(results.map((r) => [r.is_error, JSON.parse(r.content).error])).toEqual([
      [true, "QUERY_ERROR"],
      [true, "VALIDATION"],
      [true, "UNKNOWN_TOOL"],
    ]);
  });

  it("never runs a tool call from a cut-off turn, and keeps the conversation valid", async () => {
    const { assistant, store, company, base, proxy } = setup([
      () => [
        {
          type: "message",
          stopReason: "max_tokens",
          content: [{ type: "tool_use", id: "cut", name: "run_query", input: { query: "ВЫБРАТЬ" } }],
        },
      ],
      () => [{ type: "message", stopReason: "end_turn", content: [{ type: "text", text: "OK" }] }],
    ]);
    store.setAiEnabled(company.id, true);
    expect(await assistant.send({ companyId: company.id, text: "?" })).toMatchObject({
      code: "AI_TRUNCATED",
    });
    expect(base.calls.filter((c) => c.fn === "RunQuery")).toHaveLength(0);

    await assistant.send({ companyId: company.id, text: "Again" });
    const messages = proxy.requests[1]!.messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "user"]);
    expect(messages[2]!.content).toEqual([
      expect.objectContaining({ type: "tool_result", tool_use_id: "cut", is_error: true }),
    ]);
  });

  it("shows the proxy's refusals, such as a used-up quota, as errors", async () => {
    const { assistant, store, company, events } = setup([
      () =>
        new Response(JSON.stringify({ code: "AI_QUOTA_EXCEEDED", message: "Quota is used up" }), {
          status: 429,
        }),
      () => [{ type: "error", code: "AI_BUSY", message: "Busy" }],
    ]);
    store.setAiEnabled(company.id, true);
    expect(await assistant.send({ companyId: company.id, text: "?" })).toMatchObject({
      code: "AI_QUOTA_EXCEEDED",
    });
    expect(await assistant.send({ companyId: company.id, text: "?" })).toMatchObject({ code: "AI_BUSY" });
    expect(events.filter((e) => e.type === "error")).toHaveLength(2);
  });
});
