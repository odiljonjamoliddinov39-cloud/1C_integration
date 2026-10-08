/**
 * Query templates: known questions answered by a fixed 1C query. Two kinds. Admin templates are
 * written in the dashboard and apply to everyone. Learned templates are made by the engine's
 * reasoner (see reasoner.ts) from a company's own finished questions and apply to that company
 * only. Pressing "Ask AI anyway" on a learned answer turns it off.
 */
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import type {
  QueryTemplateInput,
  QueryTemplateView,
  TemplateAction,
  TemplateGroupView,
} from "@platform/shared";

import type { Db } from "../db/client.js";
import { accounts, queryTemplates, templateGroups } from "../db/schema.js";

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
    action: (row.action as TemplateAction | null) ?? null,
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
    action: input.action,
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

/** What the engine is learning, for the dashboard: the groups of questions and what was decided. */
export async function groups(db: Db): Promise<TemplateGroupView[]> {
  const rows = await db
    .select({ group: templateGroups, accountName: accounts.name })
    .from(templateGroups)
    .innerJoin(accounts, eq(accounts.id, templateGroups.accountId))
    .orderBy(sql`${templateGroups.hits} desc`, sql`${templateGroups.updatedAt} desc`)
    .limit(200);
  return rows.map(({ group, accountName }) => ({
    accountName,
    company: group.company,
    phrase: group.phrase,
    question: group.question,
    action: group.action,
    hits: group.hits,
    status: group.status,
    reason: group.reason,
    lastAt: group.updatedAt.toISOString(),
  }));
}
