import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakePlatform } from "@platform/onec-client/testing";
import {
  AUDIT_TOOLS,
  CHAT_TOOLS,
  DEFAULT_AI_POLICY,
  type AiChatInput,
  type AiEvent,
  type QueryTemplateView,
} from "@platform/shared";
import { describe, expect, it, vi } from "vitest";

import type { AssistantEvent } from "../shared/ipc.js";
import { AssistantService, auditToCsv } from "./assistant.js";
import type { AuditCheck } from "./audit-checks.js";
import { CostEngine } from "./ai/engine.js";
import { ChatStore } from "./chats.js";
import { InProcessConnector } from "./connector.js";
import { ControlClient } from "./control-client.js";
import type { SessionService } from "./session.js";
import { LocalStore, type SecretBox } from "./store.js";

const secrets: SecretBox = { encrypt: (p) => `enc:${p}`, decrypt: (e) => e.slice(4) };

/**
 * A stand-in for the AI proxy: answers each turn from a script and records what the app sent.
 * Turns are written as the proxy streams them: one JSON event per line.
 */
function fakeProxy(
  script: ((input: AiChatInput) => AiEvent[] | Response)[],
  /** Answers to the cost engine's other endpoints (policy, templates, cache, digest); a 404 by default. */
  others: (url: string, method: string, body: unknown) => Response | null = () => null,
) {
  const requests: AiChatInput[] = [];
  const encodings: (string | undefined)[] = [];
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    if (!path.startsWith("/v1/ai/chat")) {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: path, method: init?.method ?? "GET", body });
      return (
        others(path, init?.method ?? "GET", body) ??
        new Response(JSON.stringify({ code: "NOT_FOUND", message: "No such endpoint" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      );
    }
    const encoding = (init?.headers as Record<string, string> | undefined)?.["content-encoding"];
    encodings.push(encoding);
    const raw = encoding === "gzip" ? gunzipSync(init?.body as Buffer).toString() : String(init?.body);
    const input = JSON.parse(raw) as AiChatInput;
    requests.push(structuredClone(input));
    const turn = script[requests.length - 1];
    if (!turn) throw new Error("no more scripted turns");
    const events = turn(input);
    if (events instanceof Response) return events;
    return new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", {
      headers: { "content-type": "application/x-ndjson" },
    });
  };
  return { requests, fetchImpl, encodings, calls };
}

const TEST_CHECKS: AuditCheck[] = [
  {
    id: "cash_negative",
    section: "cash",
    title: { en: "Negative cash", ru: "Отрицательный остаток кассы", uz: "Kassada manfiy qoldiq" },
    instructions: "Find days with a negative balance on 50xx.",
  },
  {
    id: "import_customs",
    section: "import",
    title: { en: "Imports with ГТД", ru: "Импорт и ГТД", uz: "Import va BYD" },
    instructions: "Find import receipts without a customs declaration.",
  },
];

function setup(
  script: Parameters<typeof fakeProxy>[0],
  licenseMode: "active" | "read_only" = "active",
  others?: Parameters<typeof fakeProxy>[1],
) {
  const base = new FakePlatform();
  const dir = mkdtempSync(join(tmpdir(), "platform-"));
  const store = new LocalStore(join(dir, "p.json"), secrets);
  const chats = new ChatStore(join(dir, "chats"), secrets);
  const company = store.addCompany(
    {
      infobase: { kind: "file", file: "D:\\Bases\\TEST" },
      user: "Admin",
      password: "pw",
      organization: base.organizations[0]!,
    },
    { ok: false, checkedAt: "", code: "X", message: "" },
  );
  const proxy = fakeProxy(script, others);
  const session = {
    authorized: async () => ({
      client: new ControlClient("https://control.test", proxy.fetchImpl),
      accessToken: "access",
    }),
    view: async () => ({ license: { mode: licenseMode } }),
  } as unknown as SessionService;
  const events: AssistantEvent[] = [];
  const assistant = new AssistantService({
    store,
    chats,
    session,
    connector: new InProcessConnector(() => base),
    emit: (e) => events.push(e),
    retryDelaysMs: [1, 1, 1],
    maxTurns: 25,
    auditChecks: TEST_CHECKS,
    auditConcurrency: 1,
  });
  return { assistant, store, chats, dir, company, events, proxy, base, session };
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
      tools: CHAT_TOOLS,
      // A short read of a figure: the proxy may give it to the cheaper model, when the policy has one.
      task: "lookup",
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
    // The rows go up as a compact table: the column names once, then a line per row.
    expect(toolResult.content.split("\n").slice(0, 2)).toEqual([
      "rows[4]{Счет,СальдоДт,СальдоКт}:",
      "  5110 Расчетный счет,125000000,0",
    ]);

    expect(events.map((e) => e.type)).toEqual(["text", "tool", "text", "done", "elapsed"]);
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

  it("never runs a tool call cut off at the output limit: the model sends it again in parts", async () => {
    const { assistant, store, company, base, proxy, events } = setup([
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
    expect(await assistant.send({ companyId: company.id, text: "?" })).toEqual({ ok: true, data: null });
    expect(base.calls.filter((c) => c.fn === "RunQuery")).toHaveLength(0);
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);

    const messages = proxy.requests[1]!.messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[2]!.content).toEqual([
      expect.objectContaining({ type: "tool_result", tool_use_id: "cut", is_error: true }),
      { type: "text", text: expect.stringContaining("smaller parts") },
    ]);
  });

  it("continues an answer cut off at the output limit, as one answer on screen", async () => {
    const { assistant, store, company, proxy, events, chats } = setup([
      () => [
        { type: "text", text: "Part one, " },
        { type: "message", stopReason: "max_tokens", content: [{ type: "text", text: "Part one, " }] },
      ],
      () => [
        { type: "text", text: "part two." },
        { type: "message", stopReason: "end_turn", content: [{ type: "text", text: "part two." }] },
      ],
    ]);
    store.setAiEnabled(company.id, true);
    expect(await assistant.send({ companyId: company.id, text: "?" })).toEqual({ ok: true, data: null });
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
    expect(proxy.requests[1]!.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: expect.stringContaining("Continue exactly where it stopped") }],
    });
    const [summary] = chats.list(company.id);
    const entries = chats.load(company.id, summary!.id)!.entries;
    expect(entries.filter((e) => e.kind === "assistant")).toEqual([
      { kind: "assistant", text: "Part one, part two." },
    ]);
  });

  it("shows the proxy's refusals, such as a used-up quota, as errors", async () => {
    const { assistant, store, company, events } = setup([
      () =>
        new Response(JSON.stringify({ code: "AI_QUOTA_EXCEEDED", message: "Quota is used up" }), {
          status: 429,
        }),
      // A busy AI service is tried again three times before the user sees it.
      ...Array.from({ length: 4 }, () => (): AiEvent[] => [
        { type: "error", code: "AI_BUSY", message: "Busy" },
      ]),
    ]);
    store.setAiEnabled(company.id, true);
    expect(await assistant.send({ companyId: company.id, text: "?" })).toMatchObject({
      code: "AI_QUOTA_EXCEEDED",
    });
    expect(await assistant.send({ companyId: company.id, text: "?" })).toMatchObject({ code: "AI_BUSY" });
    expect(events.filter((e) => e.type === "error")).toHaveLength(2);
  });

  describe("documents it prepares", () => {
    /** The model asks for a card, then answers after hearing the result. */
    const proposeThenAnswer = (tool: string, input: unknown) => [
      () => [
        {
          type: "message" as const,
          stopReason: "tool_use",
          content: [{ type: "tool_use", id: "p1", name: tool, input }],
        },
      ],
      () => [{ type: "message" as const, stopReason: "end_turn", content: [{ type: "text", text: "OK" }] }],
    ];
    const resultOf = (requests: AiChatInput[]) =>
      JSON.parse((requests[1]!.messages[2]!.content as unknown as { content: string }[])[0]!.content);

    /** Answers the card as soon as it appears. */
    function answerCards(
      events: AssistantEvent[],
      assistant: AssistantService,
      approve: boolean,
    ): Promise<void> {
      return new Promise((resolve) => {
        const timer = setInterval(() => {
          const card = events.find((e) => e.type === "confirm");
          if (card?.type === "confirm") {
            clearInterval(timer);
            assistant.decide(card.companyId, card.id, approve);
            resolve();
          }
        }, 1);
      });
    }

    it("issues an invoice for a sale only after the user confirms the card", async () => {
      const { assistant, store, company, events, proxy, base } = setup(
        proposeThenAnswer("propose_invoice_issued", { sale: { number: "0000-000123", date: "2026-10-01" } }),
      );
      store.setAiEnabled(company.id, true);
      const sending = assistant.send({ companyId: company.id, text: "123-sotuvga schyot-faktura yoz" });
      await answerCards(events, assistant, true);
      expect(await sending).toEqual({ ok: true, data: null });

      const card = events.find((e) => e.type === "confirm");
      expect(card).toMatchObject({ proposal: { kind: "invoice_issued", sale: { number: "0000-000123" } } });
      expect(base.issued).toHaveLength(1);
      expect(events.find((e) => e.type === "decided")).toMatchObject({ outcome: { status: "created" } });
      expect(resultOf(proxy.requests)).toMatchObject({ status: "created", document: { posted: false } });
    });

    it("writes nothing when the user cancels, and tells the model so", async () => {
      const { assistant, store, company, events, proxy, base } = setup(
        proposeThenAnswer("propose_invoice_issued", { sale: { number: "0000-000123", date: "2026-10-01" } }),
      );
      store.setAiEnabled(company.id, true);
      const sending = assistant.send({ companyId: company.id, text: "?" });
      await answerCards(events, assistant, false);
      await sending;
      expect(base.issued).toHaveLength(0);
      expect(resultOf(proxy.requests)).toEqual({ status: "declined_by_user" });
    });

    it("needs no card when the sale already has an invoice", async () => {
      const { assistant, store, company, events, proxy, base } = setup(
        proposeThenAnswer("propose_invoice_issued", { sale: { number: "0000-000123", date: "2026-10-01" } }),
      );
      base.issued.push({
        ref: "11111111-1111-1111-1111-111111111111",
        number: "7",
        date: "2026-10-01T00:00:00",
        saleRef: base.sales[0]!.ref,
      });
      store.setAiEnabled(company.id, true);
      await assistant.send({ companyId: company.id, text: "?" });
      expect(events.some((e) => e.type === "confirm")).toBe(false);
      expect(resultOf(proxy.requests)).toMatchObject({ status: "already_exists", invoice: { number: "7" } });
    });

    it("records a supplier's invoice the user confirms, as manual input", async () => {
      const invoice = {
        number: "45",
        date: "2026-10-01",
        counterparty: { inn: "123456789" },
        lines: [
          {
            item: { ikpu: "10202001001000000" },
            quantity: 2,
            price: 10000,
            amount: 20000,
            vatRate: 12,
            vatAmount: 2400,
            total: 22400,
          },
        ],
      };
      const { assistant, store, company, events, base } = setup(
        proposeThenAnswer("propose_invoice_received", invoice),
      );
      store.setAiEnabled(company.id, true);
      const sending = assistant.send({ companyId: company.id, text: "?" });
      await answerCards(events, assistant, true);
      await sending;
      expect(base.documents).toEqual([
        expect.objectContaining({ source: "manual", supplierNumber: "45", posted: false }),
      ]);
      expect(base.documents[0]!.externalId).toMatch(/^chat-/);
    });

    it("adds, changes and marks a directory item for deletion, each after its own confirmation", async () => {
      const create = {
        action: "create",
        object: "Справочник.Контрагенты",
        fields: { Наименование: "ООО «Новый»", ИНН: "305999999" },
      };
      const { assistant, store, company, events, proxy, base } = setup(
        proposeThenAnswer("propose_change", create),
      );
      store.setAiEnabled(company.id, true);
      const sending = assistant.send({ companyId: company.id, text: "Yangi kontragent qoʻsh" });
      await answerCards(events, assistant, true);
      await sending;
      const card = events.find((e) => e.type === "confirm");
      expect(card).toMatchObject({
        proposal: {
          kind: "change",
          preview: {
            action: "create",
            changes: [{ field: "Наименование", before: null, after: "ООО «Новый»" }, expect.anything()],
          },
        },
      });
      const result = resultOf(proxy.requests);
      expect(result).toMatchObject({ status: "done", action: "create", object: { deletionMark: false } });
      const ref = result.object.ref as string;
      expect(base.objects.get(ref)?.fields).toEqual({ Наименование: "ООО «Новый»", ИНН: "305999999" });

      // Change it, then mark it for deletion: each is a new card the user confirms.
      for (const change of [
        {
          action: "update",
          object: "Справочник.Контрагенты",
          ref,
          fields: { Наименование: "ООО «Новое имя»" },
        },
        { action: "delete", object: "Справочник.Контрагенты", ref },
      ]) {
        const next = setup(proposeThenAnswer("propose_change", change));
        next.base.objects = base.objects;
        next.store.setAiEnabled(next.company.id, true);
        const asking = next.assistant.send({ companyId: next.company.id, text: "?" });
        await answerCards(next.events, next.assistant, true);
        await asking;
        expect(resultOf(next.proxy.requests)).toMatchObject({ status: "done", action: change.action });
      }
      expect(base.objects.get(ref)).toMatchObject({
        fields: { Наименование: "ООО «Новое имя»" },
        deletionMark: true,
      });
    });

    it("refuses a confirmed change when the object was edited after the card was shown", async () => {
      const { assistant, store, company, events, proxy, base } = setup(
        proposeThenAnswer("propose_change", {
          action: "update",
          object: "Справочник.Контрагенты",
          ref: "22222222-2222-2222-2222-222222222222",
          fields: { Наименование: "B" },
        }),
      );
      base.objects.set("22222222-2222-2222-2222-222222222222", {
        object: "Справочник.Контрагенты",
        fields: { Наименование: "A" },
        posted: false,
        deletionMark: false,
        version: 1,
      });
      store.setAiEnabled(company.id, true);
      const sending = assistant.send({ companyId: company.id, text: "?" });
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          const card = events.find((e) => e.type === "confirm");
          if (card?.type === "confirm") {
            clearInterval(timer);
            base.objects.get("22222222-2222-2222-2222-222222222222")!.version = 2; // someone saved it in 1C meanwhile
            assistant.decide(card.companyId, card.id, true);
            resolve();
          }
        }, 1);
      });
      await sending;
      expect(resultOf(proxy.requests)).toMatchObject({ error: "CONFLICT" });
      expect(events.find((e) => e.type === "decided")).toMatchObject({
        outcome: { status: "failed", code: "CONFLICT" },
      });
      expect(base.objects.get("22222222-2222-2222-2222-222222222222")?.fields).toEqual({ Наименование: "A" });
    });

    it("prepares many changes on one card: 1C's refusals are left out, the rest written on one confirmation", async () => {
      const batch = {
        title: "Bank vypiskasi: 3 hujjat",
        changes: [
          {
            action: "create",
            object: "Справочник.Контрагенты",
            fields: { Наименование: "ООО «Бир»", ИНН: "305000001" },
          },
          {
            action: "update",
            object: "Справочник.Контрагенты",
            ref: "99999999-9999-9999-9999-999999999999",
            fields: { Наименование: "X" },
          },
          {
            action: "create",
            object: "Справочник.Контрагенты",
            fields: { Наименование: "ООО «Икки»", ИНН: "305000002" },
          },
        ],
      };
      const { assistant, store, company, events, proxy, base } = setup(
        proposeThenAnswer("propose_changes", batch),
      );
      store.setAiEnabled(company.id, true);
      const sending = assistant.send({ companyId: company.id, text: "Vypiskani 1C ga kirit" });
      await answerCards(events, assistant, true);
      expect(await sending).toEqual({ ok: true, data: null });

      const card = events.find((e) => e.type === "confirm");
      expect(card).toMatchObject({
        proposal: {
          kind: "batch",
          title: "Bank vypiskasi: 3 hujjat",
          items: [
            { action: "create", preview: { action: "create" }, error: null },
            { action: "update", preview: null, error: { code: "NOT_FOUND" } },
            { action: "create", preview: { action: "create" }, error: null },
          ],
        },
      });
      expect(events.filter((e) => e.type === "confirm")).toHaveLength(1);
      const names = [...base.objects.values()].map((o) => o.fields.Наименование);
      expect(names).toEqual(expect.arrayContaining(["ООО «Бир»", "ООО «Икки»"]));
      expect(events.find((e) => e.type === "decided")).toMatchObject({
        outcome: { status: "batch", results: [{ ok: true }, null, { ok: true }] },
      });
      expect(resultOf(proxy.requests)).toMatchObject({
        status: "done",
        applied: [{ n: 1 }, { n: 3 }],
        failed: [],
        refusedBefore: [{ n: 2, error: "NOT_FOUND" }],
      });
    });

    it("writes nothing from a batch the user cancels", async () => {
      const batch = {
        title: "2 ta kontragent",
        changes: [
          { action: "create", object: "Справочник.Контрагенты", fields: { Наименование: "A" } },
          { action: "create", object: "Справочник.Контрагенты", fields: { Наименование: "B" } },
        ],
      };
      const { assistant, store, company, events, proxy, base } = setup(
        proposeThenAnswer("propose_changes", batch),
      );
      store.setAiEnabled(company.id, true);
      const before = base.objects.size;
      const sending = assistant.send({ companyId: company.id, text: "?" });
      await answerCards(events, assistant, false);
      await sending;
      expect(base.objects.size).toBe(before);
      expect(resultOf(proxy.requests)).toEqual({ status: "declined_by_user" });
    });

    it("sends 1C's filling-check warnings back to the model to fix before the card is shown", async () => {
      const receipt = (fields: Record<string, unknown>) => ({
        title: "Vypiska",
        changes: [{ action: "create", object: "Документ.ПоступлениеНаРасчетныйСчет", fields }],
      });
      const propose = (id: string, input: unknown) => (): AiEvent[] => [
        {
          type: "message",
          stopReason: "tool_use",
          content: [{ type: "tool_use", id, name: "propose_changes", input }],
        },
      ];
      const { assistant, store, company, events, proxy, base } = setup([
        propose("p1", receipt({ СуммаДокумента: 1000 })),
        propose("p2", receipt({ СуммаДокумента: 1000, СуммаВзаиморасчетов: 1000 })),
        () => [{ type: "message", stopReason: "end_turn", content: [{ type: "text", text: "OK" }] }],
      ]);
      base.required["Документ.ПоступлениеНаРасчетныйСчет"] = ["СуммаВзаиморасчетов"];
      store.setAiEnabled(company.id, true);
      const sending = assistant.send({ companyId: company.id, text: "Vypiskani kirit" });
      await answerCards(events, assistant, true);
      expect(await sending).toEqual({ ok: true, data: null });

      const first = (proxy.requests[1]!.messages.at(-1)!.content as unknown as { content: string }[])[0]!;
      expect(JSON.parse(first.content)).toMatchObject({
        error: "FILL_CHECK",
        message: expect.stringContaining('#1: Поле "СуммаВзаиморасчетов" не заполнено'),
      });
      // Only the fixed proposal reached the accountant.
      const cards = events.filter((e) => e.type === "confirm");
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ proposal: { items: [{ preview: { warnings: [] } }] } });
    });

    it("shows a change with its warning when the model sends it again unchanged", async () => {
      const change = { action: "create", object: "Справочник.Контрагенты", fields: { Наименование: "A" } };
      const propose = (id: string) => (): AiEvent[] => [
        {
          type: "message",
          stopReason: "tool_use",
          content: [{ type: "tool_use", id, name: "propose_change", input: change }],
        },
      ];
      const { assistant, store, company, events, base } = setup([
        propose("p1"),
        propose("p2"),
        () => [{ type: "message", stopReason: "end_turn", content: [{ type: "text", text: "OK" }] }],
      ]);
      base.required["Справочник.Контрагенты"] = ["ИНН"];
      store.setAiEnabled(company.id, true);
      const sending = assistant.send({ companyId: company.id, text: "A ni qo'sh" });
      await answerCards(events, assistant, true);
      expect(await sending).toEqual({ ok: true, data: null });
      expect(events.find((e) => e.type === "confirm")).toMatchObject({
        proposal: { kind: "change", preview: { warnings: ['Поле "ИНН" не заполнено'] } },
      });
    });

    it("fills what a batch's documents share from its defaults, written once", async () => {
      const batch = {
        title: "Vypiska: 2 ta kirim",
        defaults: {
          action: "create",
          object: "Документ.ПоступлениеНаРасчетныйСчет",
          fields: { Организация: { name: "Org" }, ВидОперации: "ОплатаПокупателя" },
          rows: { РасшифровкаПлатежа: { КурсВзаиморасчетов: 1, КратностьВзаиморасчетов: 1 } },
          post: true,
        },
        changes: [
          { fields: { СуммаДокумента: 1000 }, tables: { РасшифровкаПлатежа: [{ СуммаПлатежа: 1000 }] } },
          { fields: { СуммаДокумента: 2000, ВидОперации: "Прочее" } },
          { action: "update", object: "Справочник.Контрагенты" }, // no ref: left out
        ],
      };
      const { assistant, store, company, events, base } = setup(proposeThenAnswer("propose_changes", batch));
      store.setAiEnabled(company.id, true);
      const sending = assistant.send({ companyId: company.id, text: "Vypiskani kirit" });
      await answerCards(events, assistant, true);
      await sending;
      const card = events.find((e) => e.type === "confirm");
      expect(card).toMatchObject({
        proposal: {
          kind: "batch",
          items: [
            { object: "Документ.ПоступлениеНаРасчетныйСчет", error: null },
            { object: "Документ.ПоступлениеНаРасчетныйСчет", error: null },
            { object: "Справочник.Контрагенты", error: { code: "VALIDATION" } },
          ],
        },
      });
      const written = [...base.objects.values()].filter(
        (o) => o.object === "Документ.ПоступлениеНаРасчетныйСчет",
      );
      expect(written.map((o) => o.fields)).toEqual([
        { Организация: { name: "Org" }, ВидОперации: "ОплатаПокупателя", СуммаДокумента: 1000 },
        { Организация: { name: "Org" }, ВидОперации: "Прочее", СуммаДокумента: 2000 },
      ]);
      expect(written.every((o) => o.posted)).toBe(true);
    });

    it("issues invoices for many sales on one card, leaving out sales already invoiced", async () => {
      const { assistant, store, company, events, proxy, base } = setup(
        proposeThenAnswer("propose_invoices_issued", {
          title: "Hisob-fakturalar: 3",
          sales: [
            { number: "0000-000123", date: "2026-10-01" },
            { number: "0000-000124", date: "2026-10-02" },
            { number: "0000-000125", date: "2026-10-03" },
          ],
        }),
      );
      const sale = (number: string, date: string) => ({
        ref: crypto.randomUUID(),
        number,
        date: `${date}T10:00:00`,
        counterparty: "ООО «Б»",
        amount: 500_000,
        posted: true,
      });
      base.sales.push(sale("0000-000124", "2026-10-02"), sale("0000-000125", "2026-10-03"));
      base.issued.push({
        ref: crypto.randomUUID(),
        number: "0000000099",
        date: "2026-10-04",
        saleRef: base.sales[2]!.ref,
      });
      store.setAiEnabled(company.id, true);
      const sending = assistant.send({ companyId: company.id, text: "Hammasiga schyot-faktura yoz" });
      await answerCards(events, assistant, true);
      await sending;

      expect(events.filter((e) => e.type === "confirm")).toHaveLength(1);
      expect(events.find((e) => e.type === "confirm")).toMatchObject({
        proposal: {
          kind: "batch",
          title: "Hisob-fakturalar: 3",
          items: [{ error: null }, { error: null }, { error: { code: "ALREADY_EXISTS" } }],
        },
      });
      expect(base.issued).toHaveLength(3);
      expect(resultOf(proxy.requests)).toMatchObject({
        status: "done",
        applied: [{ n: 1 }, { n: 2 }],
        refusedBefore: [{ n: 3, error: "ALREADY_EXISTS" }],
      });
    });

    it("records many suppliers' invoices on one card", async () => {
      const line = {
        item: { ikpu: "10202001001000000" },
        quantity: 1,
        price: 1000,
        amount: 1000,
        vatRate: 12,
        vatAmount: 120,
        total: 1120,
      };
      const invoices = ["45", "46"].map((number) => ({
        number,
        date: "2026-10-01",
        counterparty: { inn: "123456789" },
        lines: [line],
      }));
      const { assistant, store, company, events, base } = setup(
        proposeThenAnswer("propose_invoices_received", { title: "2 ta faktura", invoices }),
      );
      store.setAiEnabled(company.id, true);
      const sending = assistant.send({ companyId: company.id, text: "?" });
      await answerCards(events, assistant, true);
      await sending;
      expect(events.filter((e) => e.type === "confirm")).toHaveLength(1);
      expect(base.documents.map((d) => d.supplierNumber)).toEqual(["45", "46"]);
      expect(new Set(base.documents.map((d) => d.externalId)).size).toBe(2);
    });

    it("checks changes in 1C without a card when asked for a dry run", async () => {
      const { assistant, store, company, events, proxy, base } = setup(
        proposeThenAnswer("check_changes", {
          defaults: { action: "create", object: "Справочник.Контрагенты" },
          changes: [{ fields: { Наименование: "A" } }, { fields: { Наименование: "B", ИНН: "305000001" } }],
        }),
      );
      base.required["Справочник.Контрагенты"] = ["ИНН"];
      store.setAiEnabled(company.id, true);
      await assistant.send({ companyId: company.id, text: "?" });
      expect(events.filter((e) => e.type === "confirm")).toHaveLength(0);
      expect(base.objects.size).toBe(0);
      expect(resultOf(proxy.requests)).toMatchObject({
        results: [
          { n: 1, ok: false, warnings: ['Поле "ИНН" не заполнено'] },
          { n: 2, ok: true, warnings: [] },
        ],
      });
    });

    it("prepares nothing while the license is read-only", async () => {
      const { assistant, store, company, events, proxy, base } = setup(
        proposeThenAnswer("propose_invoice_issued", { sale: { number: "0000-000123", date: "2026-10-01" } }),
        "read_only",
      );
      store.setAiEnabled(company.id, true);
      await assistant.send({ companyId: company.id, text: "?" });
      expect(events.some((e) => e.type === "confirm")).toBe(false);
      expect(base.issued).toHaveLength(0);
      expect(resultOf(proxy.requests)).toMatchObject({ error: "READ_ONLY" });
    });

    it("cancels a waiting card when the user presses Stop", async () => {
      const { assistant, store, company, events, base } = setup(
        proposeThenAnswer("propose_invoice_issued", { sale: { number: "0000-000123", date: "2026-10-01" } }),
      );
      store.setAiEnabled(company.id, true);
      const sending = assistant.send({ companyId: company.id, text: "?" });
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (events.some((e) => e.type === "confirm")) {
            clearInterval(timer);
            assistant.stop(company.id);
            resolve();
          }
        }, 1);
      });
      expect(await sending).toMatchObject({ code: "AI_ABORTED" });
      expect(base.issued).toHaveLength(0);
    });
  });
  it("tells the model before its last step to answer with what it found, instead of failing", async () => {
    const query = (i: number) => (): AiEvent[] => [
      {
        type: "message",
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: `tu_${i}`, name: "list_organizations", input: {} }],
      },
    ];
    const answer = (): AiEvent[] => [
      { type: "text", text: "Topilganlari: …; tekshirilmagan: …" },
      { type: "message", stopReason: "end_turn", content: [{ type: "text", text: "Topilganlari" }] },
    ];
    const { assistant, store, company, proxy } = setup([
      ...Array.from({ length: 24 }, (_, i) => query(i)),
      answer,
    ]);
    store.setAiEnabled(company.id, true);
    expect(await assistant.send({ companyId: company.id, text: "Bank vypiskasini solishtir" })).toEqual({
      ok: true,
      data: null,
    });
    expect(proxy.requests).toHaveLength(25);
    const lastStep = proxy.requests[24]!.messages.at(-1)!.content as { type: string; text?: string }[];
    expect(lastStep.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("last step") });
    // Earlier steps carry no such note.
    const earlier = proxy.requests[23]!.messages.at(-1)!.content as { type: string }[];
    expect(earlier.every((block) => block.type === "tool_result")).toBe(true);
  });

  it("says how long it worked on a task, leaving out the time a card waited for the user", async () => {
    const { assistant, store, company, events } = setup([
      () => [
        {
          type: "message",
          stopReason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "p1",
              name: "propose_change",
              input: { action: "create", object: "Справочник.Контрагенты", fields: { Наименование: "A" } },
            },
          ],
        },
      ],
      () => [{ type: "message", stopReason: "end_turn", content: [{ type: "text", text: "OK" }] }],
    ]);
    store.setAiEnabled(company.id, true);
    const sending = assistant.send({ companyId: company.id, text: "A ni qo'sh" });
    // The accountant takes 300 ms to answer the card.
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const card = events.find((e) => e.type === "confirm");
        if (card?.type !== "confirm") return;
        clearInterval(timer);
        setTimeout(() => {
          assistant.decide(card.companyId, card.id, false);
          resolve();
        }, 300);
      }, 1);
    });
    await sending;
    const types = events.map((e) => e.type);
    expect(types.slice(-2)).toEqual(["done", "elapsed"]);
    const elapsed = events.at(-1);
    expect(elapsed?.type === "elapsed" && elapsed.ms).toBeLessThan(250);
  });

  describe("audit", () => {
    const toolTurn = (id: string, name: string, input: unknown) => (): AiEvent[] => [
      { type: "message", stopReason: "tool_use", content: [{ type: "tool_use", id, name, input }] },
    ];
    const answer = (text: string) => (): AiEvent[] => [
      { type: "text", text },
      { type: "message", stopReason: "end_turn", content: [{ type: "text", text }] },
    ];
    const AUDIT = {
      companyId: "",
      chatId: "0b8e3a52-1d3c-4a8e-9f5e-2b1c3d4e5f60",
      from: "2026-01-01",
      to: "2026-10-06",
      language: "ru" as const,
    };

    it("runs every check on its own, reads 1C only, then writes the report in a new chat", async () => {
      const { assistant, store, company, events, proxy, base, chats } = setup([
        toolTurn("q1", "run_query", { query: "ВЫБРАТЬ 1" }),
        toolTurn("r1", "report_findings", {
          status: "issues",
          summary: "Касса уходила в минус 2 дня",
          findings: [
            { severity: "high", title: "Минус в кассе 12.03.2026", amount: -1500000.5, date: "2026-03-12" },
          ],
        }),
        toolTurn("r2", "report_findings", { status: "not_applicable", summary: "Импорта не было" }),
        answer("Итог аудита: главное — минус в кассе."),
      ]);
      store.setAiEnabled(company.id, true);
      expect(await assistant.audit({ ...AUDIT, companyId: company.id })).toEqual({ ok: true, data: null });

      // Each check is its own short conversation, with the read tools and report_findings only.
      expect(proxy.requests.slice(0, 3).map((r) => r.tools)).toEqual([AUDIT_TOOLS, AUDIT_TOOLS, AUDIT_TOOLS]);
      expect(proxy.requests[0]!.messages).toHaveLength(1);
      expect(proxy.requests[0]!.messages[0]!.content).toContain("Find days with a negative balance on 50xx.");
      expect(proxy.requests[0]!.messages[0]!.content).toContain("in Russian");
      expect(proxy.requests[2]!.messages).toHaveLength(1);
      expect(base.calls.filter((c) => c.fn === "RunQuery")).toHaveLength(1);

      // The report is written in the chat from the checks' results, with the chat's tools.
      const report = proxy.requests[3]!;
      expect(report.tools).toEqual(CHAT_TOOLS);
      expect(report.messages[0]!.content).toContain("Минус в кассе 12.03.2026");

      const last = events.filter((e) => e.type === "audit").at(-1);
      expect(last).toMatchObject({
        audit: {
          finished: true,
          checks: [
            {
              title: "Отрицательный остаток кассы",
              section: "Касса и банк",
              status: "issues",
              findings: [{ severity: "high" }],
            },
            { title: "Импорт и ГТД", status: "not_applicable", findings: [] },
          ],
        },
      });
      expect(events.map((e) => e.type).slice(-2)).toEqual(["done", "elapsed"]);

      const saved = chats.load(company.id, AUDIT.chatId)!;
      expect(saved.title).toBe("Аудит 01.01.2026–06.10.2026");
      expect(saved.entries.map((e) => e.kind)).toEqual(["audit", "assistant", "elapsed"]);

      const csv = assistant.auditCsv(company.id, AUDIT.chatId);
      expect(csv).toMatchObject({ ok: true, data: { name: "Аудит 01.01.2026–06.10.2026.csv" } });
    });

    it("asks a check that answers in words to report, then keeps its words as the result", async () => {
      const { assistant, store, company, events } = setup([
        answer("Всё хорошо, наверное."),
        answer("Я уже сказал."),
        toolTurn("r2", "report_findings", { status: "ok", summary: "Всё в порядке" }),
        answer("Итог."),
      ]);
      store.setAiEnabled(company.id, true);
      await assistant.audit({ ...AUDIT, companyId: company.id });
      const last = events.filter((e) => e.type === "audit").at(-1);
      expect(last).toMatchObject({
        audit: { checks: [{ status: "failed", summary: "Я уже сказал." }, { status: "ok" }] },
      });
    });

    it("never lets a chat call report_findings, and never lets a check change 1C", async () => {
      const { assistant, store, company, proxy } = setup([
        toolTurn("x", "propose_change", {
          action: "delete",
          object: "Справочник.Контрагенты",
          ref: "22222222-2222-2222-2222-222222222222",
        }),
        toolTurn("r1", "report_findings", { status: "ok", summary: "OK" }),
        toolTurn("r2", "report_findings", { status: "ok", summary: "OK" }),
        answer("Итог."),
      ]);
      store.setAiEnabled(company.id, true);
      await assistant.audit({ ...AUDIT, companyId: company.id });
      const refused = proxy.requests[1]!.messages[2]!.content as unknown as { content: string }[];
      expect(JSON.parse(refused[0]!.content)).toMatchObject({ error: "UNKNOWN_TOOL" });
    });

    it("saves the findings as a CSV that Excel opens", () => {
      const csv = auditToCsv({
        from: "2026-01-01",
        to: "2026-10-06",
        language: "ru",
        finished: true,
        checks: [
          {
            id: "a",
            section: "Касса и банк",
            title: "Минус в кассе",
            status: "issues",
            summary: "2 дня",
            findings: [{ severity: "high", title: 'Минус "12.03"', detail: "", amount: -1500000.5 }],
          },
          { id: "b", section: "Импорт", title: "ГТД", status: "ok", summary: "В порядке" },
        ],
      });
      expect(csv.startsWith("\uFEFF")).toBe(true);
      const lines = csv.slice(1).trimEnd().split("\r\n");
      expect(lines[0]).toBe(
        '"Раздел";"Проверка";"Итог";"Важность";"Проблема";"Подробности";"Сумма";"Дата";"Контрагент";"Документ"',
      );
      expect(lines[1]).toBe(
        '"Касса и банк";"Минус в кассе";"Есть проблемы";"Высокая";"Минус ""12.03""";"";"-1500000,5";"";"";""',
      );
      expect(lines[2]).toBe('"Импорт";"ГТД";"В порядке";"";"В порядке";"";"";"";"";""');
    });
  });

  describe("speed and reliability", () => {
    const answer = (text: string) => (): AiEvent[] => [
      { type: "text", text },
      { type: "message", stopReason: "end_turn", content: [{ type: "text", text }] },
    ];
    const serverDown = () => new Response("<html>502 Bad Gateway</html>", { status: 502 });

    it("tries a step again when the server is restarting, and takes back what the failed try showed", async () => {
      // The connection drops after the answer has begun: the "Bal" it showed must be taken back.
      const cutOff = (): Response => {
        let sent = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent) return controller.error(new Error("socket hang up"));
              sent = true;
              controller.enqueue(
                new TextEncoder().encode(`${JSON.stringify({ type: "text", text: "Bal" })}\n`),
              );
            },
          }),
          { headers: { "content-type": "application/x-ndjson" } },
        );
      };
      const { assistant, store, company, events, proxy } = setup([
        serverDown,
        cutOff,
        answer("Balans: 125 mln"),
      ]);
      store.setAiEnabled(company.id, true);
      expect(await assistant.send({ companyId: company.id, text: "5110?" })).toEqual({
        ok: true,
        data: null,
      });
      expect(proxy.requests).toHaveLength(3);
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(events.filter((e) => e.type === "retry")).toHaveLength(1);
      // The chat shows the answer once, without the cut-off "Bal".
      const [saved] = assistant.chats(company.id);
      const opened = assistant.openChat(company.id, saved!.id);
      expect(opened.ok && opened.data.entries.map((e) => e.kind)).toEqual(["user", "assistant", "elapsed"]);
      expect(opened.ok && opened.data.entries[1]).toEqual({ kind: "assistant", text: "Balans: 125 mln" });
    });

    it("gives up after a few tries and says so", async () => {
      const { assistant, store, company, proxy } = setup([serverDown, serverDown, serverDown, serverDown]);
      store.setAiEnabled(company.id, true);
      expect(await assistant.send({ companyId: company.id, text: "?" })).toMatchObject({
        ok: false,
        code: "SERVER_ERROR",
      });
      expect(proxy.requests).toHaveLength(4);
    });

    it("does not retry what a retry cannot fix", async () => {
      const limit = () =>
        new Response(JSON.stringify({ code: "AI_DAILY_LIMIT", message: "limit" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      const { assistant, store, company, proxy } = setup([limit]);
      store.setAiEnabled(company.id, true);
      expect(await assistant.send({ companyId: company.id, text: "?" })).toMatchObject({
        code: "AI_DAILY_LIMIT",
      });
      expect(proxy.requests).toHaveLength(1);
    });

    it("shows the model's progress notes, and ignores the server's pings", async () => {
      const { assistant, store, company, events } = setup([
        () => [
          { type: "progress", text: "Sentyabr bank " },
          { type: "ping" },
          { type: "progress", text: "hujjatlarini tekshiryapman" },
          { type: "text", text: "Hammasi mos." },
          { type: "message", stopReason: "end_turn", content: [{ type: "text", text: "Hammasi mos." }] },
        ],
      ]);
      store.setAiEnabled(company.id, true);
      await assistant.send({ companyId: company.id, text: "Tekshir" });
      expect(events.filter((e) => e.type === "progress")).toHaveLength(2);
      const [saved] = assistant.chats(company.id);
      const opened = assistant.openChat(company.id, saved!.id);
      expect(opened.ok && opened.data.entries).toEqual([
        { kind: "user", text: "Tekshir" },
        { kind: "note", text: "Sentyabr bank hujjatlarini tekshiryapman" },
        { kind: "assistant", text: "Hammasi mos." },
        { kind: "elapsed", ms: expect.any(Number) },
      ]);
    });

    it("sends a large chat gzipped", async () => {
      const { assistant, store, company, proxy } = setup([answer("ok"), answer("ok")]);
      store.setAiEnabled(company.id, true);
      await assistant.send({ companyId: company.id, text: "qisqa" });
      await assistant.send({ companyId: company.id, text: "x".repeat(3000) });
      expect(proxy.encodings).toEqual([undefined, undefined]);
      const big = new TextEncoder().encode("Сумма;".repeat(5000));
      const more = setup([answer("ok")]);
      more.store.setAiEnabled(more.company.id, true);
      await more.assistant.send({
        companyId: more.company.id,
        text: "?",
        files: [{ name: "a.txt", data: big }],
      });
      expect(more.proxy.encodings).toEqual(["gzip"]);
      expect(JSON.stringify(more.proxy.requests[0])).toContain("Сумма;Сумма;");
    });
  });

  describe("files and saved chats", () => {
    const answer = (text: string) => (): AiEvent[] => [
      { type: "text", text },
      { type: "message", stopReason: "end_turn", content: [{ type: "text", text }] },
    ];

    it("sends attached files with the question and shows them by name", async () => {
      const { assistant, store, company, proxy, chats } = setup([answer("Jami 1 750 000,5 so'm.")]);
      store.setAiEnabled(company.id, true);
      const csv = new TextEncoder().encode("Контрагент;Сумма\nООО Тест;1500000");
      const pdf = new TextEncoder().encode("%PDF-1.7 invoice");
      const result = await assistant.send({
        companyId: company.id,
        text: "Shu fayllarni tekshir",
        files: [
          { name: "oborot.csv", data: csv },
          { name: "invoice.pdf", data: pdf },
        ],
      });
      expect(result).toEqual({ ok: true, data: null });
      expect(proxy.requests[0]!.messages[0]).toEqual({
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "text",
              media_type: "text/plain",
              data: "### oborot.csv (2 rows, columns A–B)\nrow\tA\tB\n1\tКонтрагент\tСумма\n2\tООО Тест\t1500000",
            },
            title: "oborot.csv",
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: Buffer.from(pdf).toString("base64"),
            },
            title: "invoice.pdf",
          },
          { type: "text", text: "Shu fayllarni tekshir" },
        ],
      });
      const [saved] = chats.list(company.id);
      expect(assistant.openChat(company.id, saved!.id)).toMatchObject({
        ok: true,
        data: {
          title: "Shu fayllarni tekshir",
          entries: [
            {
              kind: "user",
              text: "Shu fayllarni tekshir",
              files: [
                { name: "oborot.csv", kind: "text", size: csv.byteLength },
                { name: "invoice.pdf", kind: "pdf", size: pdf.byteLength },
              ],
            },
            { kind: "assistant", text: "Jami 1 750 000,5 so'm." },
            { kind: "elapsed" },
          ],
        },
      });
    });

    it("sends a large statement as a summary, and totals the whole file on the PC when asked", async () => {
      const lines = ["Сана;Контрагент;Сумма"];
      for (let i = 0; i < 3000; i++) {
        const month = (i % 3) + 1;
        lines.push(`${String((i % 28) + 1).padStart(2, "0")}.0${month}.2026;ООО Контрагент ${i};1 000,50`);
      }
      const csv = new TextEncoder().encode(lines.join("\n"));
      const { assistant, store, company, proxy, events } = setup([
        () => [
          {
            type: "message",
            stopReason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: "tu_f",
                name: "read_attachment",
                input: { file: "vypiska.csv", group_by: { column: "A", by: "month" }, sum: ["C"], from: 2 },
              },
            ],
          },
        ],
        () => [{ type: "message", stopReason: "end_turn", content: [{ type: "text", text: "Mos." }] }],
      ]);
      store.setAiEnabled(company.id, true);
      await assistant.send({
        companyId: company.id,
        text: "Solishtir",
        files: [{ name: "vypiska.csv", data: csv }],
      });
      const sent = (proxy.requests[0]!.messages[0]!.content as { source?: { data: string } }[])[0]!.source!
        .data;
      expect(sent).toContain("This file is large (3001 rows)");
      expect(sent).toContain("read_attachment");
      expect(sent.length).toBeLessThan(10_000);
      expect(sent).toContain("3001\t"); // the last row is shown too

      const result = (proxy.requests[1]!.messages.at(-1)!.content as unknown as { content: string }[])[0]!;
      expect(JSON.parse(result.content)).toMatchObject({
        matchedRows: 3000,
        groups: [
          ["2026-01", 1000, 1000500],
          ["2026-02", 1000, 1000500],
          ["2026-03", 1000, 1000500],
        ],
      });
      expect(events.find((e) => e.type === "tool")).toMatchObject({
        name: "read_attachment",
        detail: "vypiska.csv · by A (month) · sum C · rows 2–end",
      });
    });

    it("refuses a file it cannot read before asking the AI", async () => {
      const { assistant, store, company, proxy, events } = setup([]);
      store.setAiEnabled(company.id, true);
      const result = await assistant.send({
        companyId: company.id,
        text: "",
        files: [{ name: "old.xls", data: new Uint8Array([1, 2, 3]) }],
      });
      expect(result).toMatchObject({ ok: false, code: "FILE_TYPE" });
      expect(events.at(-1)).toMatchObject({ type: "error", code: "FILE_TYPE" });
      expect(proxy.requests).toHaveLength(0);
    });

    it("saves chats on this PC through SecretBox, and continues a reopened one after a restart", async () => {
      const first = setup([answer("125 mln so'm."), answer("Yangi suhbat."), answer("Ha, 5110 bo'yicha.")]);
      const { store, company, proxy, chats, dir } = first;
      store.setAiEnabled(company.id, true);
      const chatId = "0b7f5b8e-6a0e-4a8f-8a3c-3f0d9c2d1e55";
      await first.assistant.send({ companyId: company.id, chatId, text: "5110 qoldig'i?" });
      await first.assistant.send({
        companyId: company.id,
        chatId: "9a1d3c5e-7b2f-4c6a-8e0d-1f3b5d7a9c2e",
        text: "Boshqa savol",
      });
      // A new chat starts from nothing.
      expect(proxy.requests[1]!.messages).toHaveLength(1);
      expect(chats.list(company.id).map((c) => c.title)).toEqual(["Boshqa savol", "5110 qoldig'i?"]);
      // Through SecretBox, like the 1C passwords (here the stand-in only marks it).
      for (const file of readdirSync(join(dir, "chats", company.id))) {
        expect(readFileSync(join(dir, "chats", company.id, file), "utf8")).toMatch(/^enc:/);
      }

      // After a restart: a new service over the same files.
      const events: AssistantEvent[] = [];
      const reopened = new AssistantService({
        store,
        chats: new ChatStore(join(dir, "chats"), secrets),
        session: first.session,
        connector: new InProcessConnector(() => first.base),
        emit: (e) => events.push(e),
      });
      expect(reopened.openChat(company.id, chatId)).toMatchObject({
        ok: true,
        data: {
          entries: [{ kind: "user" }, { kind: "assistant", text: "125 mln so'm." }, { kind: "elapsed" }],
        },
      });
      await reopened.send({ companyId: company.id, text: "Aniqroq?" });
      expect(proxy.requests[2]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
      expect(proxy.requests[2]!.messages[0]!.content).toBe("5110 qoldig'i?");

      expect(reopened.deleteChat(company.id, chatId)).toEqual({ ok: true, data: null });
      expect(chats.list(company.id).map((c) => c.title)).toEqual(["Boshqa savol"]);
      expect(reopened.openChat(company.id, chatId)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });

    it("reopens a chat cut off by closing the app: the card is cancelled and the tool call answered", async () => {
      const { assistant, store, company, proxy, chats } = setup([answer("Mayli.")]);
      store.setAiEnabled(company.id, true);
      const chatId = "3c2b1a09-8f7e-4d6c-9b5a-4e3d2c1b0a99";
      const now = new Date().toISOString();
      const sale = {
        ref: "r",
        number: "1",
        date: "2026-10-01",
        organization: null,
        counterparty: null,
        amount: 1,
        posted: true,
      };
      chats.save({
        id: chatId,
        companyId: company.id,
        title: "Schyot-faktura",
        createdAt: now,
        updatedAt: now,
        messages: [
          { role: "user", content: "Schyot-faktura yoz" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tu_9",
                name: "propose_invoice_issued",
                input: { sale: { number: "1" } },
              },
            ],
          },
        ],
        entries: [
          { kind: "user", text: "Schyot-faktura yoz" },
          { kind: "proposal", id: "p1", proposal: { kind: "invoice_issued", sale }, outcome: null },
        ],
      });
      const opened = assistant.openChat(company.id, chatId);
      expect(opened.ok && opened.data.entries[1]).toMatchObject({ outcome: { status: "declined" } });
      await assistant.send({ companyId: company.id, chatId, text: "Keyinroq" });
      const sent = proxy.requests[0]!.messages;
      expect(sent[2]).toMatchObject({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_9", is_error: true }],
      });
      expect(sent[3]).toEqual({ role: "user", content: "Keyinroq" });
    });
  });
  describe("cost engine", () => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const none = () => new Response(null, { status: 204 });
    const text = (value: string) => (): AiEvent[] => [
      { type: "text", text: value },
      { type: "message", stopReason: "end_turn", content: [{ type: "text", text: value }] },
    ];
    const balances: QueryTemplateView = {
      id: "t1",
      code: "balances",
      title: "Остатки по счетам",
      intents: ["остатки по счетам", "qoldiqlar hisoblar bo'yicha"],
      query: "ВЫБРАТЬ Счет, СальдоДт, СальдоКт ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки(&Дата)",
      params: [{ name: "Дата", type: "date" }],
      columns: [
        { label: "Счет", format: "text" },
        { label: "Дт", format: "money" },
        { label: "Кт", format: "money" },
      ],
      totals: false,
      enabled: true,
      version: 1,
      updatedAt: "2026-10-07T00:00:00Z",
      source: "admin",
      company: null,
      accountName: null,
      hits: 0,
      rejected: 0,
    };
    /** The server's cost engine endpoints, with what each test needs different. */
    const server =
      (over: {
        policy?: Partial<typeof DEFAULT_AI_POLICY>;
        templates?: QueryTemplateView[];
        cached?: (body: { question: string; dataVersion: string }) => unknown;
        digestFound?: boolean;
      }) =>
      (url: string, _method: string, body: unknown) => {
        if (url === "/v1/ai/policy") return json({ ...DEFAULT_AI_POLICY, ...over.policy });
        if (url === "/v1/ai/templates") return json(over.templates ?? []);
        if (url === "/v1/ai/answers/lookup")
          return json(over.cached?.(body as { question: string; dataVersion: string }) ?? { hit: false });
        if (url.startsWith("/v1/ai/digest?")) return json({ found: over.digestFound ?? true });
        if (url === "/v1/ai/templates/learn") return json({ created: false });
        if (url === "/v1/ai/templates/reject") return none();
        if (url === "/v1/ai/answers" || url === "/v1/ai/free" || url === "/v1/ai/digest") return none();
        return null;
      };
    const ask = async (setupResult: ReturnType<typeof setup>, question: string, extra = {}) => {
      setupResult.store.setAiEnabled(setupResult.company.id, true);
      return setupResult.assistant.send({ companyId: setupResult.company.id, text: question, ...extra });
    };

    it("answers a known question from a template: no model call, labelled, and counted as free", async () => {
      const t = setup([], "active", server({ templates: [balances] }));
      expect(await ask(t, "Остатки по счетам")).toEqual({ ok: true, data: null });
      // The model was never asked.
      expect(t.proxy.requests).toHaveLength(0);
      expect(t.events.map((e) => e.type)).toEqual(["route", "text", "done", "elapsed"]);
      expect(t.events[0]).toMatchObject({ type: "route", route: "template", title: "Остатки по счетам" });
      const shown = (t.events[1] as { text: string }).text;
      expect(shown).toContain("| Счет | Дт | Кт |");
      expect(shown).toContain("5110 Расчетный счет");
      // The server counts it, so the dashboard's free-answer share is right.
      expect(t.proxy.calls.find((c) => c.url === "/v1/ai/free")?.body).toEqual({
        route: "template",
        company: t.company.name,
        question: "Остатки по счетам",
      });
      // Later questions of the chat see it as the assistant's answer.
      const chat = t.assistant.openChat(t.company.id, t.assistant.chats(t.company.id)[0]!.id);
      expect(chat.ok && chat.data.entries.map((e) => e.kind)).toEqual([
        "user",
        "route",
        "assistant",
        "elapsed",
      ]);
    });

    it("lets the user ask the model anyway, and leaves a longer question to the model from the start", async () => {
      const t = setup([text("Model answer")], "active", server({ templates: [balances] }));
      await ask(t, "Остатки по счетам", { skipFree: true });
      expect(t.proxy.requests).toHaveLength(1);
      expect(t.events.some((e) => e.type === "route")).toBe(false);

      const longer = setup([text("Model answer")], "active", server({ templates: [balances] }));
      await ask(longer, "Остатки по счетам без учета валютных операций");
      expect(longer.proxy.requests).toHaveLength(1);
    });

    it("falls back to the model when the template's query fails", async () => {
      const broken = { ...balances, query: "УДАЛИТЬ" };
      const t = setup([text("Model answer")], "active", server({ templates: [broken] }));
      await ask(t, "Остатки по счетам");
      expect(t.proxy.requests).toHaveLength(1);
      expect(t.events.some((e) => e.type === "route")).toBe(false);
    });

    it("does not use templates when the policy turns them off", async () => {
      const t = setup(
        [text("Model answer")],
        "active",
        server({ templates: [balances], policy: { templates: false } }),
      );
      // The server sends none then; the app also ignores a stale list.
      await ask(t, "Остатки по счетам");
      expect(t.proxy.requests).toHaveLength(1);
    });

    it("answers a repeated question from the answer cache, keyed by the question and the data version", async () => {
      let seen: { question: string; dataVersion: string } | null = null;
      const t = setup(
        [],
        "active",
        server({
          cached: (body) => {
            seen = body;
            return { hit: true, answer: "125 mln so'm.", ageSeconds: 180 };
          },
        }),
      );
      await ask(t, "5110 qoldig'i qancha?");
      expect(t.proxy.requests).toHaveLength(0);
      expect(t.events[0]).toMatchObject({ type: "route", route: "cache", ageSeconds: 180 });
      expect(t.events[1]).toMatchObject({ type: "text", text: "125 mln so'm." });
      expect(seen).toMatchObject({
        question: "5110 qoldig'i qancha?",
        dataVersion: expect.stringMatching(/^\d{4}-\d{2}-\d{2}:/),
      });
      expect(t.proxy.calls.find((c) => c.url === "/v1/ai/free")?.body).toMatchObject({ route: "cache" });
    });

    it("keeps the finished answer of a read-only first question, and nothing else", async () => {
      const t = setup([text("125 mln so'm."), text("Yana"), text("Fayldan")], "active", server({}));
      await ask(t, "5110 qoldig'i qancha?");
      await vi.waitFor(() => expect(t.proxy.calls.filter((c) => c.url === "/v1/ai/answers")).toHaveLength(1));
      expect(t.proxy.calls.find((c) => c.url === "/v1/ai/answers")?.body).toMatchObject({
        company: t.company.name,
        question: "5110 qoldig'i qancha?",
        answer: "125 mln so'm.",
      });
      // A follow-up depends on the chat before it: it is not kept.
      await t.assistant.send({ companyId: t.company.id, text: "6010 chi?" });
      expect(t.proxy.calls.filter((c) => c.url === "/v1/ai/answers")).toHaveLength(1);
    });

    it("keeps no answer that prepared a card, and drops stored answers after a write", async () => {
      const t = setup(
        [
          () => [
            {
              type: "message",
              stopReason: "tool_use",
              content: [
                {
                  type: "tool_use",
                  id: "p1",
                  name: "propose_invoice_issued",
                  input: { sale: { number: "0000-000123", date: "2026-10-01" } },
                },
              ],
            },
          ],
          text("Tayyor"),
        ],
        "active",
        server({}),
      );
      t.store.setAiEnabled(t.company.id, true);
      const sending = t.assistant.send({ companyId: t.company.id, text: "Schyot-faktura yoz" });
      await vi.waitFor(() => expect(t.events.some((e) => e.type === "confirm")).toBe(true));
      const card = t.events.find((e) => e.type === "confirm");
      if (card?.type !== "confirm") throw new Error("no card");
      const before = t.proxy.calls.length;
      t.assistant.decide(card.companyId, card.id, true);
      await sending;
      expect(t.proxy.calls.slice(before).some((c) => c.url === "/v1/ai/answers")).toBe(false);
    });

    it("changes the data version with every write, so a stored answer is not used after one", () => {
      const engine = new CostEngine({} as never, {} as never);
      const first = engine.dataVersion("c1");
      expect(engine.dataVersion("c1")).toBe(first);
      engine.noteWrite("c1");
      expect(engine.dataVersion("c1")).not.toBe(first);
      expect(engine.dataVersion("c2")).toBe(first);
    });

    it("limits the rows of a query from the policy, and tells the model when the result was cut", async () => {
      const t = setup(
        [
          () => [
            {
              type: "message",
              stopReason: "tool_use",
              content: [
                {
                  type: "tool_use",
                  id: "q1",
                  name: "run_query",
                  input: { query: "ВЫБРАТЬ Счет ИЗ РегистрБухгалтерии.Хозрасчетный" },
                },
                {
                  type: "tool_use",
                  id: "q2",
                  name: "run_query",
                  input: { query: "ВЫБРАТЬ Счет ИЗ РегистрБухгалтерии.Хозрасчетный", limit: 1000 },
                },
              ],
            },
          ],
          text("Done"),
        ],
        "active",
        server({ policy: { defaultRows: 2, maxRows: 3 } }),
      );
      await ask(t, "Hisoblarni ko'rsat");
      const results = (t.proxy.requests[1]!.messages[2]!.content as unknown as { content: string }[]).map(
        (r) => r.content,
      );
      // No limit asked: the default (2 rows). Asked for 1000: the hard cap (3 rows).
      expect(results[0]!.split("\n").filter((l) => l.startsWith("  "))).toHaveLength(2);
      expect(results[0]).toContain("The result was cut at 2 rows");
      expect(results[1]!.split("\n").filter((l) => l.startsWith("  "))).toHaveLength(3);
      expect(results[1]).toContain("up to 3");
    });

    it("limits the rows of an audit check's query the same way", async () => {
      const t = setup(
        [
          () => [
            {
              type: "message",
              stopReason: "tool_use",
              content: [
                {
                  type: "tool_use",
                  id: "q1",
                  name: "run_query",
                  input: { query: "ВЫБРАТЬ Счет ИЗ РегистрБухгалтерии.Хозрасчетный" },
                },
              ],
            },
          ],
          () => [
            {
              type: "message",
              stopReason: "tool_use",
              content: [
                {
                  type: "tool_use",
                  id: "r1",
                  name: "report_findings",
                  input: { status: "ok", summary: "Fine" },
                },
              ],
            },
          ],
          text("Report"),
        ],
        "active",
        server({ policy: { defaultRows: 1 } }),
      );
      t.store.setAiEnabled(t.company.id, true);
      await t.assistant.audit({
        companyId: t.company.id,
        chatId: "0b8e3a52-1d3c-4a8e-9f5e-2b1c3d4e5f60",
        from: "2026-01-01",
        to: "2026-10-06",
        language: "en",
      });
      const result = (t.proxy.requests[1]!.messages[2]!.content as unknown as { content: string }[])[0]!
        .content;
      expect(result).toContain("rows[1]{Счет,СальдоДт,СальдоКт}:");
    });

    it("shows a budget warning from the server and goes on with the answer", async () => {
      const t = setup(
        [
          () => [
            { type: "warning", code: "AI_BUDGET_WARNING", message: "80% used" },
            { type: "text", text: "Javob" },
            { type: "message", stopReason: "end_turn", content: [{ type: "text", text: "Javob" }] },
          ],
        ],
        "active",
        server({}),
      );
      expect(await ask(t, "5110?")).toEqual({ ok: true, data: null });
      expect(t.events.map((e) => e.type)).toEqual(["notice", "text", "done", "elapsed"]);
      expect(t.events[0]).toMatchObject({ code: "AI_BUDGET_WARNING" });
    });

    it("works as before with a server that has none of these endpoints: the defaults apply", async () => {
      const t = setup([
        () => [
          {
            type: "message",
            stopReason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: "q1",
                name: "run_query",
                input: { query: "ВЫБРАТЬ Счет ИЗ РегистрБухгалтерии.Хозрасчетный" },
              },
            ],
          },
        ],
        text("Done"),
      ]);
      expect(await ask(t, "Hisoblarni ko'rsat")).toEqual({ ok: true, data: null });
      expect(t.proxy.requests).toHaveLength(2);
      const result = (t.proxy.requests[1]!.messages[2]!.content as unknown as { content: string }[])[0]!
        .content;
      expect(result).toContain("rows[4]{");
    });

    it("builds the structure digest of the base once, after the first answer, and sends it to the server", async () => {
      const t = setup([text("Javob"), text("Yana")], "active", server({ digestFound: false }));
      t.base.queryAnswers.unshift(
        {
          match: /ИдентификаторыОбъектовМетаданных.*"Документ\.%"/s,
          answer: () => ({
            columns: ["Имя"],
            rows: [["Документ.РеализацияТоваровУслуг"], ["Документ.ПоступлениеТоваровУслуг"]],
            truncated: false,
          }),
        },
        {
          match: /ИдентификаторыОбъектовМетаданных.*"Справочник\.%"/s,
          answer: () => ({ columns: ["Имя"], rows: [["Справочник.Контрагенты"]], truncated: false }),
        },
      );
      await ask(t, "5110?");
      await vi.waitFor(() =>
        expect(t.proxy.calls.some((c) => c.method === "PUT" && c.url === "/v1/ai/digest")).toBe(true),
      );
      const put = t.proxy.calls.find((c) => c.method === "PUT")?.body as {
        company: string;
        configName: string;
        digest: string;
        tokenCount: number;
      };
      expect(put.company).toBe(t.company.name);
      expect(put.configName).toEqual(expect.any(String));
      expect(put.digest).toContain("Documents (2): РеализацияТоваровУслуг, ПоступлениеТоваровУслуг");
      expect(put.digest).toContain("Catalogs (1): Контрагенты");
      expect(put.tokenCount).toBeGreaterThan(0);
      // Once per run of the app per company.
      await t.assistant.send({ companyId: t.company.id, text: "6010?" });
      await new Promise((r) => setTimeout(r, 20));
      expect(t.proxy.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    });

    it("sends nothing when the server already has the digest of this configuration", async () => {
      const t = setup([text("Javob")], "active", server({ digestFound: true }));
      await ask(t, "5110?");
      await vi.waitFor(() =>
        expect(t.proxy.calls.some((c) => c.url.startsWith("/v1/ai/digest?"))).toBe(true),
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(t.proxy.calls.some((c) => c.method === "PUT")).toBe(false);
    });

    const oneQuery = (
      query = "ВЫБРАТЬ Счет, СальдоДт ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки(&Дата)",
      params: object = { Дата: new Date().toISOString().slice(0, 10) },
    ) => [
      () => [
        {
          type: "message" as const,
          stopReason: "tool_use",
          content: [{ type: "tool_use", id: "q1", name: "run_query", input: { query, params } }],
        },
      ],
      text("Qoldiq: 125 mln"),
    ];
    const sightings = (t: ReturnType<typeof setup>) =>
      t.proxy.calls
        .filter((c) => c.url === "/v1/ai/templates/learn")
        .map((c) => c.body as { phrase: string });

    it("tells the server when the model answered a question with one query, so it can learn a template", async () => {
      const t = setup(oneQuery(), "active", server({}));
      await ask(t, "Какой остаток в кассе сегодня?");
      await vi.waitFor(() => expect(sightings(t)).toHaveLength(1));
      expect(t.proxy.calls.find((c) => c.url === "/v1/ai/templates/learn")?.body).toEqual({
        company: t.company.name,
        question: "Какой остаток в кассе сегодня?",
        phrase: "остаток кассе",
        query: "ВЫБРАТЬ Счет, СальдоДт ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки(&Дата)",
        params: [{ name: "Дата", type: "date" }],
        columns: [
          { label: "Счет", format: "text" },
          { label: "СальдоДт", format: "number" },
          { label: "СальдоКт", format: "number" },
        ],
      });
    });

    it("learns nothing from an answer with several reads, a card, a follow-up or specifics in the question", async () => {
      const two = setup(
        [
          () => [
            {
              type: "message" as const,
              stopReason: "tool_use",
              content: [
                {
                  type: "tool_use",
                  id: "a",
                  name: "run_query",
                  input: { query: "ВЫБРАТЬ Счет ИЗ РегистрБухгалтерии.Хозрасчетный" },
                },
                { type: "tool_use", id: "b", name: "describe_objects", input: { objects: ["Документ.X"] } },
              ],
            },
          ],
          text("Javob"),
        ],
        "active",
        server({}),
      );
      await ask(two, "Какой остаток в кассе сегодня?");
      const numbered = setup(oneQuery(), "active", server({}));
      await ask(numbered, "Остаток по счету 5010");
      const followUp = setup([text("Birinchi"), ...oneQuery()], "active", server({}));
      await ask(followUp, "Salom");
      await followUp.assistant.send({ companyId: followUp.company.id, text: "Какой остаток в кассе?" });
      await new Promise((r) => setTimeout(r, 30));
      expect(sightings(two)).toHaveLength(0);
      expect(sightings(numbered)).toHaveLength(0);
      expect(sightings(followUp)).toHaveLength(0);
    });

    it("answers from a learned template of this company only, and rejects it when asked anyway", async () => {
      const learned: QueryTemplateView = {
        ...balances,
        code: "learned_abc",
        title: "Какой остаток в кассе?",
        intents: ["остаток кассе"],
        source: "learned",
        company: "ООО «Тест»",
      };
      const mine = setup([], "active", server({ templates: [learned] }));
      await ask(mine, "Остаток в кассе");
      expect(mine.events[0]).toMatchObject({ type: "route", route: "template", learnedCode: "learned_abc" });

      // Another company of the same account does not get it.
      const other = setup(
        [text("Model")],
        "active",
        server({ templates: [{ ...learned, company: "Boshqa MChJ" }] }),
      );
      await ask(other, "Остаток в кассе");
      expect(other.proxy.requests).toHaveLength(1);

      // "Ask AI anyway" on its answer tells the server to turn it off.
      const asked = setup([text("Model")], "active", server({ templates: [learned] }));
      asked.store.setAiEnabled(asked.company.id, true);
      await asked.assistant.send({
        companyId: asked.company.id,
        text: "Остаток в кассе",
        skipFree: true,
        rejectTemplate: "learned_abc",
      });
      await vi.waitFor(() =>
        expect(asked.proxy.calls.find((c) => c.url === "/v1/ai/templates/reject")?.body).toEqual({
          code: "learned_abc",
        }),
      );
    });

    it("moves the rest of a question to the default model after the user declines a card", async () => {
      const t = setup(
        [
          () => [
            {
              type: "message",
              stopReason: "tool_use",
              content: [
                {
                  type: "tool_use",
                  id: "p1",
                  name: "propose_invoice_issued",
                  input: { sale: { number: "0000-000123", date: "2026-10-01" } },
                },
              ],
            },
          ],
          text("Bekor qilindi"),
        ],
        "active",
        server({}),
      );
      t.store.setAiEnabled(t.company.id, true);
      const sending = t.assistant.send({ companyId: t.company.id, text: "Ko'rsat schyot-faktura" });
      await vi.waitFor(() => expect(t.events.some((e) => e.type === "confirm")).toBe(true));
      const card = t.events.find((e) => e.type === "confirm");
      if (card?.type !== "confirm") throw new Error("no card");
      t.assistant.decide(card.companyId, card.id, false);
      await sending;
      expect(t.proxy.requests[0]!.escalate).toBeUndefined();
      expect(t.proxy.requests[1]!.escalate).toBe(true);
    });
  });
});
