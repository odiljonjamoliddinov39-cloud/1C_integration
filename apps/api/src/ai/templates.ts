/**
 * Query templates: known questions answered by a fixed 1C query. Two kinds. Admin templates are
 * written in the dashboard and apply to everyone. Learned templates come from a company's own
 * questions: when the model answers a question with one successful query, the app tells the server;
 * after the same question has been answered by the same query a few times (policy.learnMinHits) it
 * becomes a template for that company only. Pressing "Ask AI anyway" on its answer turns it off.
 */
import { createHash } from "node:crypto";

import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import type {
  AiPolicy,
  LearnInput,
  QueryTemplateInput,
  QueryTemplateView,
  TemplateCandidateView,
} from "@platform/shared";

import type { Db } from "../db/client.js";
import { accounts, queryTemplates, templateCandidates } from "../db/schema.js";

type Row = typeof queryTemplates.$inferSelect;

function view(row: Row, accountName: string | null = null): QueryTemplateView {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    intents: row.intents,
    query: row.onecQuery,
    params: row.params as QueryTemplateView["params"],
    columns: row.resultLayout.columns as QueryTemplateView["columns"],
    totals: row.resultLayout.totals,
    enabled: row.enabled,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    source: row.source,
    company: row.company,
    accountName,
    hits: row.hits,
    rejected: row.rejected,
  };
}

/** The templates the app may use: the admin ones, and this account's learned ones. */
export async function templatesForAccount(db: Db, accountId: string): Promise<QueryTemplateView[]> {
  const rows = await db
    .select()
    .from(queryTemplates)
    .where(
      and(
        eq(queryTemplates.enabled, true),
        or(isNull(queryTemplates.accountId), eq(queryTemplates.accountId, accountId)),
      ),
    )
    .orderBy(asc(queryTemplates.code));
  return rows.map((row) => view(row));
}

/** Every template, for the dashboard. */
export async function listTemplates(db: Db): Promise<QueryTemplateView[]> {
  const rows = await db
    .select({ template: queryTemplates, accountName: accounts.name })
    .from(queryTemplates)
    .leftJoin(accounts, eq(accounts.id, queryTemplates.accountId))
    .orderBy(asc(queryTemplates.source), asc(queryTemplates.code));
  return rows.map(({ template, accountName }) => view(template, accountName));
}

/** Creates the template, or replaces the one with this code (its version goes up). */
export async function saveTemplate(
  db: Db,
  input: QueryTemplateInput,
  adminId: string,
): Promise<QueryTemplateView> {
  const values = {
    title: input.title,
    intents: input.intents,
    onecQuery: input.query,
    params: input.params,
    resultLayout: { columns: input.columns, totals: input.totals },
    enabled: input.enabled,
    updatedAt: new Date(),
    updatedBy: adminId,
  };
  const [existing] = await db.select().from(queryTemplates).where(eq(queryTemplates.code, input.code));
  if (existing) {
    const [row] = await db
      .update(queryTemplates)
      .set({ ...values, version: existing.version + 1 })
      .where(eq(queryTemplates.id, existing.id))
      .returning();
    return view(row as Row);
  }
  const [row] = await db
    .insert(queryTemplates)
    .values({ code: input.code, ...values })
    .returning();
  return view(row as Row);
}

export async function deleteTemplate(db: Db, id: string): Promise<string | null> {
  const [row] = await db.delete(queryTemplates).where(eq(queryTemplates.id, id)).returning();
  return row?.code ?? null;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** The same words in another order are the same question. */
const phraseKey = (phrase: string) => [...new Set(phrase.toLowerCase().split(/\s+/))].sort().join(" ");

/**
 * Counts one sighting of "this question was answered by this query". Returns true when it made a
 * new template. A phrase that already has a template (on, off or rejected) never gets another.
 */
export async function learn(
  db: Db,
  policy: AiPolicy,
  accountId: string,
  input: LearnInput,
): Promise<boolean> {
  if (!policy.learnTemplates) return false;
  const key = phraseKey(input.phrase);
  const code = `learned_${sha(`${accountId}|${input.company}|${key}`).slice(0, 12)}`;
  const [existing] = await db
    .select({ id: queryTemplates.id })
    .from(queryTemplates)
    .where(eq(queryTemplates.code, code));
  if (existing) return false;

  const [candidate] = await db
    .insert(templateCandidates)
    .values({
      accountId,
      company: input.company,
      phraseKey: key,
      phrase: input.phrase,
      question: input.question,
      queryHash: sha(input.query),
      query: input.query,
      params: input.params,
      columns: input.columns,
    })
    .onConflictDoUpdate({
      target: [
        templateCandidates.accountId,
        templateCandidates.company,
        templateCandidates.phraseKey,
        templateCandidates.queryHash,
      ],
      set: { hits: sql`${templateCandidates.hits} + 1`, lastAt: new Date(), question: input.question },
    })
    .returning();
  if (!candidate || candidate.hits < policy.learnMinHits) return false;

  await db
    .insert(queryTemplates)
    .values({
      code,
      accountId,
      company: input.company,
      source: "learned",
      hits: candidate.hits,
      title: input.question.slice(0, 120),
      intents: [input.phrase],
      onecQuery: input.query,
      params: input.params,
      resultLayout: { columns: input.columns, totals: false },
    })
    .onConflictDoNothing();
  return true;
}

/** "Ask AI anyway" on a learned template's answer: this account's template is turned off. */
export async function rejectLearned(db: Db, accountId: string, code: string): Promise<void> {
  await db
    .update(queryTemplates)
    .set({ enabled: false, rejected: sql`${queryTemplates.rejected} + 1`, updatedAt: new Date() })
    .where(
      and(
        eq(queryTemplates.code, code),
        eq(queryTemplates.accountId, accountId),
        eq(queryTemplates.source, "learned"),
      ),
    );
}

/** Questions being learned that are not templates yet, for the dashboard. */
export async function candidates(db: Db): Promise<TemplateCandidateView[]> {
  const rows = await db
    .select({ candidate: templateCandidates, accountName: accounts.name })
    .from(templateCandidates)
    .innerJoin(accounts, eq(accounts.id, templateCandidates.accountId))
    .orderBy(sql`${templateCandidates.hits} desc`, sql`${templateCandidates.lastAt} desc`)
    .limit(100);
  return rows.map(({ candidate, accountName }) => ({
    accountName,
    company: candidate.company,
    phrase: candidate.phrase,
    question: candidate.question,
    hits: candidate.hits,
    lastAt: candidate.lastAt.toISOString(),
  }));
}
