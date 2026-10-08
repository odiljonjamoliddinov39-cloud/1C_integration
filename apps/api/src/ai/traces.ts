/**
 * Traces: what the app did for every finished question (the steps, whether a card was confirmed),
 * without the data. They are what the engine learns from: the reasoner groups the questions that
 * were answered by the same query and decides what can become a template.
 */
import { createHash } from "node:crypto";

import { and, eq, lt } from "drizzle-orm";

import type { TraceInput } from "@platform/shared";

import type { Db } from "../db/client.js";
import { aiTraces } from "../db/schema.js";

const KEEP_DAYS = 60;

export const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Questions answered by the same query (and the same kind of card) are one group. */
export function groupKeyOf(input: TraceInput): string | null {
  const step = input.learnable ? input.steps[input.learnable.step] : undefined;
  if (!input.learnable || !step?.query) return null;
  return sha(`${input.company}|${step.query.trim()}|${input.learnable.action?.tool ?? ""}`);
}

export async function storeTrace(
  db: Db,
  who: { accountId: string; userId: string },
  input: TraceInput,
): Promise<{ learnable: boolean }> {
  const groupKey = groupKeyOf(input);
  await db.insert(aiTraces).values({
    accountId: who.accountId,
    userId: who.userId,
    company: input.company,
    question: input.question,
    outcome: input.outcome,
    steps: input.steps,
    learnable: groupKey ? (input.learnable as unknown as Record<string, unknown>) : null,
    groupKey,
  });
  // Old traces are of no use; clearing on write keeps the table small without a job.
  await db
    .delete(aiTraces)
    .where(
      and(
        eq(aiTraces.accountId, who.accountId),
        lt(aiTraces.createdAt, new Date(Date.now() - KEEP_DAYS * 86_400_000)),
      ),
    );
  return { learnable: groupKey !== null };
}
