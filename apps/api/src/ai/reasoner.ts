/**
 * The engine's reasoning. Every finished question leaves a trace; the reasoner (Claude, a cheap
 * model by default) looks at the questions that were answered by the same query, decides whether
 * they are one stable, reusable question and writes the template: its title and the wordings that
 * should trigger it. Rules do the rest and the checks: the query and its parameters are exactly what
 * the app recorded, the wordings must pass the matcher's limits, and a template for an action is
 * made only from cards the user confirmed whose documents were exactly the query's result.
 * A template is for one company; "Ask AI anyway" turns it off.
 */
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type {
  AiPolicy,
  TemplateAction,
  TemplateColumn,
  TemplateParam,
  TraceLearnable,
} from "@platform/shared";

import type { Db } from "../db/client.js";
import { aiTraces, queryTemplates, templateGroups, users } from "../db/schema.js";
import { type AiModel, usageOf } from "./model.js";
import { sha } from "./traces.js";
import { logUsage } from "./usage.js";

const MAX_QUESTIONS_SHOWN = 12;
const MAX_ATTEMPTS = 3;

const Decision = z.object({
  reusable: z.boolean(),
  reason: z.string().max(400).default(""),
  title: z.string().max(200).default(""),
  phrases: z.array(z.string()).max(30).default([]),
  column_labels: z.array(z.string()).max(60).default([]),
});
type Decision = z.infer<typeof Decision>;

export const REASONER_PROMPT = `You maintain the query templates of an accounting assistant for accountants in Uzbekistan (1C:Бухгалтерия). \
Accountants ask in Russian, Uzbek (Latin or Cyrillic) or English. Each time a question was answered, the assistant ran read-only 1C queries; \
sometimes it then prepared a card (documents) that the accountant confirmed.

You are shown one group: questions that were answered by the same query. A template answers such a question next time with that query, \
without the assistant, and for an action it prepares the same card from the query's result (the accountant still confirms it). A wrong \
template gives a wrong answer with nobody to catch it, so be strict.

Decide:
- reusable: true only if (a) all the questions ask for the same thing, (b) the query and its columns fully answer it (nothing in the questions \
is a condition the query does not have: a counterparty, an amount, a document number, a one-time period, an account the query ignores), and \
(c) for an action: the questions clearly ask for that action, on whatever the query selects. The dates and months in the questions are \
parameters of the query, they are not specifics. When unsure, false.
- title: a short name for the question, in the language most of the questions use.
- phrases: 3 to 10 short wordings that mean exactly this question, in the languages the accountants use (the ones seen, and likely \
rewordings). Each has at least two meaningful words and no numbers, names, dates or months. Do not add wordings that mean something broader or different.
- column_labels: a readable label for each result column, in the title's language, same number as the columns; or [] to keep the names.
- reason: one sentence.

Answer with one JSON object only: {"reusable": boolean, "reason": string, "title": string, "phrases": string[], "column_labels": string[]}`;

/** A wording the matcher can use: at least two words, no numbers or quotes, not long. */
function usablePhrase(text: string): string | null {
  const phrase = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (/[\d"«»“”]/.test(phrase) || phrase.length < 5 || phrase.length > 200) return null;
  const words = phrase.split(" ").filter((w) => w.length > 1);
  return words.length >= 2 && words.length <= 10 ? words.join(" ") : null;
}

interface Group {
  accountId: string;
  company: string;
  groupKey: string;
  learnable: TraceLearnable;
  query: string;
  questions: Map<string, number>;
  latest: string;
  hits: number;
}

export class Reasoner {
  private readonly running = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly db: Db,
    private readonly model: AiModel | null,
    private readonly log: { error: (obj: unknown, msg?: string) => void },
    private readonly delayMs = 5_000,
  ) {}

  /** After a trace: reasoning runs soon, once for a burst of questions. */
  schedule(accountId: string, policy: () => Promise<AiPolicy>): void {
    if (!this.model || this.timers.has(accountId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(accountId);
      void policy()
        .then((p) => this.run(accountId, p))
        .catch((error: unknown) => this.log.error(error, "The engine's reasoning failed"));
    }, this.delayMs);
    timer.unref();
    this.timers.set(accountId, timer);
  }

  /** Looks at the account's traces and decides every group that has enough of them. */
  async run(accountId: string, policy: AiPolicy): Promise<{ decided: number; made: number }> {
    if (!this.model || !policy.learnTemplates || this.running.has(accountId)) return { decided: 0, made: 0 };
    this.running.add(accountId);
    try {
      let decided = 0;
      let made = 0;
      for (const group of await this.groups(accountId)) {
        const [row] = await this.db
          .insert(templateGroups)
          .values({
            accountId,
            company: group.company,
            groupKey: group.groupKey,
            phrase: group.learnable.phrase,
            question: group.latest,
            action: group.learnable.action?.tool ?? null,
            hits: group.hits,
          })
          .onConflictDoUpdate({
            target: [templateGroups.accountId, templateGroups.company, templateGroups.groupKey],
            set: { hits: group.hits, question: group.latest, updatedAt: new Date() },
          })
          .returning();
        if (!row || row.status !== "pending" || row.attempts >= MAX_ATTEMPTS) continue;
        if (!policy.reasoner || group.hits < policy.learnMinHits) continue;
        decided += 1;
        if (await this.decide(accountId, policy, group, row.id)) made += 1;
      }
      return { decided, made };
    } finally {
      this.running.delete(accountId);
    }
  }

  private async groups(accountId: string): Promise<Group[]> {
    const rows = await this.db
      .select()
      .from(aiTraces)
      .where(
        and(eq(aiTraces.accountId, accountId), inArray(aiTraces.outcome, ["answered", "card_confirmed"])),
      )
      .orderBy(desc(aiTraces.createdAt))
      .limit(1500);
    const groups = new Map<string, Group>();
    for (const row of rows) {
      const learnable = row.learnable as TraceLearnable | null;
      const step = learnable ? (row.steps[learnable.step] as { query?: string } | undefined) : undefined;
      if (!learnable || !row.groupKey || !step?.query) continue;
      const key = `${row.company}|${row.groupKey}`;
      const group =
        groups.get(key) ??
        ({
          accountId,
          company: row.company,
          groupKey: row.groupKey,
          learnable,
          query: step.query,
          questions: new Map(),
          latest: row.question,
          hits: 0,
        } satisfies Group);
      group.hits += 1;
      group.questions.set(row.question, (group.questions.get(row.question) ?? 0) + 1);
      groups.set(key, group);
    }
    return [...groups.values()];
  }

  /** Asks Claude about one group; makes the template when it is reusable. Returns whether one was made. */
  private async decide(accountId: string, policy: AiPolicy, group: Group, groupId: string): Promise<boolean> {
    const code = `learned_${sha(`${accountId}|${group.company}|${group.groupKey}`).slice(0, 12)}`;
    const [existing] = await this.db
      .select({ id: queryTemplates.id })
      .from(queryTemplates)
      .where(eq(queryTemplates.code, code));
    if (existing) {
      await this.settle(groupId, "accepted", "A template exists.");
      return false;
    }
    let decision: Decision | null = null;
    try {
      decision = await this.ask(accountId, policy, group);
    } catch (error) {
      this.log.error(error, "The reasoner could not decide a group");
    }
    if (!decision) {
      await this.db
        .update(templateGroups)
        .set({ attempts: (await this.attempts(groupId)) + 1, updatedAt: new Date() })
        .where(eq(templateGroups.id, groupId));
      return false;
    }

    const phrases = [...new Set(decision.phrases.map(usablePhrase).filter((p): p is string => p !== null))];
    if (!decision.reusable || !decision.title.trim()) {
      await this.settle(groupId, "rejected", decision.reason || "Not reusable.");
      return false;
    }
    const intents = [...new Set([...phrases, group.learnable.phrase])];
    const columns = group.learnable.columns.map((column, i) => ({
      ...column,
      label:
        decision.column_labels.length === group.learnable.columns.length
          ? decision.column_labels[i]?.trim() || column.label
          : column.label,
    }));
    await this.db
      .insert(queryTemplates)
      .values({
        code,
        accountId,
        company: group.company,
        source: "learned",
        hits: group.hits,
        title: decision.title.trim().slice(0, 120),
        intents,
        onecQuery: group.query,
        params: group.learnable.params,
        resultLayout: { columns, totals: false },
        action: group.learnable.action,
      })
      .onConflictDoNothing();
    await this.settle(groupId, "accepted", decision.reason);
    return true;
  }

  private async attempts(groupId: string): Promise<number> {
    const [row] = await this.db
      .select({ attempts: templateGroups.attempts })
      .from(templateGroups)
      .where(eq(templateGroups.id, groupId));
    return row?.attempts ?? 0;
  }

  private async settle(groupId: string, status: "accepted" | "rejected", reason: string): Promise<void> {
    await this.db
      .update(templateGroups)
      .set({ status, reason: reason.slice(0, 400), updatedAt: new Date() })
      .where(eq(templateGroups.id, groupId));
  }

  private async ask(accountId: string, policy: AiPolicy, group: Group): Promise<Decision | null> {
    if (!this.model) return null;
    const questions = [...group.questions.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_QUESTIONS_SHOWN)
      .map(([question, times]) => ({ question, times }));
    const brief = {
      company: group.company,
      query: group.query,
      parameters: group.learnable.params.map((p: z.infer<typeof TemplateParam>) => `${p.name}: ${p.type}`),
      columns: group.learnable.columns.map((c: z.infer<typeof TemplateColumn>) => `${c.label} (${c.format})`),
      then_the_accountant_confirmed_a_card_of:
        group.learnable.action === null
          ? null
          : `${(group.learnable.action as z.infer<typeof TemplateAction>).tool}: its documents were exactly the rows of the query`,
      questions,
    };
    const params: BetaMessageStreamParams = {
      model: policy.reasonerModel,
      max_tokens: 1_500,
      system: REASONER_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(brief, null, 1) }],
    };
    const message = await this.model.turn(params, { onText: () => undefined }, new AbortController().signal);
    await logUsage(
      this.db,
      {
        accountId,
        userId: await this.someUser(accountId),
        company: group.company,
        feature: "engine",
        route: "model",
        toolCalls: 0,
        firstStep: false,
        question: `engine: ${group.learnable.phrase}`.slice(0, 200),
      },
      usageOf(message),
    ).catch((error: unknown) => this.log.error(error, "The engine's usage was not recorded"));
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const json = /\{[\s\S]*\}/.exec(text)?.[0];
    if (!json) return null;
    try {
      const parsed = Decision.safeParse(JSON.parse(json));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** ai_usage needs a user; the engine's reasoning belongs to the account's first one. */
  private async someUser(accountId: string): Promise<string> {
    const [row] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.accountId, accountId))
      .limit(1);
    return row?.id ?? accountId;
  }
}
