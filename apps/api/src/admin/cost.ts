/** The cost report of the admin dashboard: where AI money goes, and the five numbers that show whether the cost engine works. */
import type { CostReport } from "@platform/shared";
import { sql } from "drizzle-orm";

import { periodOf } from "../ai/budget.js";
import { policyFor } from "../ai/policy.js";
import type { Db } from "../db/client.js";

const DAY = 86_400_000;
const round = (n: number, places = 4) => Math.round(n * 10 ** places) / 10 ** places;
const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);

export async function costReport(db: Db, days: number): Promise<CostReport> {
  const since = new Date(Date.now() - (days - 1) * DAY);
  since.setUTCHours(0, 0, 0, 0);
  const from = since.toISOString();
  const weekAgo = new Date(Date.now() - 7 * DAY).toISOString();

  const [totals] = await db.execute<{
    cost: number;
    chat_cost: number;
    questions: number;
    free: number;
    input: number;
    cache_read: number;
    cache_write: number;
    chat_tokens: number;
    tool_calls: number;
  }>(sql`
    select coalesce(sum(cost_usd), 0)::float8 as cost,
      coalesce(sum(cost_usd) filter (where feature = 'chat'), 0)::float8 as chat_cost,
      (count(*) filter (where first_step and feature = 'chat'))::int as questions,
      (count(*) filter (where route in ('template', 'cache')))::int as free,
      coalesce(sum(input_tokens), 0)::float8 as input,
      coalesce(sum(cache_read_tokens), 0)::float8 as cache_read,
      coalesce(sum(cache_write_tokens), 0)::float8 as cache_write,
      coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)
        filter (where feature = 'chat'), 0)::float8 as chat_tokens,
      coalesce(sum(tool_calls) filter (where feature = 'chat'), 0)::float8 as tool_calls
    from ai_usage where created_at >= ${from}::timestamptz`);
  const t = totals ?? {
    cost: 0,
    chat_cost: 0,
    questions: 0,
    free: 0,
    input: 0,
    cache_read: 0,
    cache_write: 0,
    chat_tokens: 0,
    tool_calls: 0,
  };

  const byDayRows = await db.execute<{ day: string; cost: number; requests: number; questions: number }>(sql`
    select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day,
      coalesce(sum(cost_usd), 0)::float8 as cost,
      (count(*) filter (where route in ('model', 'batch')))::int as requests,
      (count(*) filter (where first_step and feature = 'chat'))::int as questions
    from ai_usage where created_at >= ${from}::timestamptz group by 1`);
  const byDay = new Map(byDayRows.map((r) => [r.day, r]));

  const accountRows = await db.execute<{
    id: string;
    name: string;
    cost: number;
    requests: number;
    questions: number;
    month: number;
    limit: number | null;
  }>(sql`
    select a.id, a.name, sum(u.cost_usd)::float8 as cost,
      (count(*) filter (where u.route in ('model', 'batch')))::int as requests,
      (count(*) filter (where u.first_step and u.feature = 'chat'))::int as questions,
      coalesce((select b.used_usd from ai_budgets b where b.account_id = a.id and b.period = ${periodOf()}), 0)::float8 as month,
      (select b.limit_usd from ai_budgets b where b.account_id = a.id and b.period = ${periodOf()})::float8 as limit
    from ai_usage u join accounts a on a.id = u.account_id
    where u.created_at >= ${from}::timestamptz group by a.id, a.name order by cost desc limit 200`);

  const userRows = await db.execute<{
    id: string;
    email: string;
    account: string;
    cost: number;
    requests: number;
  }>(sql`
    select us.id, us.email, a.name as account, sum(u.cost_usd)::float8 as cost,
      (count(*) filter (where u.route in ('model', 'batch')))::int as requests
    from ai_usage u join users us on us.id = u.user_id join accounts a on a.id = us.account_id
    where u.created_at >= ${from}::timestamptz group by us.id, us.email, a.name order by cost desc limit 200`);

  const featureRows = await db.execute<{ feature: string; cost: number; requests: number }>(sql`
    select feature, sum(cost_usd)::float8 as cost, count(*)::int as requests
    from ai_usage where created_at >= ${from}::timestamptz group by feature order by cost desc`);
  const routeRows = await db.execute<{ route: string; cost: number; requests: number }>(sql`
    select route, sum(cost_usd)::float8 as cost, count(*)::int as requests
    from ai_usage where created_at >= ${from}::timestamptz group by route order by cost desc`);

  const topRows = await db.execute<{
    question: string;
    account: string;
    cost: number;
    steps: number;
    tool_calls: number;
    last_at: Date;
  }>(sql`
    select u.question, a.name as account, sum(u.cost_usd)::float8 as cost, count(*)::int as steps,
      sum(u.tool_calls)::int as tool_calls, max(u.created_at) as last_at
    from ai_usage u join accounts a on a.id = u.account_id
    where u.created_at >= ${weekAgo}::timestamptz and u.question is not null and u.route = 'model' and u.feature = 'chat'
    group by u.account_id, a.name, u.question order by cost desc limit 20`);

  const today = new Date().toISOString().slice(0, 10);
  const todayUsd = byDay.get(today)?.cost ?? 0;
  const { dailyAlertUsd } = await policyFor(db, null);

  const questions = t.questions + 0;
  return {
    days,
    totalUsd: round(t.cost),
    metrics: {
      questions,
      costPerQuestionUsd: round(ratio(t.chat_cost, questions), 5),
      cacheHitRate: round(ratio(t.cache_read, t.input + t.cache_read + t.cache_write), 4),
      freeAnswerShare: round(ratio(t.free, questions), 4),
      avgTokensPerQuestion: Math.round(ratio(t.chat_tokens, questions)),
      avgToolCallsPerQuestion: round(ratio(t.tool_calls, questions), 2),
    },
    byDay: Array.from({ length: days }, (_, i) => {
      const date = new Date(since.getTime() + i * DAY).toISOString().slice(0, 10);
      const r = byDay.get(date);
      return { date, costUsd: round(r?.cost ?? 0), requests: r?.requests ?? 0, questions: r?.questions ?? 0 };
    }),
    byAccount: accountRows.map((r) => ({
      accountId: r.id,
      accountName: r.name,
      costUsd: round(r.cost),
      monthUsd: round(r.month),
      limitUsd: r.limit,
      requests: r.requests,
      questions: r.questions,
    })),
    byUser: userRows.map((r) => ({
      userId: r.id,
      email: r.email,
      accountName: r.account,
      costUsd: round(r.cost),
      requests: r.requests,
    })),
    byFeature: featureRows.map((r) => ({ feature: r.feature, costUsd: round(r.cost), requests: r.requests })),
    byRoute: routeRows.map((r) => ({ route: r.route, costUsd: round(r.cost), requests: r.requests })),
    topQuestions: topRows.map((r) => ({
      question: r.question,
      accountName: r.account,
      costUsd: round(r.cost),
      steps: r.steps,
      toolCalls: r.tool_calls,
      lastAt: new Date(r.last_at).toISOString(),
    })),
    alert: {
      thresholdUsd: dailyAlertUsd,
      todayUsd: round(todayUsd),
      exceeded: dailyAlertUsd > 0 && todayUsd >= dailyAlertUsd,
    },
  };
}
