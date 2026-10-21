/**
 * Simulation: fake accounts acting as users. Several companies (each with its own standing rules) are driven by a
 * scripted model that behaves like the worst real ones: valid and broken tool calls, unknown tools, runaway
 * reading, calls that never end. Whatever it does, the engine must keep the conversation valid for the API (every
 * tool call answered once), stop at its caps, keep each company's rules apart and bounded, end every question
 * with exactly one done-or-error, and be ready for the next question.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { FakePlatform } from "@platform/onec-client/testing";
import type { AiChatInput, AiEvent } from "@platform/shared";
import { describe, expect, it } from "vitest";

import type { AssistantEvent } from "../../shared/ipc.js";
import { AssistantService } from "../assistant.js";
import { ChatStore } from "../chats.js";
import { InProcessConnector } from "../connector.js";
import { ControlClient } from "../control-client.js";
import type { SessionService } from "../session.js";
import { LocalStore, MAX_RULES, type SecretBox } from "../store.js";
import { cases, Rng, seed } from "./rng.js";

const secrets: SecretBox = { encrypt: (p) => `enc:${p}`, decrypt: (e) => e.slice(4) };
const MAX_TURNS = 25;

type ToolCall = { name: string; input: unknown };
/** What the scripted model does for a question: the tool calls of each of its steps, then it answers. */
interface Plan {
  steps: ToolCall[][];
  /** Never answers: every step calls a tool. */
  endless?: boolean;
  text: string;
}

const WORDS = [
  "касса",
  "банк",
  "ндс",
  "аренда",
  "импорт",
  "амортизация",
  "kassa",
  "qarz",
  "soliq",
  "payroll",
  "gtd",
  "акт сверки",
  "курсовая разница",
];
const sentence = (rng: Rng, n = 6) => Array.from({ length: n }, () => rng.pick(WORDS)).join(" ");

function validCalc(rng: Rng): Record<string, unknown> {
  switch (rng.int(0, 6)) {
    case 0:
      return {
        op: "vat",
        amount: rng.money(1, 1e8),
        rate: rng.pick([12, 15]),
        mode: rng.pick(["exclusive", "inclusive"]),
      };
    case 1:
      return {
        op: "loan",
        principal: rng.money(1e4, 1e9),
        annualRate: rng.int(0, 40),
        months: rng.int(1, 60),
        type: rng.pick(["annuity", "differentiated"]),
      };
    case 2:
      return {
        op: "allocate",
        total: rng.money(1, 1e7),
        weights: Array.from({ length: rng.int(1, 9) }, () => rng.int(1, 99)),
      };
    case 3:
      return {
        op: "depreciation",
        cost: rng.money(1e3, 1e8),
        periods: rng.int(1, 60),
        method: "straight_line",
      };
    case 4:
      return { op: "payroll", gross: rng.money(1e5, 1e8) };
    case 5:
      return { op: "penalty", principal: rng.money(1e3, 1e8), days: rng.int(0, 400), capPercent: 50 };
    default:
      return {
        op: "break_even",
        price: rng.money(10, 900),
        variableCost: rng.money(1, 800),
        fixedCosts: rng.money(0, 1e6),
      };
  }
}

function broken(rng: Rng, input: Record<string, unknown>): unknown {
  const keys = Object.keys(input);
  switch (rng.int(0, 5)) {
    case 0: {
      const dropped = rng.pick(keys);
      return Object.fromEntries(Object.entries(input).filter(([key]) => key !== dropped));
    }
    case 1:
      return { ...input, [rng.pick(keys)]: rng.pick(["abc", null, -1, 1e300, [], {}, "NaN"]) };
    case 2:
      return {};
    case 3:
      return "not an object";
    case 4:
      return null;
    default:
      return { op: "nonsense", ...input };
  }
}

function toolCall(rng: Rng): ToolCall {
  const kind = rng.int(0, 17);
  const maybeBreak = (name: string, input: Record<string, unknown>): ToolCall => ({
    name,
    input: rng.chance(0.25) ? broken(rng, input) : input,
  });
  switch (kind) {
    case 0:
    case 1:
      return maybeBreak("accounting_calc", validCalc(rng));
    case 2:
      return maybeBreak("accounting_knowledge", { query: sentence(rng, rng.int(1, 6)) });
    case 3:
      return { name: "accounting_knowledge", input: { query: rng.pick(["", "x", "я".repeat(1000)]) } };
    case 4:
      return maybeBreak("company_rules", { action: "add", rule: sentence(rng, rng.int(1, 12)) });
    case 5:
      return maybeBreak("company_rules", {
        action: "remove",
        which: rng.chance(0.5) ? rng.int(0, 120) : rng.pick(WORDS),
      });
    case 6:
      return { name: "company_rules", input: { action: "list" } };
    case 7:
    case 8:
      return maybeBreak("run_query", {
        query: `ВЫБРАТЬ Т.Счет.Код КАК Счет ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки(&Дата) КАК Т`,
        params: { Дата: rng.date() },
      });
    case 9:
      return maybeBreak("describe_objects", { objects: ["Документ.СчетФактураПолученный"] });
    case 10:
      return maybeBreak("get_object", {
        object: "Документ.СчетФактураПолученный",
        number: String(rng.int(1, 99)),
      });
    case 11:
      return { name: "list_organizations", input: {} };
    case 12:
      return { name: rng.pick(["delete_everything", "report_findings", "propose_unknown", ""]), input: {} };
    case 13:
      return { name: "read_attachment", input: rng.chance(0.5) ? { file: "none.xlsx" } : {} };
    case 14:
      return { name: "learn_accounting_policy", input: {} };
    case 15:
      return { name: "check_changes", input: rng.pick([{}, { changes: [] }, { changes: [{ junk: 1 }] }]) };
    case 16:
      return {
        name: rng.pick([
          "propose_bank_payments",
          "propose_didox_invoices",
          "propose_change",
          "propose_invoice_issued",
        ]),
        input: rng.pick([{}, { title: "x" }, null, "junk"]),
      };
    default:
      return {
        name: "fetch_didox_documents",
        input: rng.pick([{}, { from: "2026-13-45" }, { from: "2026-01-01", to: "2025-01-01" }]),
      };
  }
}

function planFor(rng: Rng): Plan {
  const kind = rng.int(0, 9);
  if (kind === 0) return { steps: [], text: "Just an answer." };
  if (kind === 1) return { steps: [], endless: true, text: "" };
  if (kind === 2) {
    // A model that keeps reading 1C: far past the read budget.
    const read = () => ({ name: "run_query", input: { query: "ВЫБРАТЬ 1 КАК X", params: {} } });
    return {
      steps: Array.from({ length: 14 }, () => [read(), read(), read(), read(), read()]),
      text: "Done reading.",
    };
  }
  const steps = Array.from({ length: rng.int(1, 8) }, () =>
    Array.from({ length: rng.int(1, 4) }, () => toolCall(rng)),
  );
  return { steps, text: "Here is the answer." };
}

interface Session {
  companyId: string;
  plan: Plan;
}

function makeWorld(companies: number) {
  const base = new FakePlatform();
  const dir = mkdtempSync(join(tmpdir(), "sim-"));
  const store = new LocalStore(join(dir, "p.json"), secrets);
  const chats = new ChatStore(join(dir, "chats"), secrets);
  const ids: string[] = [];
  for (let k = 0; k < companies; k++) {
    const company = store.addCompany(
      {
        infobase: { kind: "file", file: `D:\\Bases\\C${k}` },
        user: "Admin",
        password: "pw",
        organization: { ...base.organizations[0]!, name: `Company ${k}`, inn: String(300000000 + k) },
      },
      { ok: false, checkedAt: "", code: "X", message: "" },
    );
    store.setAiEnabled(company.id, true);
    ids.push(company.id);
  }
  const current: { plan: Plan; company: string; asked: number } = {
    plan: { steps: [], text: "" },
    company: "",
    asked: 0,
  };
  const requests: { company: string; input: AiChatInput }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    if (!u.pathname.startsWith("/v1/ai/chat")) {
      return new Response(JSON.stringify({ code: "NOT_FOUND", message: "No such endpoint" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const encoding = (init?.headers as Record<string, string> | undefined)?.["content-encoding"];
    const raw = encoding === "gzip" ? gunzipSync(init?.body as Buffer).toString() : String(init?.body);
    const input = JSON.parse(raw) as AiChatInput;
    requests.push({ company: input.company, input: structuredClone(input) });
    // The step of this question: the assistant turns since the last message the user typed.
    let step = 0;
    for (let i = input.messages.length - 1; i >= 0; i--) {
      const m = input.messages[i]!;
      if (m.role === "user" && !(Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result")))
        break;
      if (m.role === "assistant") step++;
    }
    const { plan } = current;
    const calls = plan.steps[step] ?? (plan.endless ? [{ name: "list_organizations", input: {} }] : null);
    if (!calls) {
      const events: AiEvent[] = [
        { type: "text", text: plan.text },
        { type: "message", stopReason: "end_turn", content: [{ type: "text", text: plan.text }] },
      ];
      return new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", {
        headers: { "content-type": "application/x-ndjson" },
      });
    }
    const content = calls.map((c, k) => ({
      type: "tool_use",
      id: `tu_${requests.length}_${k}`,
      name: c.name,
      input: c.input,
    }));
    const events: AiEvent[] = [{ type: "message", stopReason: "tool_use", content }];
    return new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", {
      headers: { "content-type": "application/x-ndjson" },
    });
  };
  const session = {
    authorized: async () => ({
      client: new ControlClient("https://control.test", fetchImpl),
      accessToken: "access",
    }),
    view: async () => ({ license: { mode: "active" } }),
  } as unknown as SessionService;
  const events: AssistantEvent[] = [];
  const assistant = new AssistantService({
    store,
    chats,
    session,
    connector: new InProcessConnector(() => base),
    emit: (e) => events.push(e),
    retryDelaysMs: [1, 1, 1],
    maxTurns: MAX_TURNS,
    learnPolicy: false,
  });
  return { assistant, store, ids, current, requests, events };
}

/** The conversation as the API checks it: every tool call answered by exactly one result, in the next message. */
function validConversation(input: AiChatInput): string | null {
  const seen = new Set<string>();
  for (let i = 0; i < input.messages.length; i++) {
    const m = input.messages[i]!;
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const ids = m.content.filter((b) => b.type === "tool_use").map((b) => String(b["id"]));
    if (ids.length === 0) continue;
    for (const id of ids) {
      if (seen.has(id)) return `tool call id ${id} used twice`;
      seen.add(id);
    }
    const next = input.messages[i + 1];
    if (!next) {
      // Only the last request of a turn may end on the model's own message, never on unanswered calls.
      return `unanswered tool calls ${ids.join(",")}`;
    }
    const answers = (Array.isArray(next.content) ? next.content : [])
      .filter((b) => b.type === "tool_result")
      .map((b) => String(b["tool_use_id"]));
    if (next.role !== "user" || answers.length !== ids.length || ids.some((id) => !answers.includes(id)))
      return `tool calls ${ids.join(",")} answered by ${answers.join(",")}`;
  }
  return null;
}

describe("simulation: fake accounts act as users", () => {
  it("thousands of questions from several companies, whatever the model does", async () => {
    const rng = new Rng(seed(80));
    const world = makeWorld(4);
    const bad: string[] = [];
    const n = cases(250);
    for (let i = 0; i < n; i++) {
      const sess: Session = { companyId: rng.pick(world.ids), plan: planFor(rng) };
      // A rule says whose it is, so a rule showing up in another company's request can be told from a repeated phrase.
      const tag = `[${world.store.company(sess.companyId).name}]`;
      for (const step of sess.plan.steps)
        for (const call of step) {
          const input = call.input as { action?: string; rule?: string } | null;
          if (
            call.name === "company_rules" &&
            input &&
            typeof input === "object" &&
            input.action === "add" &&
            typeof input.rule === "string"
          )
            input.rule = `${input.rule} ${tag}`;
        }
      world.current.plan = sess.plan;
      const from = world.events.length;
      const before = world.requests.length;
      let result;
      try {
        result = await world.assistant.send({
          companyId: sess.companyId,
          text: `Question ${i}: ${sentence(rng, 4)}`,
        });
      } catch (e) {
        bad.push(`#${i} send threw: ${String(e)}`);
        continue;
      }
      const mine = world.events.slice(from).filter((e) => e.companyId === sess.companyId);
      const terminals = mine.filter((e) => e.type === "done" || e.type === "error");
      if (terminals.length !== 1)
        bad.push(`#${i} ${terminals.length} terminal events (${terminals.map((e) => e.type)})`);
      const used = world.requests.length - before;
      if (used > MAX_TURNS) bad.push(`#${i} ${used} model steps, cap ${MAX_TURNS}`);
      if (sess.plan.endless) {
        if (result.ok || result.code !== "AI_TOO_MANY_STEPS")
          bad.push(`#${i} endless model: ${JSON.stringify(result)}`);
      } else if (!result.ok) {
        // A plan of at most 14 steps always fits; the only failure allowed is none.
        bad.push(`#${i} failed: ${result.code} ${result.message}`);
      }
      for (const r of world.requests.slice(before)) {
        const problem = validConversation(r.input);
        if (problem) bad.push(`#${i} invalid conversation: ${problem}`);
      }
      // A chat per company: start a new one now and then so a long soak does not hit the size cap.
      if (rng.chance(0.15)) world.assistant.reset(sess.companyId);
      if (bad.length > 20) break;
    }
    expect(bad.slice(0, 10), `${bad.length} problems`).toEqual([]);

    // Each company's rules are its own, bounded, and short.
    for (const id of world.ids) {
      const rules = world.store.rules(id);
      expect(rules.length).toBeLessThanOrEqual(MAX_RULES);
      for (const r of rules) expect(r.length).toBeLessThanOrEqual(400);
    }
    // The rules a request carries are the asking company's, never another's.
    const names = world.ids.map((id) => world.store.company(id).name);
    for (const r of world.requests.slice(-400)) {
      for (const name of names) {
        if (name === r.company) continue;
        expect(r.input.policy ?? "", `${r.company} got a rule of ${name}`).not.toContain(`[${name}]`);
      }
    }
  }, 120_000);

  it("the read budget stops a model that keeps reading 1C", async () => {
    const world = makeWorld(1);
    world.current.plan = {
      steps: Array.from({ length: 14 }, () =>
        Array.from({ length: 5 }, () => ({
          name: "run_query",
          input: { query: "ВЫБРАТЬ 1 КАК X", params: {} },
        })),
      ),
      text: "ok",
    };
    const result = await world.assistant.send({ companyId: world.ids[0]!, text: "read everything" });
    expect(result.ok).toBe(true);
    const last = world.requests.at(-1)!.input.messages;
    const results = last
      .filter((m) => m.role === "user" && Array.isArray(m.content))
      .flatMap((m) =>
        (m.content as { type: string; content?: string }[]).filter((b) => b.type === "tool_result"),
      );
    expect(results).toHaveLength(70);
    expect(results.filter((r) => String(r.content).includes("READ_BUDGET"))).toHaveLength(30);
  });
});
