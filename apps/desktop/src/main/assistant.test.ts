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
import { TraceLog } from "./ai/backfill.js";
import { CostEngine } from "./ai/engine.js";
import { ChatStore } from "./chats.js";
import { InProcessConnector } from "./connector.js";
import { ControlClient } from "./control-client.js";
import type { SessionService } from "./session.js";
import { EImzoClient } from "./didox/eimzo.js";
import { FakeEImzo } from "./didox/fake-eimzo.js";
import { FakeDidox } from "./didox/fake.js";
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
  didox?: { eimzo: EImzoClient; fetch: typeof fetch },
  renderPdf?: (html: string) => Promise<Uint8Array>,
  learnPolicy = false,
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
    learnPolicy,
    ...(didox ? { didox } : {}),
    ...(renderPdf ? { renderPdf } : {}),
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

  describe("the accounting knowledge of the engine", () => {
    it("answers a how-is-it-booked question from its own base, with the account groups checked against the chart", async () => {
      const { assistant, store, company, proxy, base } = setup([
        () => [
          {
            type: "message" as const,
            stopReason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: "k1",
                name: "accounting_knowledge",
                input: { query: "как проводится аренда" },
              },
            ],
          },
        ],
        () => [{ type: "message" as const, stopReason: "end_turn", content: [{ type: "text", text: "ok" }] }],
      ]);
      // The base's chart has these groups; 4410 (VAT to offset) is not among them.
      base.queryAnswers.unshift({
        match: /ПланСчетов\.Хозрасчетный/,
        answer: () => ({
          columns: ["Код"],
          rows: [["6010"], ["9410"], ["9420"], ["9430"], ["2010"], ["3110"]],
          truncated: false,
        }),
      });
      store.setAiEnabled(company.id, true);
      await assistant.send({ companyId: company.id, text: "аренду как провести?" });
      const result = JSON.stringify(proxy.requests[1]!.messages.at(-1));
      expect(result).toContain("entry_purchase_services");
      expect(result).toContain("Дт 9410");
      expect(result).toContain("accountsNotInThisBase");
      expect(result).toContain("4410");
      // No read of the company's data was made for the answer, only of the chart.
      expect(base.calls.filter((c) => c.fn === "RunQuery")).toHaveLength(1);
    });

    it("says plainly when it knows nothing about the question, so the model reasons from the company's practice", async () => {
      const { assistant, store, company, proxy } = setup([
        () => [
          {
            type: "message" as const,
            stopReason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: "k1",
                name: "accounting_knowledge",
                input: { query: "weather tomorrow" },
              },
            ],
          },
        ],
        () => [{ type: "message" as const, stopReason: "end_turn", content: [{ type: "text", text: "ok" }] }],
      ]);
      store.setAiEnabled(company.id, true);
      await assistant.send({ companyId: company.id, text: "?" });
      expect(JSON.stringify(proxy.requests[1]!.messages.at(-1))).toContain(
        "Nothing in the knowledge base fits",
      );
    });
  });

  describe("the cost stop", () => {
    it("stops the reads of 1C at the budget and tells the model to answer or ask", async () => {
      const queries = Array.from({ length: 43 }, (_, i) => ({
        type: "tool_use",
        id: `q${i}`,
        name: "run_query",
        input: { query: "ВЫБРАТЬ 1 КАК Один" },
      }));
      const { assistant, store, company, proxy, base } = setup([
        () => [{ type: "message", stopReason: "tool_use", content: queries }],
        () => [{ type: "message", stopReason: "end_turn", content: [{ type: "text", text: "partial" }] }],
      ]);
      store.setAiEnabled(company.id, true);
      await assistant.send({ companyId: company.id, text: "analyse everything" });
      // 40 reads reached 1C; the 3 after the budget did not.
      expect(base.calls.filter((c) => c.fn === "RunQuery")).toHaveLength(40);
      const answers = proxy.requests[1]!.messages.at(-1)!.content as { content?: unknown }[];
      expect(answers).toHaveLength(43);
      expect(JSON.stringify(answers.at(-1))).toContain("READ_BUDGET");
      expect(JSON.stringify(answers[39])).not.toContain("READ_BUDGET");
    });
  });

  describe("the accountant's standing rules for the company", () => {
    const tool = (id: string, input: unknown) => () => [
      {
        type: "message" as const,
        stopReason: "tool_use",
        content: [{ type: "tool_use", id, name: "company_rules", input }],
      },
    ];
    const done = () => [
      { type: "message" as const, stopReason: "end_turn", content: [{ type: "text", text: "ok" }] },
    ];

    it("keeps a rule the model saves, and shows it first in the next question's practice", async () => {
      const t = setup([
        tool("r1", { action: "add", rule: "Didox lines of 12% VAT are written under the base's 15% rate" }),
        done,
        done,
      ]);
      t.store.setAiEnabled(t.company.id, true);
      await t.assistant.send({ companyId: t.company.id, text: "12% is 15% here" });
      expect(t.store.rules(t.company.id)).toEqual([
        "Didox lines of 12% VAT are written under the base's 15% rate",
      ]);
      // The tool's answer shows the numbered list, and the same chat's next step already has the rule.
      const result = JSON.stringify(t.proxy.requests[1]!.messages.at(-1));
      expect(result).toContain("1. Didox lines of 12% VAT");
      expect(t.proxy.requests[1]!.policy).toContain("Standing rules the accountant gave");
      expect(t.proxy.requests[1]!.policy).toContain("written under the base's 15% rate");
      // And a later chat of the same company has it too.
      await t.assistant.send({
        companyId: t.company.id,
        chatId: "99999999-9999-4999-8999-999999999999",
        text: "next",
      });
      expect(t.proxy.requests[2]!.policy).toContain("written under the base's 15% rate");
    });

    it("keeps one copy of the same rule, and forgets one by number or by its words", () => {
      const t = setup([]);
      t.store.addRule(t.company.id, "Rent goes to 9410");
      t.store.addRule(t.company.id, "rent  goes to 9410");
      t.store.addRule(t.company.id, "Goods for resale go to 2910");
      expect(t.store.rules(t.company.id)).toEqual(["Rent goes to 9410", "Goods for resale go to 2910"]);
      expect(t.store.removeRule(t.company.id, 1)).toEqual(["Goods for resale go to 2910"]);
      expect(t.store.removeRule(t.company.id, "resale")).toEqual([]);
      expect(t.store.removeRule(t.company.id, "nothing like it")).toEqual([]);
    });

    it("asks for what an add or a remove lacks", async () => {
      const t = setup([tool("r1", { action: "add" }), done]);
      t.store.setAiEnabled(t.company.id, true);
      await t.assistant.send({ companyId: t.company.id, text: "x" });
      expect(JSON.stringify(t.proxy.requests[1]!.messages.at(-1))).toContain("add needs the rule");
    });
  });

  describe("how the company works", () => {
    const answer = (text: string) => () => [
      { type: "message" as const, stopReason: "end_turn", content: [{ type: "text", text }] },
    ];
    const withAccounts = (t: ReturnType<typeof setup>) => {
      t.base.queryAnswers.unshift({
        match: /Справочник\.БанковскиеСчета/,
        answer: () => ({
          columns: [],
          rows: [
            [
              { type: "Справочник.БанковскиеСчета", ref: "11111111-0000-4000-8000-000000000001", name: "x" },
              "20208000100438330009",
              "Блок счет",
              "UZS",
              "5530",
              t.company.inn,
            ],
          ],
          truncated: false,
        }),
      });
    };

    it("learns it from 1C once and sends it with every question, so the model follows the company's practice", async () => {
      const t = setup([answer("one"), answer("two")], "active", undefined, undefined, undefined, true);
      withAccounts(t);
      t.store.setAiEnabled(t.company.id, true);
      await t.assistant.send({ companyId: t.company.id, text: "first" });
      await t.assistant.send({ companyId: t.company.id, text: "second" });
      expect(t.proxy.requests).toHaveLength(2);
      for (const request of t.proxy.requests) {
        expect(request.policy).toContain("«Блок счет»");
        expect(request.policy).toContain("blocked / held-money account");
      }
      // The reads were made once for both questions.
      const reads = t.base.calls.filter(
        (c) => c.fn === "RunQuery" && String(c.arg).includes("Справочник.БанковскиеСчета"),
      );
      expect(reads).toHaveLength(1);
    });

    it("lets a base that does not answer pass: the question goes on without it", async () => {
      const t = setup([answer("ok")], "active", undefined, undefined, undefined, true);
      t.base.queryAnswers.unshift({
        match: /ВЫБРАТЬ/,
        answer: () => {
          throw new Error("1C is busy");
        },
      });
      t.store.setAiEnabled(t.company.id, true);
      expect(await t.assistant.send({ companyId: t.company.id, text: "?" })).toEqual({
        ok: true,
        data: null,
      });
      expect(t.proxy.requests[0]!.policy).toBeUndefined();
    });
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

    describe("an invoice for Didox", () => {
      const ALIAS =
        "1.2.860.3.16.1.1=302936161,CN=ИВАНОВ ИВАН,O=FIDES PROJECTS XK,SERIALNUMBER=5A3C0F11,VALIDFROM=2025.01.01 00:00:00,VALIDTO=2099.01.01 23:59:59";
      const INVOICE_REF = "11111111-1111-4111-8111-111111111111";
      const ACT_REF = "22222222-2222-4222-8222-222222222222";
      const WORK_REF = "33333333-3333-4333-8333-333333333333";
      const draft = {
        onec: { object: "Документ.СчетФактураВыданный", ref: INVOICE_REF },
        title: "Hisob-faktura 1294",
        number: "1294",
        date: "2026-10-19",
        buyerInn: "201607534",
        lines: [{ name: "Suv", unit: "шт", qty: 2, price: 1000, vatRate: 12 }],
      };
      /** An ЭСФ as Didox gives it, cut down to the fields that matter. */
      const factura = (number: string, date: string, sellerTin: string, buyerTin: string) => ({
        facturadoc: { facturano: number, facturadate: date },
        sellertin: sellerTin,
        seller: { name: `SELLER ${sellerTin}` },
        buyertin: buyerTin,
        buyer: { name: `BUYER ${buyerTin}` },
        productlist: {
          hasvat: false,
          products: [
            {
              ordno: 1,
              name: "Suv",
              count: "1",
              summa: "1000.00",
              deliverysum: "1000.00",
              vatrate: 0,
              vatsum: 0,
              deliverysumwithvat: "1000.00",
            },
          ],
        },
      });

      function didoxSetup(
        script = proposeThenAnswer("propose_didox_draft", draft),
        renderPdf?: (html: string) => Promise<Uint8Array>,
      ) {
        const server = new FakeDidox();
        server.profiles.set("201607534", { name: "NAVRO'Z-PTK MCHJ", account: "2020", mfo: "00014" });
        const eimzo = new FakeEImzo();
        eimzo.certificates = [{ disk: "D", path: "/k", name: "key1", alias: ALIAS }];
        const made = setup(
          script,
          "active",
          undefined,
          { eimzo: new EImzoClient({ connect: eimzo.connect }), fetch: server.fetch },
          renderPdf,
        );
        made.store.setAiEnabled(made.company.id, true);
        // The documents in 1C that the Didox documents are made from.
        made.base.objects.set(INVOICE_REF, {
          object: "Документ.СчетФактураВыданный",
          fields: { Номер: "1294", Дата: "2026-10-19T00:00:00" },
          posted: true,
          deletionMark: false,
          version: 1,
        });
        made.base.objects.set(WORK_REF, {
          object: "Документ.АктВыполненныхРабот",
          fields: { Номер: "0000-000013", Дата: "2026-10-19T00:00:00" },
          posted: false,
          deletionMark: false,
          version: 1,
        });
        // The reconciliation act as 1C keeps it: the period, the contract and the rows of the company's side.
        made.base.objects.set(ACT_REF, {
          object: "Документ.АктСверкиВзаиморасчетов",
          fields: {
            Номер: "0000-000013",
            Дата: "2026-10-19T00:00:00",
            ДатаНачала: "2026-01-01T00:00:00",
            ДатаОкончания: "2026-10-19T00:00:00",
            Контрагент: { name: "NAVRO'Z-PTK MCHJ" },
            ДоговорКонтрагента: "№85 от 30.12.2025",
          },
          tables: {
            ПоДаннымОрганизации: [
              {
                Дебет: 10000000,
                Представление: "Списание с расчетного счета 0000-000000000336 от 28.01.2026",
                Дата: "2026-01-28T00:00:06",
                Договор: "№85 от 30.12.2025",
              },
            ],
            ПоДаннымКонтрагента: [],
          },
          posted: false,
          deletionMark: false,
          version: 1,
        });
        return { ...made, server };
      }

      it("makes a draft only after the card is confirmed, and signs and sends nothing", async () => {
        const { assistant, store, company, events, proxy, server } = didoxSetup();
        store.setDidox(company.id, { baseUrl: "https://didox.test/", serialNumber: "5A3C0F11" });
        const sending = assistant.send({ companyId: company.id, text: "yubor didoksdan" });
        await answerCards(events, assistant, true);
        expect(await sending).toEqual({ ok: true, data: null });

        expect(events.find((e) => e.type === "confirm")).toMatchObject({
          proposal: {
            kind: "didox_draft",
            draft: { number: "1294", buyer: { name: "NAVRO'Z-PTK MCHJ" }, totals: { total: "2240.00" } },
          },
        });
        expect(server.drafts).toHaveLength(1);
        expect(server.requests.some((r) => /\/(sign|tosign|reject)$/.test(r.url.pathname))).toBe(false);
        expect(events.find((e) => e.type === "decided")).toMatchObject({
          outcome: { status: "didox_draft", id: "DRAFT1" },
        });
        expect(resultOf(proxy.requests)).toMatchObject({ status: "draft_created", draftId: "DRAFT1" });
      });

      it("makes nothing in Didox when the user cancels", async () => {
        const { assistant, store, company, events, proxy, server } = didoxSetup();
        store.setDidox(company.id, { baseUrl: "https://didox.test/", serialNumber: "5A3C0F11" });
        const sending = assistant.send({ companyId: company.id, text: "?" });
        await answerCards(events, assistant, false);
        await sending;
        expect(server.drafts).toHaveLength(0);
        expect(resultOf(proxy.requests)).toEqual({ status: "declined_by_user" });
      });

      it("reads the company's Didox documents itself: incoming go into the chat, outgoing are listed", async () => {
        const fetching = proposeThenAnswer("fetch_didox_documents", {
          from: "2026-10-01",
          to: "2026-10-31",
          direction: "both",
        });
        const { assistant, store, company, proxy, server, base, chats } = didoxSetup(fetching);
        const inn = base.organizations[0]!.inn;
        server.documents = [
          {
            id: "a",
            doctype: "002",
            status: 3,
            owner: 0,
            json: factura("1", "2026-10-09", "111111111", inn),
          },
          {
            id: "b",
            doctype: "002",
            status: 3,
            owner: 1,
            json: factura("7", "2026-10-11", inn, "222222222"),
          },
        ];
        store.setDidox(company.id, { baseUrl: "https://didox.test/", serialNumber: "5A3C0F11" });
        await assistant.send({ companyId: company.id, text: "Didoxdan hammasini ol" });

        expect(resultOf(proxy.requests)).toMatchObject({ read: 2, incomingCount: 1, outgoingCount: 1 });
        const result = resultOf(proxy.requests) as { incomingSummary: string; outgoingList: string[] };
        expect(result.incomingSummary).toContain("SELLER 111111111");
        expect(result.outgoingList[0]).toContain("222222222");
        // Nothing was created, signed or deleted in Didox.
        expect(server.drafts).toHaveLength(0);
        expect(server.requests.some((r) => /\/(create|sign|reject|delete)$/.test(r.url.pathname))).toBe(
          false,
        );
        const saved = chats.load(company.id, chats.list(company.id)[0]!.id);
        expect(saved?.didox?.map((d) => d.number)).toEqual(["1"]);
      });

      it("reads the period from Didox itself in the same step, and keeps the VAT and account decisions it is given", async () => {
        const entering = proposeThenAnswer("propose_didox_invoices", {
          title: "Didox 2026-10",
          from: "2026-10-01",
          to: "2026-10-31",
          vatRateMap: [{ from: 12, to: 15 }],
          accountRules: [{ match: "аренд|rent", account: "9410" }],
        });
        const { assistant, store, company, proxy, server, base } = didoxSetup(entering);
        const inn = base.organizations[0]!.inn;
        server.documents = [
          {
            id: "a",
            doctype: "002",
            status: 3,
            owner: 0,
            json: factura("1", "2026-10-09", "111111111", inn),
          },
          {
            id: "b",
            doctype: "002",
            status: 3,
            owner: 0,
            json: factura("2", "2026-09-09", "111111111", inn),
          },
        ];
        store.setDidox(company.id, { baseUrl: "https://didox.test/", serialNumber: "5A3C0F11" });
        await assistant.send({ companyId: company.id, text: "Didox 2026 oktyabr" });

        // The documents of the period were read by the app, not by a step of the model; the other month is left out.
        expect(server.requests.some((r) => r.url.pathname === "/v1/documents")).toBe(true);
        const result = resultOf(proxy.requests) as { needsAttention?: { document: string }[] };
        const documents = JSON.stringify(result);
        expect(documents).toContain("111111111/1");
        expect(documents).not.toContain("111111111/2");
        // What the accountant decided is kept for the company, as settings and as a rule the model is shown.
        expect(store.bookkeeping(company.id)).toEqual({
          vatRateMap: [{ from: 12, to: 15 }],
          accountRules: [{ match: "аренд|rent", account: "9410" }],
        });
        expect(store.rules(company.id)).toEqual([
          "Didox lines of 12% VAT are written under the base's 15% rate",
          "Lines named like «аренд|rent» are booked to account 9410",
        ]);
      });

      it("makes a letter a free-form draft in Didox, as a PDF, after the card is confirmed", async () => {
        const letter = proposeThenAnswer("propose_didox_document", {
          title: "Xat - NAVRO'Z-PTK",
          type: "letter",
          number: "15",
          date: "2026-10-19",
          buyerInn: "201607534",
          subject: "Dalolatnoma haqida",
          text: "Hurmatli hamkor!\n\nDalolatnomani imzolang.",
        });
        const { assistant, store, company, events, proxy, server } = didoxSetup(
          letter,
          async () => new Uint8Array(Buffer.from("%PDF-1.4")),
        );
        store.setDidox(company.id, { baseUrl: "https://didox.test/", serialNumber: "5A3C0F11" });
        const sending = assistant.send({ companyId: company.id, text: "didoksga yubor" });
        await answerCards(events, assistant, true);
        expect(await sending).toEqual({ ok: true, data: null });

        expect(events.find((e) => e.type === "confirm")).toMatchObject({
          proposal: {
            kind: "didox_document",
            document: { type: "letter", number: "15", subject: "Dalolatnoma haqida" },
          },
        });
        expect(server.drafts).toHaveLength(1);
        expect(server.drafts[0]?.docType).toBe("000");
        expect(server.requests.some((r) => /\/(sign|tosign|reject)$/.test(r.url.pathname))).toBe(false);
        expect(resultOf(proxy.requests)).toMatchObject({ status: "draft_created", draftId: "DRAFT1" });
      });

      describe("1C first: a Didox document is made only from a saved 1C document", () => {
        const act = {
          title: "Akt sverka",
          type: "work_act",
          number: "0000-000013",
          date: "2026-10-19",
          buyerInn: "201607534",
          subject: "Akt sverka",
          text: "АКТ СВЕРКИ № 0000-000013 от 19.10.2026 между сторонами.",
        };
        const pdf = async () => new Uint8Array(Buffer.from("%PDF-1.4"));

        async function run(input: Record<string, unknown>) {
          const made = didoxSetup(proposeThenAnswer("propose_didox_document", input), pdf);
          made.store.setDidox(made.company.id, { baseUrl: "https://didox.test/", serialNumber: "5A3C0F11" });
          const sending = made.assistant.send({ companyId: made.company.id, text: "?" });
          await answerCards(made.events, made.assistant, true);
          await sending;
          return {
            ...made,
            result: resultOf(made.proxy.requests) as { status: string; problems?: { code: string }[] },
          };
        }

        it("makes the draft of an act that is saved in 1C with that number and date", async () => {
          const { server, result } = await run({
            ...act,
            onec: { object: "Документ.АктВыполненныхРабот", ref: WORK_REF },
          });
          expect(result.status).toBe("draft_created");
          expect(server.drafts).toHaveLength(1);
        });

        it("refuses an act that was not applied in 1C first, and touches nothing in Didox", async () => {
          const made = didoxSetup(proposeThenAnswer("propose_didox_document", act), pdf);
          made.store.setDidox(made.company.id, { baseUrl: "https://didox.test/", serialNumber: "5A3C0F11" });
          await made.assistant.send({ companyId: made.company.id, text: "?" });
          const result = resultOf(made.proxy.requests) as { status: string; problems: { code: string }[] };
          expect(result.status).toBe("needs_attention");
          expect(result.problems.map((p) => p.code)).toEqual(["NO_1C_DOCUMENT"]);
          expect(made.server.requests).toHaveLength(0);
          expect(made.events.some((e) => e.type === "confirm")).toBe(false);
        });

        it("refuses a number or date that differs from 1C, or a text that does not name them", async () => {
          const made = didoxSetup(
            proposeThenAnswer("propose_didox_document", {
              ...act,
              number: "0000-000016",
              date: "2026-10-20",
              onec: { object: "Документ.АктВыполненныхРабот", ref: WORK_REF },
            }),
            pdf,
          );
          made.store.setDidox(made.company.id, { baseUrl: "https://didox.test/", serialNumber: "5A3C0F11" });
          await made.assistant.send({ companyId: made.company.id, text: "?" });
          const result = resultOf(made.proxy.requests) as { problems: { code: string }[] };
          expect(result.problems.map((p) => p.code)).toEqual(["ONEC_NUMBER", "ONEC_DATE", "TEXT_NUMBER"]);
          expect(made.server.drafts).toHaveLength(0);
        });

        it("wants an invoice posted in 1C before it goes to Didox", async () => {
          const made = didoxSetup(proposeThenAnswer("propose_didox_draft", draft));
          made.store.setDidox(made.company.id, { baseUrl: "https://didox.test/", serialNumber: "5A3C0F11" });
          made.base.objects.get(INVOICE_REF)!.posted = false;
          await made.assistant.send({ companyId: made.company.id, text: "?" });
          const result = resultOf(made.proxy.requests) as { problems: { code: string }[] };
          expect(result.problems.map((p) => p.code)).toEqual(["ONEC_NOT_POSTED"]);
          expect(made.server.drafts).toHaveLength(0);
        });
      });

      describe("a reconciliation act built from the 1C act, and a wrong draft deleted", () => {
        async function run(
          script: ReturnType<typeof proposeThenAnswer>,
          before?: (m: ReturnType<typeof didoxSetup>) => void,
        ) {
          const made = didoxSetup(script);
          made.store.setDidox(made.company.id, { baseUrl: "https://didox.test/", serialNumber: "5A3C0F11" });
          before?.(made);
          const sending = made.assistant.send({ companyId: made.company.id, text: "?" });
          await answerCards(made.events, made.assistant, true);
          await sending;
          return made;
        }
        const rec = {
          title: "Akt sverka",
          onec: { object: "Документ.АктСверкиВзаиморасчетов", ref: ACT_REF },
          buyerInn: "201607534",
          openings: [{ ownerDebit: 500 }],
        };

        it("reads the rows, contract and period from 1C and works the balances out itself", async () => {
          const made = await run(proposeThenAnswer("propose_didox_reconciliation", rec));
          const card = made.events.find((e) => e.type === "confirm");
          expect(card).toMatchObject({
            proposal: {
              kind: "didox_reconciliation",
              act: {
                number: "0000-000013",
                from: "2026-01-01",
                to: "2026-10-19",
                buyer: { name: "NAVRO'Z-PTK MCHJ" },
                close: { ownerDebit: "10000500.00", ownerCredit: "0.00" },
                contracts: [{ number: "85", date: "2025-12-30" }],
              },
            },
          });
          expect(made.server.drafts).toHaveLength(1);
          expect(made.server.drafts[0]?.docType).toBe("052");
          expect(made.server.drafts[0]?.body).toMatchObject({
            VerificationActDoc: { VerificationActNo: "0000-000013" },
            CloseBalance: { OwnerDebit: 10_000_500 },
          });
          expect(resultOf(made.proxy.requests)).toMatchObject({ status: "draft_created", draftId: "DRAFT1" });
        });

        it("refuses an act with no rows, and touches nothing in Didox", async () => {
          const made = didoxSetup(proposeThenAnswer("propose_didox_reconciliation", rec));
          made.store.setDidox(made.company.id, { baseUrl: "https://didox.test/", serialNumber: "5A3C0F11" });
          made.base.objects.get(ACT_REF)!.tables = { ПоДаннымОрганизации: [], ПоДаннымКонтрагента: [] };
          await made.assistant.send({ companyId: made.company.id, text: "?" });
          const result = resultOf(made.proxy.requests) as { status: string; problems: { code: string }[] };
          expect(result).toMatchObject({ status: "needs_attention" });
          expect(result.problems.map((p) => p.code)).toEqual(["NO_ROWS"]);
          expect(made.server.requests).toHaveLength(0);
        });

        it("deletes a wrong draft only after the card is confirmed", async () => {
          const made = await run(proposeThenAnswer("propose_didox_delete_draft", { id: "DRAFT1" }), (m) => {
            m.server.drafts.push({ docType: "000", body: { name: "15" } });
          });
          expect(made.events.find((e) => e.type === "confirm")).toMatchObject({
            proposal: { kind: "didox_delete", draft: { id: "DRAFT1", number: "15" } },
          });
          expect(made.server.drafts).toHaveLength(0);
          expect(resultOf(made.proxy.requests)).toMatchObject({ status: "draft_deleted", draftId: "DRAFT1" });
        });

        it("keeps the draft when the user cancels", async () => {
          const made = didoxSetup(proposeThenAnswer("propose_didox_delete_draft", { id: "DRAFT1" }));
          made.store.setDidox(made.company.id, { baseUrl: "https://didox.test/", serialNumber: "5A3C0F11" });
          made.server.drafts.push({ docType: "000", body: {} });
          const sending = made.assistant.send({ companyId: made.company.id, text: "?" });
          await answerCards(made.events, made.assistant, false);
          await sending;
          expect(made.server.drafts).toHaveLength(1);
          expect(resultOf(made.proxy.requests)).toEqual({ status: "declined_by_user" });
        });

        it("says so when Didox has no such draft", async () => {
          const made = didoxSetup(proposeThenAnswer("propose_didox_delete_draft", { id: "NOSUCHID" }));
          made.store.setDidox(made.company.id, { baseUrl: "https://didox.test/", serialNumber: "5A3C0F11" });
          await made.assistant.send({ companyId: made.company.id, text: "?" });
          expect(JSON.stringify(made.proxy.requests[1]?.messages)).toContain("NOT_FOUND");
        });
      });

      it("tells the model when Didox is not connected for the company", async () => {
        const { assistant, company, proxy, server } = didoxSetup();
        await assistant.send({ companyId: company.id, text: "?" });
        expect(JSON.stringify(proxy.requests[1]?.messages)).toContain("NO_DIDOX_CONNECTION");
        expect(server.requests).toHaveLength(0);
      });
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

    const markObject = (base: FakePlatform, object: string, referenced = false) => {
      const ref = crypto.randomUUID();
      base.objects.set(ref, { object, fields: {}, posted: false, deletionMark: true, version: 1 });
      if (referenced) base.referenced.add(ref);
      return ref;
    };

    it("removes the marked objects for good only after the user confirms the card", async () => {
      const t = setup(proposeThenAnswer("propose_delete_marked", {}));
      markObject(t.base, "Документ.СписаниеСРасчетногоСчета");
      markObject(t.base, "Документ.СписаниеСРасчетногоСчета");
      const stays = markObject(t.base, "Справочник.БанковскиеСчета", true);
      t.store.setAiEnabled(t.company.id, true);
      const sending = t.assistant.send({ companyId: t.company.id, text: "Удали помеченные на удаление" });
      await answerCards(t.events, t.assistant, true);
      expect(await sending).toEqual({ ok: true, data: null });

      // The card showed what would go, by type, before anything was removed.
      expect(t.events.find((e) => e.type === "confirm")).toMatchObject({
        proposal: {
          kind: "delete_marked",
          preview: {
            total: 3,
            types: [expect.objectContaining({ count: 2 }), expect.objectContaining({ count: 1 })],
          },
        },
      });
      expect(t.events.find((e) => e.type === "decided")).toMatchObject({
        outcome: { status: "removed", result: { total: 3, deleted: 2, kept: 1 } },
      });
      // What is still referenced stays, and the model is told exactly that.
      expect([...t.base.objects.keys()]).toEqual([stays]);
      expect(resultOf(t.proxy.requests)).toMatchObject({ status: "done", deleted: 2, kept: 1 });
    });

    it("removes nothing when the user cancels, and needs no card when nothing is marked", async () => {
      const t = setup(proposeThenAnswer("propose_delete_marked", {}));
      markObject(t.base, "Документ.СписаниеСРасчетногоСчета");
      t.store.setAiEnabled(t.company.id, true);
      const sending = t.assistant.send({ companyId: t.company.id, text: "Очисти базу" });
      await answerCards(t.events, t.assistant, false);
      await sending;
      expect(t.base.objects.size).toBe(1);
      expect(resultOf(t.proxy.requests)).toEqual({ status: "declined_by_user" });

      const empty = setup(proposeThenAnswer("propose_delete_marked", {}));
      empty.store.setAiEnabled(empty.company.id, true);
      await empty.assistant.send({ companyId: empty.company.id, text: "Очисти базу" });
      expect(empty.events.some((e) => e.type === "confirm")).toBe(false);
      expect(resultOf(empty.proxy.requests)).toEqual({ status: "nothing_marked" });
    });

    it("shows who else has the base open, and reports a busy base when the removal is refused", async () => {
      const t = setup(
        proposeThenAnswer("propose_delete_marked", { types: ["Документ.СписаниеСРасчетногоСчета"] }),
      );
      markObject(t.base, "Документ.СписаниеСРасчетногоСчета");
      markObject(t.base, "Справочник.БанковскиеСчета");
      t.base.otherSessions = [
        {
          number: 2,
          application: "Тонкий клиент",
          user: "Admin",
          computer: "DESKTOP-1",
          startedAt: "2026-10-09T10:44:08",
        },
      ];
      t.store.setAiEnabled(t.company.id, true);
      const sending = t.assistant.send({ companyId: t.company.id, text: "Удали помеченные списания" });
      await answerCards(t.events, t.assistant, true);
      await sending;
      // Only the asked type was offered, with the other session named on the card.
      expect(t.events.find((e) => e.type === "confirm")).toMatchObject({
        proposal: {
          preview: { total: 1, otherSessions: [expect.objectContaining({ computer: "DESKTOP-1" })] },
        },
      });
      expect(t.events.find((e) => e.type === "decided")).toMatchObject({
        outcome: { status: "failed", code: "BASE_BUSY" },
      });
      expect(t.base.objects.size).toBe(2);
      expect(resultOf(t.proxy.requests)).toMatchObject({ error: "BASE_BUSY" });
    });

    it("does not offer the removal on a read-only license", async () => {
      const t = setup(proposeThenAnswer("propose_delete_marked", {}), "read_only");
      markObject(t.base, "Документ.СписаниеСРасчетногоСчета");
      t.store.setAiEnabled(t.company.id, true);
      await t.assistant.send({ companyId: t.company.id, text: "Удали помеченные" });
      expect(t.events.some((e) => e.type === "confirm")).toBe(false);
      expect(t.base.objects.size).toBe(1);
      expect(resultOf(t.proxy.requests)).toMatchObject({ error: "READ_ONLY" });
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

    it("saves what it creates from attached files unposted, unless the question asks to post", async () => {
      const create = {
        action: "create",
        object: "Документ.ПоступлениеТоваровУслуг",
        fields: { Номер: "9" },
        post: true,
      };
      const file = { name: "esf.xml", data: new TextEncoder().encode("<a>\n  <b>1</b>\n</a>") };
      for (const [text, posted] of [
        ["введи документ из файла", false],
        ["введи и проведи документ из файла", true],
      ] as const) {
        const { assistant, store, company, events, proxy, base } = setup(
          proposeThenAnswer("propose_change", create),
        );
        store.setAiEnabled(company.id, true);
        const sending = assistant.send({ companyId: company.id, text, files: [file] });
        await answerCards(events, assistant, true);
        await sending;
        const ref = resultOf(proxy.requests).object.ref as string;
        expect(base.objects.get(ref)?.posted).toBe(posted);
      }
      // Without files, the model's own choice stands.
      const { assistant, store, company, events, proxy, base } = setup(
        proposeThenAnswer("propose_change", create),
      );
      store.setAiEnabled(company.id, true);
      const sending = assistant.send({ companyId: company.id, text: "введи документ" });
      await answerCards(events, assistant, true);
      await sending;
      expect(base.objects.get(resultOf(proxy.requests).object.ref as string)?.posted).toBe(true);
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

    it("enters Didox invoices from attached files: the program looks 1C up, and the model settles only what is uncertain", async () => {
      const didoxLine = (name: string, code: string) => ({
        ordno: 1,
        name,
        catalogcode: code,
        catalogname: "Товары",
        packagename: "шт.",
        count: "10",
        summa: "1000",
        deliverysum: "10000",
        vatrate: 12,
        vatsum: "1200",
        deliverysumwithvat: "11200",
      });
      const didoxInvoice = (number: string, line: Record<string, unknown>) =>
        new TextEncoder().encode(
          JSON.stringify({
            facturaid: `didox-${number}`,
            facturadoc: { facturano: number, facturadate: "2026-10-13" },
            contractdoc: { contractno: "17", contractdate: "2026-01-08" },
            sellertin: "123456789",
            seller: { name: "ООО Поставщик" },
            buyertin: "300000001",
            buyer: { name: "ООО «Тест»" },
            productlist: { products: [line] },
          }),
        );
      const call = (input: unknown) => () => [
        {
          type: "message" as const,
          stopReason: "tool_use",
          content: [{ type: "tool_use", id: "d1", name: "propose_didox_invoices", input }],
        },
      ];
      const itemRefs = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      const contractRef = crypto.randomUUID();
      let second: unknown;
      const { assistant, store, company, events, proxy, base } = setup([
        call({ title: "Didox: 2" }),
        (input) => {
          second = input.messages.at(-1);
          return call({
            title: "Didox: 1",
            items: [{ document: "123456789/664", line: 1, ref: itemRefs[1] }],
          })();
        },
        () => [{ type: "message" as const, stopReason: "end_turn", content: [{ type: "text", text: "OK" }] }],
      ]);
      base.items = [
        { ref: itemRefs[0]!, name: "Жидкое мыло CRISTAL 480 мл", ikpu: "03401001002241001" },
        { ref: itemRefs[1]!, name: "Подгузники Mini 40 шт", ikpu: "09619002001000000" },
        { ref: itemRefs[2]!, name: "Подгузники Midi 34 шт", ikpu: "09619002001000000" },
      ];
      base.contracts = [
        {
          ref: contractRef,
          ownerRef: base.counterparties[0]!.ref,
          number: "17",
          date: "2026-01-08T00:00:00",
        },
      ];
      base.metadata = [
        {
          fullName: "Справочник.Номенклатура",
          synonym: "Номенклатура",
          attributes: [{ name: "КодИКПУ", synonym: "Код из классификатора", types: ["Строка"] }],
          tabularSections: [],
        },
      ];
      const values = (input: { params?: Record<string, unknown> }) => Object.values(input.params ?? {});
      const ref = (type: string, id: string, name: string) => ({ type, ref: id, name });
      base.queryAnswers.unshift(
        {
          match: /Справочник\.Контрагенты КАК Т ГДЕ Т\.ИНН В/,
          answer: (input) => ({
            columns: [],
            rows: base.counterparties
              .filter((c) => values(input).includes(c.inn))
              .map((c) => [c.inn, ref("Справочник.Контрагенты", c.ref, c.name), c.name]),
            truncated: false,
          }),
        },
        {
          match: /ДоговорыКонтрагентов КАК Т ГДЕ/,
          answer: (input) => ({
            columns: [],
            rows: base.contracts
              .map((c) => [
                base.counterparties.find((cp) => cp.ref === c.ownerRef)?.inn ?? "",
                ref("Справочник.ДоговорыКонтрагентов", c.ref, c.number ?? ""),
                c.number ?? "",
                c.date ?? "",
              ])
              .filter((row) => values(input).includes(row[0])),
            truncated: false,
          }),
        },
        {
          match: /Т\.Наименование В/,
          answer: (input) => ({
            columns: [],
            rows: base.items
              .filter((i) => values(input).includes(i.name))
              .map((i) => [i.name, ref("Справочник.Номенклатура", i.ref, i.name)]),
            truncated: false,
          }),
        },
        {
          match: /Т\.КодИКПУ В/,
          answer: (input) => ({
            columns: [],
            rows: base.items
              .filter((i) => values(input).includes(i.ikpu))
              .map((i) => [i.ikpu, ref("Справочник.Номенклатура", i.ref, i.name), i.name]),
            truncated: false,
          }),
        },
      );
      store.setAiEnabled(company.id, true);

      const sending = assistant.send({
        companyId: company.id,
        text: "Didox fakturalarini kirit",
        files: [
          {
            name: "663.json",
            data: didoxInvoice("663", didoxLine("Жидкое мыло CRISTAL 480 мл", "03401001002241001")),
          },
          {
            name: "664.json",
            data: didoxInvoice(
              "664",
              didoxLine("Подгузники детские размер 5 Junior 13 шт", "09619002001000000"),
            ),
          },
        ],
      });
      // Both cards, one after the other: the certain invoice first, the settled one after the model's answer.
      const answered = new Set<string>();
      const timer = setInterval(() => {
        for (const e of events) {
          if (e.type === "confirm" && !answered.has(e.id)) {
            answered.add(e.id);
            assistant.decide(e.companyId, e.id, true);
          }
        }
      }, 1);
      await sending;
      clearInterval(timer);

      expect(events.filter((e) => e.type === "confirm")).toHaveLength(2);
      expect(base.documents.map((d) => [d.supplierNumber, d.source, d.externalId])).toEqual([
        ["663", "didox", "didox-663"],
        ["664", "didox", "didox-664"],
      ]);
      expect(base.documents[0]).toMatchObject({
        counterpartyRef: base.counterparties[0]!.ref,
        contractRef,
        lines: [{ itemRef: itemRefs[0], quantity: 10, price: 1000, amount: 10000, vatAmount: 1200 }],
      });
      expect(base.documents[1]?.lines[0]?.itemRef).toBe(itemRefs[1]);
      // The model was told about the uncertain line only, with the candidates, not given the invoices to write.
      const told = JSON.stringify(second);
      expect(told).toContain("ITEM_CHOOSE");
      expect(told).toContain("123456789/664");
      expect(told).not.toContain("123456789/663");
      expect(proxy.requests).toHaveLength(3);
    });

    it("enters a bank statement's payments from the attached file: the program copies the counterparty's last payment, the model only starts it", async () => {
      const ref = (type: string, id: string, name: string) => ({ type, ref: id, name });
      const ownAccount = crypto.randomUUID();
      const earlierPayment = crypto.randomUUID();
      const contract = crypto.randomUUID();
      const { assistant, store, company, events, proxy, base } = setup([
        () => [
          {
            type: "message" as const,
            stopReason: "tool_use",
            content: [
              { type: "tool_use", id: "b1", name: "propose_bank_payments", input: { title: "Vypiska: 5" } },
            ],
          },
        ],
        () => [{ type: "message" as const, stopReason: "end_turn", content: [{ type: "text", text: "OK" }] }],
      ]);
      const counterparty = base.counterparties[0]!;
      base.objects.set(earlierPayment, {
        object: "Документ.ПоступлениеНаРасчетныйСчет",
        fields: {
          Номер: "0000-000007",
          Дата: "2026-08-01T00:00:00",
          Проведен: true,
          Контрагент: ref("Справочник.Контрагенты", counterparty.ref, counterparty.name),
          БанковскийСчет: ref("Справочник.БанковскиеСчета", crypto.randomUUID(), "старый"),
          СуммаДокумента: 1000,
          НазначениеПлатежа: "старое",
          НомерВходящегоДокумента: "55",
        },
        tables: {
          РасшифровкаПлатежа: [
            {
              ДоговорКонтрагента: ref("Справочник.ДоговорыКонтрагентов", contract, "№17"),
              СуммаПлатежа: 1000,
              КурсВзаиморасчетов: 1,
              СуммаВзаиморасчетов: 1000,
            },
          ],
        },
        posted: true,
        deletionMark: false,
        version: 1,
      });
      const values = (input: { params?: Record<string, unknown> }) => Object.values(input.params ?? {});
      base.queryAnswers.unshift(
        {
          match: /Справочник\.БанковскиеСчета/,
          answer: () => ({
            columns: [],
            rows: [[ref("Справочник.БанковскиеСчета", ownAccount, "р/с")]],
            truncated: false,
          }),
        },
        {
          match: /Справочник\.Контрагенты КАК Т ГДЕ Т\.ИНН В/,
          answer: (input) => ({
            columns: [],
            rows: base.counterparties
              .filter((c) => values(input).includes(c.inn))
              .map((c) => [c.inn, ref("Справочник.Контрагенты", c.ref, c.name), c.name]),
            truncated: false,
          }),
        },
        {
          match: /ПЕРВЫЕ 20 Т\.Ссылка/,
          answer: () => ({
            columns: [],
            rows: [[ref("Документ.ПоступлениеНаРасчетныйСчет", earlierPayment, "старый"), "старое"]],
            truncated: false,
          }),
        },
        { match: /Т\.Дата МЕЖДУ/, answer: () => ({ columns: [], rows: [], truncated: false }) },
      );
      store.setAiEnabled(company.id, true);
      const rows = [1, 2, 3, 4, 5].map(
        (n) => `0${n}.09.2026;10${n};${counterparty.name};${counterparty.inn};;${n * 1000},00;Оплата ${n}`,
      );
      const statement = [
        "Выписка по счёту 20208000100438330001",
        "Дата;№ док;Наименование корреспондента;ИНН;Дебет;Кредит;Назначение платежа",
        ...rows,
      ].join("\n");

      const sending = assistant.send({
        companyId: company.id,
        text: "Vypiskani kirit",
        files: [{ name: "vypiska.csv", data: new TextEncoder().encode(statement) }],
      });
      await answerCards(events, assistant, true);
      await sending;

      // The model was sent the totals, not the rows.
      const first = JSON.stringify(proxy.requests[0]?.messages[0]);
      expect(first).toContain("read by the program");
      expect(first).not.toContain("Оплата 3");
      const made = [...base.objects.values()].filter(
        (o) => o.object === "Документ.ПоступлениеНаРасчетныйСчет" && o.fields.НазначениеПлатежа !== "старое",
      );
      expect(made.map((o) => o.fields.СуммаДокумента)).toEqual([1000, 2000, 3000, 4000, 5000]);
      expect(made.every((o) => !o.posted)).toBe(true);
      expect(made[2]).toMatchObject({
        fields: { Дата: "2026-09-03", НазначениеПлатежа: "Оплата 3", НомерВходящегоДокумента: "103" },
        tables: { РасшифровкаПлатежа: [{ СуммаПлатежа: 3000, СуммаВзаиморасчетов: 3000 }] },
      });
      expect(events.filter((e) => e.type === "confirm")).toHaveLength(1);
      expect(resultOf(proxy.requests)).toMatchObject({
        status: "done",
        applied: expect.any(Array),
        failed: [],
      });
    });

    it("enters a move between the company's own accounts as a pair of documents copied from the company's last one", async () => {
      const ref = (type: string, id: string, name: string) => ({ type, ref: id, name });
      const [A, B] = ["20208000100438330001", "20208000200438330002"];
      const [refA, refB] = [crypto.randomUUID(), crypto.randomUUID()];
      const [outDoc, inDoc] = [crypto.randomUUID(), crypto.randomUUID()];
      const { assistant, store, company, events, proxy, base } = setup([
        () => [
          {
            type: "message" as const,
            stopReason: "tool_use",
            content: [
              { type: "tool_use", id: "t1", name: "propose_bank_payments", input: { title: "Moves" } },
            ],
          },
        ],
        () => [{ type: "message" as const, stopReason: "end_turn", content: [{ type: "text", text: "OK" }] }],
      ]);
      const earlier = (object: string, kind: string, shown: string) => ({
        object,
        fields: {
          Номер: "0000-000003",
          Дата: "2026-08-01T00:00:00",
          Проведен: true,
          ВидОперации: ref("Перечисление.ВидыОпераций", kind, shown),
          БанковскийСчет: ref("Справочник.БанковскиеСчета", crypto.randomUUID(), "старый"),
          СчетПолучатель: ref("Справочник.БанковскиеСчета", crypto.randomUUID(), "старый-2"),
          СуммаДокумента: 1000,
          НазначениеПлатежа: "старое",
        },
        tables: {},
        posted: true,
        deletionMark: false,
        version: 1,
      });
      base.objects.set(
        outDoc,
        earlier(
          "Документ.СписаниеСРасчетногоСчета",
          "ПереводНаДругойСчетОрганизации",
          "Перевод на другой счет организации",
        ),
      );
      base.objects.set(
        inDoc,
        earlier(
          "Документ.ПоступлениеНаРасчетныйСчет",
          "ПереводСДругогоСчетаОрганизации",
          "Перевод с другого счета организации",
        ),
      );
      const ownInn = base.organizations[0]!.inn;
      base.queryAnswers.unshift(
        {
          match: /Справочник\.БанковскиеСчета/,
          answer: () => ({
            columns: [],
            rows: [
              [A, ref("Справочник.БанковскиеСчета", refA, "р/с 1"), ownInn],
              [B, ref("Справочник.БанковскиеСчета", refB, "р/с 2"), ownInn],
            ],
            truncated: false,
          }),
        },
        {
          match: /СГРУППИРОВАТЬ ПО Т\.ВидОперации/,
          answer: (input) => {
            const out = String(input.query).includes("СписаниеСРасчетногоСчета");
            return {
              columns: [],
              rows: [
                [
                  ref(
                    out ? "Перечисление.ВидыОпераций" : "Перечисление.ВидыОпераций",
                    out ? "ПереводНаДругойСчетОрганизации" : "ПереводСДругогоСчетаОрганизации",
                    out ? "Перевод на другой счет организации" : "Перевод с другого счета организации",
                  ),
                  "2026-08-01T00:00:00",
                ],
              ],
              truncated: false,
            };
          },
        },
        {
          match: /Т\.ВидОперации = ЗНАЧЕНИЕ\(/,
          answer: (input) => {
            const out = String(input.query).includes("СписаниеСРасчетногоСчета");
            return {
              columns: [],
              rows: [
                [
                  ref(
                    out ? "Документ.СписаниеСРасчетногоСчета" : "Документ.ПоступлениеНаРасчетныйСчет",
                    out ? outDoc : inDoc,
                    "док",
                  ),
                ],
              ],
              truncated: false,
            };
          },
        },
        {
          match: /Т\.БанковскийСчет КАК Счет, Т\.Дата/,
          answer: () => ({ columns: [], rows: [], truncated: false }),
        },
      );
      store.setAiEnabled(company.id, true);
      const csv = (account: string, row: string) =>
        new TextEncoder().encode(
          [
            `Выписка по счёту ${account}`,
            "Дата;№ док;Наименование корреспондента;ИНН;№ счёта;Дебет;Кредит;Назначение платежа",
            row,
          ].join("\n"),
        );
      const sending = assistant.send({
        companyId: company.id,
        text: "Vypiskalarni kirit",
        files: [
          {
            name: "a.csv",
            data: csv(A, `10.09.2026;77;CRYSTAL;${ownInn};${B};250000,00;;Перевод между своими счетами`),
          },
          {
            name: "b.csv",
            data: csv(B, `10.09.2026;78;CRYSTAL;${ownInn};${A};;250000,00;Перевод между своими счетами`),
          },
        ],
      });
      await answerCards(events, assistant, true);
      await sending;

      const made = [...base.objects.values()].filter(
        (o) => o.fields.НазначениеПлатежа === "Перевод между своими счетами",
      );
      expect(made.map((o) => o.object).sort()).toEqual([
        "Документ.ПоступлениеНаРасчетныйСчет",
        "Документ.СписаниеСРасчетногоСчета",
      ]);
      const debit = made.find((o) => o.object === "Документ.СписаниеСРасчетногоСчета");
      expect(debit?.fields).toMatchObject({
        СуммаДокумента: 250000,
        БанковскийСчет: { ref: refA },
        СчетПолучатель: { ref: refB },
      });
      expect(made.every((o) => !o.posted)).toBe(true);
      expect(events.filter((e) => e.type === "confirm")).toHaveLength(1);
      const told = JSON.stringify(proxy.requests[1]?.messages.at(-1));
      expect(told).toContain("transfersEntered");
      expect(told).not.toContain("transfersBetweenOwnAccounts");
    });

    it("enters the period asked for from every attached statement in one run, and leaves out an account money only passes through", async () => {
      const ref = (type: string, id: string, name: string) => ({ type, ref: id, name });
      const ownAccount = crypto.randomUUID();
      const earlierPayment = crypto.randomUUID();
      const contract = crypto.randomUUID();
      const { assistant, store, company, events, proxy, base } = setup([
        () => [
          {
            type: "message" as const,
            stopReason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: "b1",
                name: "propose_bank_payments",
                input: { title: "Vypiska 2026-09", from: "2026-09-01", to: "2026-09-30" },
              },
            ],
          },
        ],
        () => [{ type: "message" as const, stopReason: "end_turn", content: [{ type: "text", text: "OK" }] }],
      ]);
      const counterparty = base.counterparties[0]!;
      base.objects.set(earlierPayment, {
        object: "Документ.ПоступлениеНаРасчетныйСчет",
        fields: {
          Номер: "0000-000007",
          Дата: "2026-07-01T00:00:00",
          Проведен: true,
          Контрагент: ref("Справочник.Контрагенты", counterparty.ref, counterparty.name),
          БанковскийСчет: ref("Справочник.БанковскиеСчета", crypto.randomUUID(), "старый"),
          СуммаДокумента: 1000,
          НазначениеПлатежа: "старое",
          НомерВходящегоДокумента: "55",
        },
        tables: {
          РасшифровкаПлатежа: [
            {
              ДоговорКонтрагента: ref("Справочник.ДоговорыКонтрагентов", contract, "№17"),
              СуммаПлатежа: 1000,
              КурсВзаиморасчетов: 1,
              СуммаВзаиморасчетов: 1000,
            },
          ],
        },
        posted: true,
        deletionMark: false,
        version: 1,
      });
      const values = (input: { params?: Record<string, unknown> }) => Object.values(input.params ?? {});
      base.queryAnswers.unshift(
        {
          match: /Справочник\.БанковскиеСчета/,
          answer: () => ({
            columns: [],
            rows: [[ref("Справочник.БанковскиеСчета", ownAccount, "р/с")]],
            truncated: false,
          }),
        },
        {
          match: /Справочник\.Контрагенты КАК Т ГДЕ Т\.ИНН В/,
          answer: (input) => ({
            columns: [],
            rows: base.counterparties
              .filter((c) => values(input).includes(c.inn))
              .map((c) => [c.inn, ref("Справочник.Контрагенты", c.ref, c.name), c.name]),
            truncated: false,
          }),
        },
        {
          match: /ПЕРВЫЕ 20 Т\.Ссылка/,
          answer: () => ({
            columns: [],
            rows: [[ref("Документ.ПоступлениеНаРасчетныйСчет", earlierPayment, "старый"), "старое"]],
            truncated: false,
          }),
        },
        { match: /Т\.Дата МЕЖДУ/, answer: () => ({ columns: [], rows: [], truncated: false }) },
      );
      store.setAiEnabled(company.id, true);
      const head = "Дата;№ док;Наименование корреспондента;ИНН;Дебет;Кредит;Назначение платежа";
      // Three payments in September, one in August (outside the period).
      const main = [
        "Выписка по счёту 20208000100438330001",
        head,
        `20.08.2026;100;${counterparty.name};${counterparty.inn};;900,00;Оплата август`,
        ...[1, 2, 3].map(
          (n) => `0${n}.09.2026;10${n};${counterparty.name};${counterparty.inn};;${n * 1000},00;Оплата ${n}`,
        ),
      ].join("\n");
      // The bank's transit account: takes in from the company's own account, pays out the same, opens and closes at zero.
      const transit = [
        "Выписка по счёту 16401000100438330001",
        "Остаток:;Начало дня;0;;Конец дня;0",
        "Дата;№ док;Наименование счёта;ИНН;№ счёта;Дебет;Кредит;Назначение платежа",
        "02.09.2026;1;OWN LLC;300000001;20208000100438330001;;120,00;Комиссия",
        "02.09.2026;1;Комиссионные доходы банка;207117389;45249000000001082160;120,00;;Комиссия",
      ].join("\n");

      const sending = assistant.send({
        companyId: company.id,
        text: "Vypiskalarni kirit",
        files: [
          { name: "main.csv", data: new TextEncoder().encode(main) },
          { name: "transit.csv", data: new TextEncoder().encode(transit) },
        ],
      });
      await answerCards(events, assistant, true);
      await sending;

      // The model was told what each account is, from the attach.
      expect(JSON.stringify(proxy.requests[0]?.messages[0])).toContain("pass_through");
      const made = [...base.objects.values()].filter(
        (o) => o.object === "Документ.ПоступлениеНаРасчетныйСчет" && o.fields.НазначениеПлатежа !== "старое",
      );
      // Only September's three payments of the main account; nothing from the transit account.
      expect(made.map((o) => o.fields.СуммаДокумента)).toEqual([1000, 2000, 3000]);
      expect(events.filter((e) => e.type === "confirm")).toHaveLength(1);
      const result = resultOf(proxy.requests) as { status: string; ledger: string; outsideThePeriod: number };
      expect(result).toMatchObject({ status: "done", outsideThePeriod: 1, passThroughRowsLeftOut: 2 });
      expect(result.ledger).toContain("pass_through");
    });

    it("creates a counterparty and its contract the statement names, then enters its payments: three cards, no model step", async () => {
      const ref = (type: string, id: string, name: string) => ({ type, ref: id, name });
      const supplier = crypto.randomUUID();
      const contract = crypto.randomUUID();
      const earlierPayment = crypto.randomUUID();
      const { assistant, store, company, events, proxy, base } = setup([
        () => [
          {
            type: "message" as const,
            stopReason: "tool_use",
            content: [
              { type: "tool_use", id: "n1", name: "propose_bank_payments", input: { title: "Vypiska: 5" } },
            ],
          },
        ],
        () => [{ type: "message" as const, stopReason: "end_turn", content: [{ type: "text", text: "OK" }] }],
      ]);
      // The company's usual supplier payment and its contract.
      base.objects.set(contract, {
        object: "Справочник.ДоговорыКонтрагентов",
        fields: {
          Код: "000000017",
          Наименование: "№17 от 08.01.2026",
          Владелец: ref("Справочник.Контрагенты", supplier, "Старый поставщик"),
          ВидДоговора: ref("Перечисление.ВидыДоговоровКонтрагентов", "СПоставщиком", "С поставщиком"),
          Номер: "17",
        },
        posted: false,
        deletionMark: false,
        version: 1,
      });
      base.objects.set(supplier, {
        object: "Справочник.Контрагенты",
        fields: { ИНН: "201607534", Наименование: "Старый поставщик" },
        posted: false,
        deletionMark: false,
        version: 1,
      });
      base.objects.set(earlierPayment, {
        object: "Документ.СписаниеСРасчетногоСчета",
        fields: {
          Проведен: true,
          Контрагент: ref("Справочник.Контрагенты", supplier, "Старый поставщик"),
          ДоговорКонтрагента: ref("Справочник.ДоговорыКонтрагентов", contract, "№17"),
          СуммаДокумента: 1000,
          НазначениеПлатежа: "старое",
        },
        tables: {
          РасшифровкаПлатежа: [
            {
              ДоговорКонтрагента: ref("Справочник.ДоговорыКонтрагентов", contract, "№17"),
              СуммаПлатежа: 1000,
              КурсВзаиморасчетов: 1,
              СуммаВзаиморасчетов: 1000,
            },
          ],
        },
        posted: true,
        deletionMark: false,
        version: 1,
      });
      const values = (input: { params?: Record<string, unknown> }) => Object.values(input.params ?? {});
      const none = () => ({ columns: [], rows: [], truncated: false });
      base.queryAnswers.unshift(
        { match: /Справочник\.БанковскиеСчета/, answer: none },
        {
          match: /Справочник\.Контрагенты КАК Т ГДЕ Т\.ИНН В/,
          answer: (input) => ({
            columns: [],
            rows: [...base.objects.entries()]
              .filter(
                ([, o]) => o.object === "Справочник.Контрагенты" && values(input).includes(o.fields.ИНН),
              )
              .map(([id, o]) => [
                String(o.fields.ИНН),
                ref(o.object, id, String(o.fields.Наименование)),
                String(o.fields.Наименование),
              ]),
            truncated: false,
          }),
        },
        {
          match: /Справочник\.ДоговорыКонтрагентов КАК Т ГДЕ Т\.Владелец\.ИНН В/,
          answer: (input) => ({
            columns: [],
            rows: [...base.objects.entries()].flatMap(([id, o]) => {
              if (o.object !== "Справочник.ДоговорыКонтрагентов") return [];
              const owner = base.objects.get(String((o.fields.Владелец as { ref?: string }).ref));
              if (!owner || !values(input).includes(owner.fields.ИНН)) return [];
              return [
                [
                  String(owner.fields.ИНН),
                  ref(o.object, id, String(o.fields.Номер)),
                  String(o.fields.Номер),
                  String(o.fields.Дата ?? ""),
                ],
              ];
            }),
            truncated: false,
          }),
        },
        {
          match: /ПЕРВЫЕ 300 Т\.Ссылка/,
          answer: () => ({
            columns: [],
            rows: [[ref("Документ.СписаниеСРасчетногоСчета", earlierPayment, "старый"), "старое"]],
            truncated: false,
          }),
        },
        { match: /Т\.Дата МЕЖДУ/, answer: none },
      );
      store.setAiEnabled(company.id, true);
      const rows = [1, 2, 3, 4, 5].map(
        (n) =>
          `0${n}.10.2026;50${n};Sam active group 786 mchj;310495297;${n * 1000},00;;Договор № 183 от 15.10.2026 оплата ${n}`,
      );
      const statement = [
        "Дата;№ док;Наименование корреспондента;ИНН;Дебет;Кредит;Назначение платежа",
        ...rows,
      ].join("\n");

      const sending = assistant.send({
        companyId: company.id,
        text: "Vypiskani kirit",
        files: [{ name: "vypiska.csv", data: new TextEncoder().encode(statement) }],
      });
      const answered = new Set<string>();
      const timer = setInterval(() => {
        for (const e of events) {
          if (e.type === "confirm" && !answered.has(e.id)) {
            answered.add(e.id);
            assistant.decide(e.companyId, e.id, true);
          }
        }
      }, 1);
      await sending;
      clearInterval(timer);

      // The counterparty, then its contract, then the payments: three cards, and the model took one step.
      const cards = events.flatMap((e) =>
        e.type === "confirm" && e.proposal.kind === "batch" ? [e.proposal] : [],
      );
      expect(cards.map((c) => c.items.length)).toEqual([1, 1, 5]);
      expect(cards.map((c) => c.items[0]?.object)).toEqual([
        "Справочник.Контрагенты",
        "Справочник.ДоговорыКонтрагентов",
        "Документ.СписаниеСРасчетногоСчета",
      ]);
      const made = [...base.objects.entries()];
      const counterparty = made.find(
        ([, o]) => o.object === "Справочник.Контрагенты" && o.fields.ИНН === "310495297",
      );
      expect(counterparty?.[1].fields).toMatchObject({
        Наименование: "Sam active group 786 mchj",
        НаименованиеПолное: "Sam active group 786 mchj",
      });
      const newContract = made.find(
        ([, o]) => o.object === "Справочник.ДоговорыКонтрагентов" && o.fields.Номер === "183",
      );
      expect(newContract?.[1].fields).toMatchObject({
        Владелец: { ref: counterparty?.[0] },
        Наименование: "№183 от 15.10.2026",
        ВидДоговора: "СПоставщиком",
      });
      const payments = made.filter(
        ([id, o]) => o.object === "Документ.СписаниеСРасчетногоСчета" && id !== earlierPayment,
      );
      expect(payments).toHaveLength(5);
      for (const [, payment] of payments) {
        expect(payment.posted).toBe(false);
        expect(payment.fields).toMatchObject({
          Контрагент: { ref: counterparty?.[0] },
          ДоговорКонтрагента: { ref: newContract?.[0] },
        });
      }
      expect(proxy.requests).toHaveLength(2);
      expect(resultOf(proxy.requests)).toMatchObject({
        status: "done",
        createdInThisRun: ["Sam active group 786 mchj (INN 310495297)", expect.stringContaining("contract")],
      });
    });

    it("posts what the chat created with one command and no list from the model", async () => {
      const call = (id: string, name: string, input: unknown) => () => [
        {
          type: "message" as const,
          stopReason: "tool_use",
          content: [{ type: "tool_use", id, name, input }],
        },
      ];
      let told: unknown;
      const { assistant, store, company, events, proxy, base } = setup([
        call("c1", "propose_changes", {
          title: "2 ta to'lov",
          defaults: { action: "create", object: "Документ.СписаниеСРасчетногоСчета", post: false },
          changes: [
            { fields: { Номер: "A1", СуммаДокумента: 100 } },
            { fields: { Номер: "A2", СуммаДокумента: 200 } },
          ],
        }),
        call("c2", "propose_post_created", { title: "2 ta hujjatni o'tkazish" }),
        (input) => {
          told = input.messages.at(-1);
          return call("c3", "propose_post_created", { title: "again" })();
        },
        () => [{ type: "message" as const, stopReason: "end_turn", content: [{ type: "text", text: "OK" }] }],
      ]);
      store.setAiEnabled(company.id, true);
      const sending = assistant.send({ companyId: company.id, text: "Kirit va o'tkaz" });
      const answered = new Set<string>();
      const timer = setInterval(() => {
        for (const e of events) {
          if (e.type === "confirm" && !answered.has(e.id)) {
            answered.add(e.id);
            assistant.decide(e.companyId, e.id, true);
          }
        }
      }, 1);
      await sending;
      clearInterval(timer);

      const documents = [...base.objects.values()].filter(
        (o) => o.object === "Документ.СписаниеСРасчетногоСчета",
      );
      expect(documents).toHaveLength(2);
      expect(documents.every((d) => d.posted)).toBe(true);
      // Two cards: the creation and the posting. The posting card is made by the app: updates, no list from the model.
      const cards = events.filter((e) => e.type === "confirm");
      expect(cards).toHaveLength(2);
      expect(cards[1]).toMatchObject({
        proposal: {
          kind: "batch",
          title: "2 ta hujjatni o'tkazish",
          items: [{ action: "update" }, { action: "update" }],
        },
      });
      // Asked again, there is nothing left to post and no third card.
      expect(JSON.stringify(told)).toContain('\\"status\\":\\"done\\"');
      expect(JSON.stringify(proxy.requests.at(-1)?.messages.at(-1))).toContain("nothing_to_post");
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
    // The accountant takes 1.5 s to answer the card: far longer than the work itself, even on a slow runner,
    // so the time counted can only be below the bound if the wait was left out.
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const card = events.find((e) => e.type === "confirm");
        if (card?.type !== "confirm") return;
        clearInterval(timer);
        setTimeout(() => {
          assistant.decide(card.companyId, card.id, false);
          resolve();
        }, 1500);
      }, 1);
    });
    await sending;
    const types = events.map((e) => e.type);
    expect(types.slice(-2)).toEqual(["done", "elapsed"]);
    const elapsed = events.at(-1);
    expect(elapsed?.type === "elapsed" && elapsed.ms).toBeLessThan(1000);
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
        {
          kind: "elapsed",
          ms: expect.any(Number),
          parts: { modelMs: expect.any(Number), onecMs: expect.any(Number), steps: 1, slowest: [] },
        },
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
      action: null,
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
        if (url === "/v1/ai/traces") return none();
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
    const traces = (t: ReturnType<typeof setup>) =>
      t.proxy.calls.filter((c) => c.url === "/v1/ai/traces").map((c) => c.body as Record<string, unknown>);
    const SALES_QUERY = "ВЫБРАТЬ Реализация ИЗ Документ.РеализацияТоваровУслуг ГДЕ ПродажиБезСчетаФактуры";
    const withSalesQuery = (t: ReturnType<typeof setup>) =>
      t.base.queryAnswers.unshift({
        match: /ПродажиБезСчетаФактуры/,
        answer: () => ({
          columns: ["Реализация"],
          rows: t.base.sales.map((sale) => [
            { type: "Документ.РеализацияТоваровУслуг", ref: sale.ref, name: sale.number },
          ]),
          truncated: false,
        }),
      });
    /** Answers the card the moment it appears. */
    const decideCard = async (t: ReturnType<typeof setup>, approve: boolean) => {
      await vi.waitFor(() => expect(t.events.some((e) => e.type === "confirm")).toBe(true));
      const card = t.events.find((e) => e.type === "confirm");
      if (card?.type !== "confirm") throw new Error("no card");
      t.assistant.decide(card.companyId, card.id, approve);
    };
    const invoiceTurns = (base: () => FakePlatform) => [
      () => [
        {
          type: "message" as const,
          stopReason: "tool_use",
          content: [
            { type: "tool_use", id: "q1", name: "run_query", input: { query: SALES_QUERY, refs: true } },
          ],
        },
      ],
      () => [
        {
          type: "message" as const,
          stopReason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "p1",
              name: "propose_invoices_issued",
              input: { title: "Счета-фактуры", sales: base().sales.map((s) => ({ ref: s.ref })) },
            },
          ],
        },
      ],
      text("Tayyor"),
    ];

    it("teaches the engine from the chats saved before: each question once, and what a live question already taught is not repeated", async () => {
      const t = setup([...oneQuery(), ...oneQuery()], "active", server({}));
      // Two questions in a chat made before the engine learned from them (no trace log then).
      await ask(t, "Какой остаток в кассе сегодня?");
      await t.assistant.send({
        companyId: t.company.id,
        text: "Сальдо по счетам сегодня",
      });
      await vi.waitFor(() => expect(traces(t)).toHaveLength(2));
      const before = traces(t).length;

      const log = new TraceLog(join(t.dir, "traced.json"));
      const later = new AssistantService({
        store: t.store,
        chats: t.chats,
        session: t.session,
        connector: new InProcessConnector(() => t.base),
        emit: () => undefined,
        traceLog: log,
      });
      expect(await later.backfillTraces()).toEqual({ sent: 2 });
      expect(traces(t)).toHaveLength(before + 2);
      expect(
        traces(t)
          .slice(before)
          .map((x) => x.question),
      ).toEqual(["Какой остаток в кассе сегодня?", "Сальдо по счетам сегодня"]);
      // Replayed once.
      expect(await later.backfillTraces()).toEqual({ sent: 0 });
      expect(traces(t)).toHaveLength(before + 2);
    });

    it("sends a trace of every finished question: the steps and how it ended, no data", async () => {
      const t = setup([...oneQuery(), text("Salom!")], "active", server({}));
      await ask(t, "Какой остаток в кассе сегодня?");
      await t.assistant.send({ companyId: t.company.id, text: "Привет" });
      await vi.waitFor(() => expect(traces(t)).toHaveLength(2));
      const [first, second] = traces(t);
      expect(first).toEqual({
        company: t.company.name,
        question: "Какой остаток в кассе сегодня?",
        outcome: "answered",
        steps: [
          {
            tool: "run_query",
            ok: true,
            query: "ВЫБРАТЬ Счет, СальдоДт ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки(&Дата)",
            params: { Дата: new Date().toISOString().slice(0, 10) },
            columns: ["Счет", "СальдоДт", "СальдоКт"],
            rowCount: 4,
            truncated: false,
          },
        ],
        // The rules found it could be a template: the question's words, the date as a parameter, the columns.
        learnable: {
          step: 0,
          phrase: "остаток кассе",
          query: "ВЫБРАТЬ Счет, СальдоДт ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки(&Дата)",
          params: [{ name: "Дата", type: "date" }],
          columns: [
            { label: "Счет", format: "text" },
            { label: "СальдоДт", format: "number" },
            { label: "СальдоКт", format: "number" },
          ],
          action: null,
        },
      });
      // A follow-up that read nothing is a trace too: every prompt teaches the engine.
      expect(second).toMatchObject({ question: "Привет", outcome: "answered", steps: [], learnable: null });
      expect(JSON.stringify(traces(t))).not.toContain("125000000");
    });

    it("finds nothing to learn in an answer with several reads, specifics in the question, or a declined card", async () => {
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
      const declined: ReturnType<typeof setup> = setup(
        invoiceTurns(() => declined.base),
        "active",
        server({}),
      );
      withSalesQuery(declined);
      declined.store.setAiEnabled(declined.company.id, true);
      const sending = declined.assistant.send({
        companyId: declined.company.id,
        text: "Выпиши счета фактуры по продажам",
      });
      await decideCard(declined, false);
      await sending;
      await vi.waitFor(() => expect(traces(declined)).toHaveLength(1));
      for (const t of [two, numbered, declined]) await vi.waitFor(() => expect(traces(t)).toHaveLength(1));
      expect(traces(two)[0]).toMatchObject({ outcome: "answered", learnable: null });
      expect(traces(numbered)[0]).toMatchObject({ outcome: "answered", learnable: null });
      expect(traces(declined)[0]).toMatchObject({ outcome: "card_declined", learnable: null });
    });

    it("notes that a confirmed card's documents were exactly the query's rows, so an action can be learned", async () => {
      const u: ReturnType<typeof setup> = setup(
        invoiceTurns(() => u.base),
        "active",
        server({}),
      );
      withSalesQuery(u);
      u.store.setAiEnabled(u.company.id, true);
      const sending = u.assistant.send({ companyId: u.company.id, text: "Выпиши счета фактуры по продажам" });
      await decideCard(u, true);
      expect(await sending).toEqual({ ok: true, data: null });
      expect(u.base.issued).toHaveLength(1);
      await vi.waitFor(() => expect(traces(u)).toHaveLength(1));
      const [trace] = traces(u);
      expect(trace).toMatchObject({
        outcome: "card_confirmed",
        steps: [
          { tool: "run_query", refs: true, rowCount: 1 },
          { tool: "propose_invoices_issued", status: "done", count: 1, fromQuery: { step: 0, column: 0 } },
        ],
        learnable: {
          step: 0,
          phrase: "выпиши счета фактуры продажам",
          action: { tool: "propose_invoices_issued", refsColumn: 0 },
        },
      });
    });

    const actionTemplate: QueryTemplateView = {
      ...balances,
      code: "learned_inv",
      title: "Счета-фактуры по продажам",
      intents: ["выпиши счета фактуры продажам"],
      query: SALES_QUERY,
      params: [],
      columns: [{ label: "Реализация", format: "text" }],
      action: { tool: "propose_invoices_issued", refsColumn: 0 },
      source: "learned",
      company: "ООО «Тест»",
    };

    it("does the action of a learned template without the model: a card from the query's rows, which the user confirms", async () => {
      const t = setup([], "active", server({ templates: [actionTemplate] }));
      withSalesQuery(t);
      t.store.setAiEnabled(t.company.id, true);
      const sending = t.assistant.send({ companyId: t.company.id, text: "Выпиши счета-фактуры по продажам" });
      await decideCard(t, true);
      expect(await sending).toEqual({ ok: true, data: null });
      // The model was never asked; the invoice was made only after the confirmation.
      expect(t.proxy.requests).toHaveLength(0);
      expect(t.base.issued).toHaveLength(1);
      expect(t.events.map((e) => e.type)).toEqual([
        "tool",
        "route",
        "confirm",
        "decided",
        "text",
        "done",
        "elapsed",
      ]);
      expect(t.events[1]).toMatchObject({ route: "template", learnedCode: "learned_inv" });
      expect(t.events[2]).toMatchObject({ proposal: { kind: "batch", title: "Счета-фактуры по продажам" } });
      expect((t.events[4] as { text: string }).text).toContain("✓ 1");
    });

    it("does the action for the counterparty the question names: found in this company's 1C, not guessed", async () => {
      const forCounterparty: QueryTemplateView = {
        ...actionTemplate,
        code: "learned_cp",
        title: "Счета-фактуры контрагенту",
        intents: ["hisob faktura yoz"],
        query: `${SALES_QUERY} И Контрагент.Наименование ПОДОБНО &Контрагент`,
        params: [{ name: "Контрагент", type: "counterparty" }],
      };
      const names = (list: string[]) => (t: ReturnType<typeof setup>) =>
        t.base.queryAnswers.unshift({
          match: /Справочник\.Контрагенты/,
          answer: () => ({ columns: ["Имя"], rows: list.map((n) => [n]), truncated: false }),
        });
      const queriesOf = (t: ReturnType<typeof setup>) =>
        t.base.calls
          .filter((c) => c.fn === "RunQuery")
          .map((c) => JSON.parse(String(c.arg)) as { query: string; params?: Record<string, string> });

      // One counterparty fits: the card is prepared for its sales, and the model is not asked.
      const one = setup([], "active", server({ templates: [forCounterparty] }));
      withSalesQuery(one);
      names(["TEXMASH IMPORT ООО"])(one);
      one.store.setAiEnabled(one.company.id, true);
      const sending = one.assistant.send({ companyId: one.company.id, text: "Texmashga hisob-faktura yoz" });
      await decideCard(one, true);
      expect(await sending).toEqual({ ok: true, data: null });
      expect(one.proxy.requests).toHaveLength(0);
      expect(one.base.issued).toHaveLength(1);
      const [find, sales] = queriesOf(one);
      expect(find?.params).toEqual({ Строка: "%texmashga%" }); // the fake 1C answers the first try
      expect(sales?.params).toEqual({ Контрагент: "TEXMASH IMPORT ООО" });

      // Two fit, or none: the model answers (and asks which one).
      for (const list of [["TEXMASH IMPORT ООО", "TEXMASH SAVDO"], []]) {
        const t = setup([text("Qaysi Texmash?")], "active", server({ templates: [forCounterparty] }));
        withSalesQuery(t);
        names(list)(t);
        await ask(t, "Texmash hisob-faktura yoz");
        expect(t.proxy.requests).toHaveLength(1);
        expect(t.events.some((e) => e.type === "confirm")).toBe(false);
        expect(t.base.issued).toHaveLength(0);
      }
    });

    it("writes nothing when the user declines a template's card", async () => {
      const t = setup([], "active", server({ templates: [actionTemplate] }));
      withSalesQuery(t);
      t.store.setAiEnabled(t.company.id, true);
      const sending = t.assistant.send({ companyId: t.company.id, text: "Выпиши счета-фактуры по продажам" });
      await decideCard(t, false);
      await sending;
      expect(t.base.issued).toHaveLength(0);
      expect(t.proxy.requests).toHaveLength(0);
    });

    it("says so when the template's query finds nothing to do, and leaves it to the model when it cannot prepare a card", async () => {
      const none = setup([], "active", server({ templates: [actionTemplate] }));
      none.base.queryAnswers.unshift({
        match: /ПродажиБезСчетаФактуры/,
        answer: () => ({ columns: ["Реализация"], rows: [], truncated: false }),
      });
      await ask(none, "Выпиши счета-фактуры по продажам");
      expect(none.proxy.requests).toHaveLength(0);
      expect(none.events.some((e) => e.type === "confirm")).toBe(false);
      expect(none.events.find((e) => e.type === "text")).toMatchObject({
        text: expect.stringContaining("Счета-фактуры по продажам"),
      });

      // A read-only license cannot write: no card, so the model takes the question.
      const readOnly = setup([text("Model")], "read_only", server({ templates: [actionTemplate] }));
      withSalesQuery(readOnly);
      await ask(readOnly, "Выпиши счета-фактуры по продажам");
      expect(readOnly.proxy.requests).toHaveLength(1);
      expect(readOnly.events.some((e) => e.type === "route")).toBe(false);
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

describe("found by the simulations", () => {
  const toolTurn = (id: string, name: string, input: unknown): AiEvent[] => [
    {
      type: "message",
      stopReason: "tool_use",
      content: [{ type: "tool_use", id, name, input }],
    },
  ];
  const endTurn = (): AiEvent[] => [
    { type: "text", text: "ok" },
    { type: "message", stopReason: "end_turn", content: [{ type: "text", text: "ok" }] },
  ];

  it("a tool call with no input at all is answered as an error, and the question goes on", async () => {
    const { assistant, store, company, proxy } = setup([
      () => toolTurn("tu_1", "run_query", null),
      () => endTurn(),
    ]);
    store.setAiEnabled(company.id, true);
    expect(await assistant.send({ companyId: company.id, text: "q" })).toEqual({ ok: true, data: null });
    const answered = proxy.requests[1]!.messages.at(-1)!.content as { is_error?: boolean }[];
    expect(answered[0]?.is_error).toBe(true);
  });

  it("answers the model's unanswered tool calls before the next question, so the API accepts the chat", async () => {
    const { assistant, store, company, proxy } = setup([
      () => toolTurn("tu_1", "list_organizations", {}),
      // The second step of the first question fails for good.
      () => new Response(JSON.stringify({ code: "BAD", message: "no" }), { status: 400 }),
      () => endTurn(),
    ]);
    store.setAiEnabled(company.id, true);
    const first = await assistant.send({ companyId: company.id, text: "first" });
    expect(first.ok).toBe(false);
    const chatId = (assistant.chats(company.id)[0] ?? { id: "" }).id;
    expect(await assistant.send({ companyId: company.id, chatId, text: "second" })).toEqual({
      ok: true,
      data: null,
    });
    // Every tool call in what the API gets has its result.
    const messages = proxy.requests.at(-1)!.messages;
    const calls = messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_use").map((b) => b["id"]) : [],
    );
    const results = messages.flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((b) => b.type === "tool_result").map((b) => b["tool_use_id"])
        : [],
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(results.sort()).toEqual(calls.sort());
  });
});
