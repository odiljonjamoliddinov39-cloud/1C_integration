/**
 * The answer cache: a read-only question asked again about the same company, while its data has not
 * changed (the data version is part of the key), is answered from the stored answer at no cost.
 * Entries expire (policy.cacheTtlMinutes), and the app drops them from use after its own writes by
 * changing the data version.
 */
import { createHash } from "node:crypto";

import { and, eq, gt, lt, sql } from "drizzle-orm";

import type { AiPolicy, AnswerKey, AnswerLookup, AnswerStoreInput } from "@platform/shared";

import type { Db } from "../db/client.js";
import { aiAnswerCache } from "../db/schema.js";

/** The same question written with other spacing, case or punctuation is the same question. */
export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}\s.,:/-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const hash = (normalized: string) => createHash("sha256").update(normalized).digest("hex");

export async function lookupAnswer(
  db: Db,
  policy: AiPolicy,
  accountId: string,
  key: AnswerKey,
): Promise<AnswerLookup> {
  if (policy.cacheTtlMinutes === 0) return { hit: false };
  const [row] = await db
    .select()
    .from(aiAnswerCache)
    .where(
      and(
        eq(aiAnswerCache.accountId, accountId),
        eq(aiAnswerCache.company, key.company),
        eq(aiAnswerCache.questionHash, hash(normalizeQuestion(key.question))),
        eq(aiAnswerCache.dataVersion, key.dataVersion),
        gt(aiAnswerCache.expiresAt, new Date()),
      ),
    );
  if (!row) return { hit: false };
  await db
    .update(aiAnswerCache)
    .set({ hits: sql`${aiAnswerCache.hits} + 1` })
    .where(eq(aiAnswerCache.id, row.id));
  return {
    hit: true,
    answer: row.answer,
    ageSeconds: Math.round((Date.now() - row.createdAt.getTime()) / 1000),
  };
}

export async function storeAnswer(
  db: Db,
  policy: AiPolicy,
  accountId: string,
  input: AnswerStoreInput,
): Promise<void> {
  if (policy.cacheTtlMinutes === 0) return;
  const normalized = normalizeQuestion(input.question);
  const expiresAt = new Date(Date.now() + policy.cacheTtlMinutes * 60_000);
  await db
    .insert(aiAnswerCache)
    .values({
      accountId,
      company: input.company,
      questionHash: hash(normalized),
      normalizedQuestion: normalized.slice(0, 500),
      dataVersion: input.dataVersion,
      answer: input.answer,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [
        aiAnswerCache.accountId,
        aiAnswerCache.company,
        aiAnswerCache.questionHash,
        aiAnswerCache.dataVersion,
      ],
      set: { answer: input.answer, createdAt: new Date(), expiresAt },
    });
  // Expired answers are of no use; clearing them on write keeps the table small without a job.
  await db.delete(aiAnswerCache).where(lt(aiAnswerCache.expiresAt, new Date()));
}
