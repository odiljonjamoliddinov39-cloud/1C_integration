import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakePlatform } from "@platform/onec-client/testing";
import { AI_TOOLS, type AiChatInput, type AiEvent } from "@platform/shared";
import { describe, expect, it } from "vitest";

import type { AssistantEvent } from "../shared/ipc.js";
import { AssistantService } from "./assistant.js";
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

function setup(script: Parameters<typeof fakeProxy>[0], licenseMode: "active" | "read_only" = "active") {
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
  const proxy = fakeProxy(script);
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
      tools: Object.keys(AI_TOOLS),
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
            source: { type: "text", media_type: "text/plain", data: "Контрагент;Сумма\nООО Тест;1500000" },
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
          ],
        },
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
        data: { entries: [{ kind: "user" }, { kind: "assistant", text: "125 mln so'm." }] },
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
});
