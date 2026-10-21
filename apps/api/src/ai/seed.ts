/**
 * The seed of the template library (packages/shared/src/seed-templates.ts), put into the table when the server starts.
 * A seed the dashboard has not touched is kept up to date with the code; one an admin edited or turned off is theirs.
 */
import { isDeepStrictEqual } from "node:util";

import { eq } from "drizzle-orm";

import { seedTemplateInputs } from "@platform/shared";

import type { Db } from "../db/client.js";
import { queryTemplates } from "../db/schema.js";

export async function seedTemplates(db: Db): Promise<{ added: number; updated: number }> {
  let added = 0;
  let updated = 0;
  for (const t of seedTemplateInputs()) {
    const values = {
      title: t.title,
      intents: t.intents,
      onecQuery: t.query,
      params: t.params,
      resultLayout: { columns: t.columns, totals: t.totals },
      action: null,
    };
    const [existing] = await db.select().from(queryTemplates).where(eq(queryTemplates.code, t.code));
    if (!existing) {
      await db
        .insert(queryTemplates)
        .values({ code: t.code, ...values, enabled: t.enabled, source: "admin" });
      added += 1;
      continue;
    }
    // Edited in the dashboard (it records who): left as the admin made it.
    if (existing.updatedBy !== null) continue;
    // The database keeps JSON with its own key order: compare by value.
    const same =
      existing.title === values.title &&
      existing.onecQuery === values.onecQuery &&
      isDeepStrictEqual(existing.intents, values.intents) &&
      isDeepStrictEqual(existing.params, values.params) &&
      isDeepStrictEqual(existing.resultLayout, values.resultLayout);
    if (same) continue;
    await db
      .update(queryTemplates)
      .set({ ...values, version: existing.version + 1, updatedAt: new Date() })
      .where(eq(queryTemplates.id, existing.id));
    updated += 1;
  }
  return { added, updated };
}
