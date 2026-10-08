/** Query templates: known questions answered by a fixed 1C query. Edited in the admin dashboard. */
import { asc, eq } from "drizzle-orm";

import type { QueryTemplateInput, QueryTemplateView } from "@platform/shared";

import type { Db } from "../db/client.js";
import { queryTemplates } from "../db/schema.js";

type Row = typeof queryTemplates.$inferSelect;

function view(row: Row): QueryTemplateView {
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
  };
}

export async function listTemplates(db: Db, onlyEnabled: boolean): Promise<QueryTemplateView[]> {
  const rows = await db
    .select()
    .from(queryTemplates)
    .where(onlyEnabled ? eq(queryTemplates.enabled, true) : undefined)
    .orderBy(asc(queryTemplates.code));
  return rows.map(view);
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
