/**
 * The cost engine's side on this PC: the limits it runs under (read from the server), the answers
 * it can give without the model (query templates, the answer cache), and the company's structure
 * digest. Everything here is best effort: when the server does not answer, or is an older version
 * without these endpoints, the assistant works as before and the model answers.
 */
import {
  type AiPolicy,
  type AnswerKey,
  DEFAULT_AI_POLICY,
  type QueryResult,
  type QueryTemplateView,
  type TraceInput,
} from "@platform/shared";

import type { ConnectionInput } from "../../shared/ipc.js";
import type { ConnectorRunner } from "../connector.js";
import type { SessionService } from "../session.js";
import { buildDigest } from "./digest.js";
import { matchTemplate, renderTemplate } from "./templates.js";

const POLICY_TTL_MS = 5 * 60_000;
const TEMPLATES_TTL_MS = 10 * 60_000;

export type FreeAnswer =
  | {
      route: "template";
      title: string;
      text: string;
      code: string;
      learned: boolean;
      /** The sales to prepare a card for (the template's action); the user still confirms it. */
      action?: { tool: "propose_invoices_issued"; sales: string[] };
    }
  | { route: "cache"; text: string; ageSeconds: number };

export class CostEngine {
  private policyCache: { at: number; policy: AiPolicy } | null = null;
  private templatesCache: { at: number; templates: QueryTemplateView[] } | null = null;
  /** Companies whose digest was checked in this session. */
  private readonly digestChecked = new Set<string>();
  /** Per company: how many writes this app made, so a cached answer never outlives one. */
  private readonly writes = new Map<string, number>();
  /** Changes with every start of the app: another PC's or an earlier run's writes are not known. */
  private readonly boot = Math.random().toString(36).slice(2, 8);

  constructor(
    private readonly session: SessionService,
    private readonly connector: ConnectorRunner,
  ) {}

  /** The limits now in force; the defaults when the server cannot say. */
  async policy(): Promise<AiPolicy> {
    if (this.policyCache && Date.now() - this.policyCache.at < POLICY_TTL_MS) return this.policyCache.policy;
    try {
      const { client, accessToken } = await this.session.authorized();
      const policy = await client.aiPolicy(accessToken);
      this.policyCache = { at: Date.now(), policy };
      return policy;
    } catch {
      return this.policyCache?.policy ?? DEFAULT_AI_POLICY;
    }
  }

  private async templates(): Promise<QueryTemplateView[]> {
    if (this.templatesCache && Date.now() - this.templatesCache.at < TEMPLATES_TTL_MS) {
      return this.templatesCache.templates;
    }
    try {
      const { client, accessToken } = await this.session.authorized();
      const templates = await client.aiTemplates(accessToken);
      this.templatesCache = { at: Date.now(), templates };
      return templates;
    } catch {
      return this.templatesCache?.templates ?? [];
    }
  }

  /** The books may have changed: answers stored before now are not used. */
  noteWrite(companyId: string): void {
    this.writes.set(companyId, (this.writes.get(companyId) ?? 0) + 1);
  }

  /** What a cached answer is valid for: the day, this run of the app, and the writes made in it. */
  dataVersion(companyId: string): string {
    return `${new Date().toISOString().slice(0, 10)}:${this.boot}:${this.writes.get(companyId) ?? 0}`;
  }

  /**
   * The answer to a question that needs no model: a template (a fixed 1C query), else a stored
   * answer to the same question. Null when the model has to answer.
   */
  async tryFree(
    companyId: string,
    companyName: string,
    connection: ConnectionInput,
    question: string,
    cacheable: boolean,
  ): Promise<FreeAnswer | null> {
    const policy = await this.policy();
    // A learned template is for the company it was learned in.
    const usable = (await this.templates()).filter((t) => !t.company || t.company === companyName);
    const matched = policy.templates ? matchTemplate(question, usable) : null;
    if (matched) {
      const { action } = matched.template;
      const result = await this.connector.tool(connection, "run_query", {
        query: matched.template.query,
        params: matched.params,
        limit: policy.maxRows,
        ...(action ? { refs: true } : {}),
      });
      if (result.ok) {
        const data = result.data as QueryResult;
        if (Array.isArray(data?.rows)) {
          const free: FreeAnswer = {
            route: "template",
            title: matched.template.title,
            text: renderTemplate(matched.template, data),
            code: matched.template.code,
            learned: matched.template.source === "learned",
          };
          if (action) {
            // The documents are whatever the query returns now. A result that is cut, or a row
            // without a reference, is not something to prepare a card from: the model takes it.
            const sales: string[] = [];
            for (const row of data.rows) {
              const cell = row[action.refsColumn] as { ref?: unknown } | null | undefined;
              if (typeof cell !== "object" || cell === null || typeof cell.ref !== "string") return null;
              sales.push(cell.ref);
            }
            if (data.truncated) return null;
            free.action = { tool: action.tool, sales };
          }
          await this.reportFree("template", companyName, question);
          return free;
        }
      }
      // The query failed here (another configuration, no rights): the model takes the question.
    }
    if (cacheable && policy.cacheTtlMinutes > 0) {
      const key: AnswerKey = { company: companyName, question, dataVersion: this.dataVersion(companyId) };
      try {
        const { client, accessToken } = await this.session.authorized();
        const hit = await client.lookupAnswer(accessToken, key);
        if (hit.hit) {
          await this.reportFree("cache", companyName, question);
          return { route: "cache", text: hit.answer, ageSeconds: hit.ageSeconds };
        }
      } catch {
        /* the cache is only a saving */
      }
    }
    return null;
  }

  /**
   * Tells the server what was done for a finished question, so the engine can learn from every
   * prompt (what became a template, what a card was made of, what it cost) without any data.
   */
  async sendTrace(trace: TraceInput): Promise<void> {
    const policy = await this.policy();
    if (!policy.learnTemplates) return;
    try {
      const { client, accessToken } = await this.session.authorized();
      await client.sendTrace(accessToken, trace);
    } catch {
      /* learning is only a saving */
    }
  }

  /** The user asked the model anyway after a learned template's answer: it is not used again. */
  async reject(code: string): Promise<void> {
    this.templatesCache = null;
    try {
      const { client, accessToken } = await this.session.authorized();
      await client.rejectTemplate(accessToken, code);
    } catch {
      /* the server keeps it on; the next answer can be rejected again */
    }
  }

  /** Keeps a finished answer to a read-only question, for the same question while the data is the same. */
  async remember(companyId: string, companyName: string, question: string, answer: string): Promise<void> {
    const policy = await this.policy();
    if (policy.cacheTtlMinutes === 0 || answer.length > 20_000) return;
    try {
      const { client, accessToken } = await this.session.authorized();
      await client.storeAnswer(accessToken, {
        company: companyName,
        question,
        dataVersion: this.dataVersion(companyId),
        answer,
      });
    } catch {
      /* the cache is only a saving */
    }
  }

  private async reportFree(route: "template" | "cache", company: string, question: string): Promise<void> {
    try {
      const { client, accessToken } = await this.session.authorized();
      await client.reportFreeAnswer(accessToken, { route, company, question });
    } catch {
      /* only the statistics are lost */
    }
  }

  /**
   * Makes sure the server has the digest of this base for its configuration version, building and
   * sending it when not. Once per company per run of the app, in the background.
   */
  ensureDigest(companyId: string, companyName: string, connection: ConnectionInput): void {
    if (this.digestChecked.has(companyId)) return;
    this.digestChecked.add(companyId);
    void (async () => {
      try {
        const check = await this.connector.check(connection);
        if (!check.status.ok) return;
        const { name, version } = check.status.ping.configuration;
        const { client, accessToken } = await this.session.authorized();
        const key = { company: companyName, configName: name, configVersion: version };
        if (await client.hasDigest(accessToken, key)) return;
        const digest = await buildDigest(this.connector, connection);
        if (digest) await client.putDigest(accessToken, { company: companyName, ...digest });
      } catch {
        /* an older server, or no connection: the model asks 1C as before */
      }
    })();
  }
}
