/**
 * How AI use counts against the daily cap and the plan quota, and how far an account may go. Every
 * step of an answer re-reads the cached prompt (instructions, tools, the chat so far); a cache read
 * costs a tenth of fresh input, so it counts a tenth. Counted in full, one question with a few 1C
 * lookups used most of a day.
 *
 * Tokens an admin adds ("recharge", ai_grants) raise the quota for the current subscription period
 * and the cap of the day they are added.
 */
import { sql } from "drizzle-orm";

import type { Db } from "../db/client.js";

/** Over the ai_usage table (unaliased). */
export const QUOTA_TOKENS = sql.raw(
  "(input_tokens + output_tokens + cache_write_tokens + cache_read_tokens / 10.0)",
);

export interface AiLimits {
  /** Plan quota plus the tokens added this period. */
  quota: number;
  /** Used this subscription period. */
  used: number;
  /** The daily cap plus the tokens added today. */
  dailyLimit: number;
  /** Used today (UTC). */
  usedToday: number;
  /** Added by admins this period. */
  granted: number;
}

export function startOfUtcDay(now = new Date()): Date {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

export async function aiLimits(
  db: Db,
  accountId: string,
  period: { startsAt: Date; planQuota: number },
  dailyTokens: number,
): Promise<AiLimits> {
  const today = startOfUtcDay().toISOString();
  const since = period.startsAt.toISOString();
  const rows = await db.execute<{
    used: number;
    used_today: number;
    granted: number;
    granted_today: number;
  }>(sql`
    select
      (select coalesce(sum(${QUOTA_TOKENS}), 0) from ai_usage
        where account_id = ${accountId} and created_at >= ${since}::timestamptz)::float8 as used,
      (select coalesce(sum(${QUOTA_TOKENS}), 0) from ai_usage
        where account_id = ${accountId} and created_at >= ${today}::timestamptz)::float8 as used_today,
      (select coalesce(sum(tokens), 0) from ai_grants
        where account_id = ${accountId} and created_at >= ${since}::timestamptz)::float8 as granted,
      (select coalesce(sum(tokens), 0) from ai_grants
        where account_id = ${accountId} and created_at >= ${today}::timestamptz)::float8 as granted_today`);
  const r = rows[0] ?? { used: 0, used_today: 0, granted: 0, granted_today: 0 };
  return {
    quota: period.planQuota + r.granted,
    used: Math.round(r.used),
    dailyLimit: dailyTokens + r.granted_today,
    usedToday: Math.round(r.used_today),
    granted: r.granted,
  };
}
