/**
 * Which model the assistant runs on, and at what effort: the account's own setting, else the one
 * set in the admin dashboard, else the server's default (AI_MODEL / AI_EFFORT). Read on every
 * turn, so a change in the dashboard applies from the next step of an answer.
 */
import { eq } from "drizzle-orm";

import { AiEffort, AiModelId } from "@platform/shared";

import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { accounts, appSettings } from "../db/schema.js";

export const AI_SETTINGS_KEY = "ai";

export interface ModelChoice {
  model: string;
  effort: AiEffort;
}

/** The dashboard's setting, if one was saved and is still a model we offer. */
export async function savedAiSettings(
  db: Db,
): Promise<(ModelChoice & { updatedAt: Date; updatedBy: string | null }) | null> {
  const row = await db.query.appSettings.findFirst({ where: eq(appSettings.key, AI_SETTINGS_KEY) });
  const model = AiModelId.safeParse(row?.value.model);
  const effort = AiEffort.safeParse(row?.value.effort);
  if (!row || !model.success || !effort.success) return null;
  return { model: model.data, effort: effort.data, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
}

export async function globalAiChoice(db: Db, config: Config): Promise<ModelChoice> {
  const saved = await savedAiSettings(db);
  return saved
    ? { model: saved.model, effort: saved.effort }
    : { model: config.AI_MODEL, effort: config.AI_EFFORT };
}

/** What this account's next turn runs on. */
export async function aiChoiceFor(db: Db, config: Config, accountId: string): Promise<ModelChoice> {
  const global = await globalAiChoice(db, config);
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
    columns: { aiModel: true, aiEffort: true },
  });
  const model = AiModelId.safeParse(account?.aiModel);
  const effort = AiEffort.safeParse(account?.aiEffort);
  return {
    model: model.success ? model.data : global.model,
    effort: effort.success ? effort.data : global.effort,
  };
}
