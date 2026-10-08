/**
 * The budget guard: before every model call, the account's spend this month and the user's spend
 * today are checked against the policy. A warning goes out once when either passes the warning
 * share; at the cap the call is refused with a clear message. Spend is added as it is logged.
 */
import { and, eq, gte, sql } from "drizzle-orm";

import type { AiPolicy } from "@platform/shared";

import type { Db } from "../db/client.js";
import { aiBudgets, aiUsage } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { startOfUtcDay } from "./quota.js";

export interface Warning {
  code: string;
  message: string;
}

/** What the guard decided: the call may go ahead, with these warnings to show first. */
export interface Admission {
  policy: AiPolicy;
  warnings: Warning[];
}

export const periodOf = (now = new Date()) => now.toISOString().slice(0, 7);

/** Users already warned about their daily share today (the monthly warning is kept in the table). */
const warnedToday = new Map<string, string>();

const usd = (n: number) => `$${n.toFixed(2)}`;

export async function checkBudget(
  db: Db,
  policy: AiPolicy,
  who: { accountId: string; userId: string },
): Promise<Admission> {
  const warnings: Warning[] = [];
  const period = periodOf();
  const [budget] = await db
    .select()
    .from(aiBudgets)
    .where(and(eq(aiBudgets.accountId, who.accountId), eq(aiBudgets.period, period)));
  const used = budget?.usedUsd ?? 0;
  const limit = budget?.limitUsd ?? policy.monthlyLimitUsd;
  const warnShare = policy.warnAtPercent / 100;

  if (limit > 0 && used >= limit) {
    await db
      .insert(aiBudgets)
      .values({ accountId: who.accountId, period, blockedAt: new Date() })
      .onConflictDoUpdate({
        target: [aiBudgets.accountId, aiBudgets.period],
        set: { blockedAt: sql`coalesce(${aiBudgets.blockedAt}, now())` },
      });
    throw new HttpError(
      429,
      "AI_BUDGET_EXCEEDED",
      policy.onLimit === "addon"
        ? `This account used its monthly AI budget (${usd(limit)}). Add a paid add-on to continue, or wait for the 1st.`
        : `This account used its monthly AI budget (${usd(limit)}). It resets on the 1st; contact us to raise it.`,
    );
  }

  const [today] = await db
    .select({ spent: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float8` })
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, who.userId), gte(aiUsage.createdAt, startOfUtcDay())));
  const spentToday = today?.spent ?? 0;
  const dayLimit = policy.dailyLimitUsdPerUser;
  if (dayLimit > 0 && spentToday >= dayLimit) {
    throw new HttpError(
      429,
      "AI_USER_DAILY_LIMIT",
      `Your AI limit for today (${usd(dayLimit)}) is used up. It resets at midnight UTC.`,
    );
  }

  if (limit > 0 && used >= limit * warnShare && !budget?.warnedAt) {
    await db
      .insert(aiBudgets)
      .values({ accountId: who.accountId, period, warnedAt: new Date() })
      .onConflictDoUpdate({
        target: [aiBudgets.accountId, aiBudgets.period],
        set: { warnedAt: sql`coalesce(${aiBudgets.warnedAt}, now())` },
      });
    warnings.push({
      code: "AI_BUDGET_WARNING",
      message: `This account has used ${Math.round((used / limit) * 100)}% of its monthly AI budget (${usd(used)} of ${usd(limit)}).`,
    });
  }
  const day = new Date().toISOString().slice(0, 10);
  if (dayLimit > 0 && spentToday >= dayLimit * warnShare && warnedToday.get(who.userId) !== day) {
    warnedToday.set(who.userId, day);
    warnings.push({
      code: "AI_DAILY_WARNING",
      message: `You have used ${Math.round((spentToday / dayLimit) * 100)}% of today's AI limit (${usd(spentToday)} of ${usd(dayLimit)}).`,
    });
  }
  return { policy, warnings };
}

/** Adds a call's cost to the account's month. */
export async function addSpend(db: Db, accountId: string, costUsd: number): Promise<void> {
  if (costUsd <= 0) return;
  await db
    .insert(aiBudgets)
    .values({ accountId, period: periodOf(), usedUsd: costUsd })
    .onConflictDoUpdate({
      target: [aiBudgets.accountId, aiBudgets.period],
      set: { usedUsd: sql`${aiBudgets.usedUsd} + ${costUsd}` },
    });
}

/** Sets the cap for this month (an add-on) and lifts the block and the warning mark. */
export async function setMonthLimit(db: Db, accountId: string, limitUsd: number): Promise<void> {
  const period = periodOf();
  await db
    .insert(aiBudgets)
    .values({ accountId, period, limitUsd })
    .onConflictDoUpdate({
      target: [aiBudgets.accountId, aiBudgets.period],
      set: { limitUsd, blockedAt: null, warnedAt: null },
    });
}
