/**
 * The AI cost engine's contracts: the policy table that holds every limit, the query templates that
 * answer known questions without the model, the answer cache, the metadata digest and the cost
 * report of the admin dashboard. Limits are data, not code: an admin edits them, the backend
 * enforces them, and the desktop only reads them.
 */
import { z } from "zod";

/** Models the router may use for simple questions. */
export const AiSimpleModelId = z.enum(["claude-haiku-4-5"]);
export type AiSimpleModelId = z.infer<typeof AiSimpleModelId>;

/** Where an answer came from: the model, a fixed 1C query (template), the answer cache, or a batch job. */
export const AiRoute = z.enum(["model", "template", "cache", "batch"]);
export type AiRoute = z.infer<typeof AiRoute>;

/** What a request was for. */
export const AiFeature = z.enum(["chat", "audit"]);
export type AiFeature = z.infer<typeof AiFeature>;

export const AiPolicy = z.object({
  /** Spend caps in USD per calendar month (UTC) per account, and per day per user. 0: no cap. */
  monthlyLimitUsd: z.number().min(0).max(1_000_000),
  dailyLimitUsdPerUser: z.number().min(0).max(1_000_000),
  /** A warning is sent when either cap passes this share. 0: no warning. */
  warnAtPercent: z.number().int().min(0).max(100),
  /** At a cap: "block" stops with a clear message; "addon" stops and offers a paid add-on. */
  onLimit: z.enum(["block", "addon"]),
  /**
   * Output tokens per model call. Thinking counts in it, and a card for a whole statement is one
   * long tool call, so it is kept high; lower it only to cap a runaway call.
   */
  maxOutputTokens: z.number().int().min(1_000).max(128_000),
  /** Reads of 1C per question; after them the model answers with what it knows. 0: no cap. */
  maxToolCalls: z.number().int().min(0).max(1_000),
  /** Rows of a query result when the model does not ask for a number, and the most it may ask for. */
  defaultRows: z.number().int().min(1).max(1_000),
  maxRows: z.number().int().min(1).max(1_000),
  /** A chat larger than this many input tokens is summarized (numbers, dates and documents kept). */
  compactionThreshold: z.number().int().min(50_000).max(900_000),
  /** How long a stored answer is reused. 0: the answer cache is off. */
  cacheTtlMinutes: z.number().int().min(0).max(10_080),
  /** Today's total cost over this raises an alert in the admin dashboard. 0: no alert. */
  dailyAlertUsd: z.number().min(0).max(1_000_000),
  /** Answer known questions from query templates, without the model. */
  templates: z.boolean(),
  /** The model for simple questions; null: every question runs on the default model. */
  simpleModel: AiSimpleModelId.nullable(),
});
export type AiPolicy = z.infer<typeof AiPolicy>;

/**
 * No spend caps and no read limit until the tariffs are set: caps for the plans come from a week of
 * real cost data (the test plan of the engine's plan is $50 a month per account, $5 a day per user,
 * 8 reads per question). The alert only shows a banner on the AI cost page.
 */
export const DEFAULT_AI_POLICY: AiPolicy = {
  monthlyLimitUsd: 0,
  dailyLimitUsdPerUser: 0,
  warnAtPercent: 80,
  onLimit: "block",
  maxOutputTokens: 32_000,
  maxToolCalls: 0,
  defaultRows: 50,
  maxRows: 500,
  compactionThreshold: 50_000,
  cacheTtlMinutes: 15,
  dailyAlertUsd: 20,
  templates: true,
  simpleModel: null,
};

/** The saved overrides: any subset of the policy. */
export const AiPolicyOverride = AiPolicy.partial();
export type AiPolicyOverride = z.infer<typeof AiPolicyOverride>;

/** The default policy and the plans' own, merged over each other: plan, else default, else built in. */
export function resolvePolicy(...layers: (AiPolicyOverride | null | undefined)[]): AiPolicy {
  const merged: Record<string, unknown> = { ...DEFAULT_AI_POLICY };
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      if (value !== undefined) merged[key] = value;
    }
  }
  const parsed = AiPolicy.safeParse(merged);
  const policy = parsed.success ? parsed.data : DEFAULT_AI_POLICY;
  return { ...policy, defaultRows: Math.min(policy.defaultRows, policy.maxRows) };
}

/** PUT /v1/admin/ai-policies: a plan's policy (planId), or the default one (null). policy null: remove it. */
export const AiPolicySaveInput = z.object({
  planId: z.uuid().nullable(),
  policy: AiPolicy.nullable(),
});
export type AiPolicySaveInput = z.infer<typeof AiPolicySaveInput>;

export const AiPoliciesView = z.object({
  default: AiPolicy,
  plans: z.array(
    z.object({
      planId: z.string(),
      code: z.string(),
      /** Set when the plan has its own policy; null: it uses the default one. */
      policy: AiPolicy.nullable(),
    }),
  ),
});
export type AiPoliciesView = z.infer<typeof AiPoliciesView>;

/** Raises (or sets) an account's spend cap for the current month, e.g. after a paid add-on. */
export const AccountBudgetInput = z.object({
  limitUsd: z.number().min(0).max(1_000_000),
  reason: z.string().trim().max(300).default(""),
});
export type AccountBudgetInput = z.infer<typeof AccountBudgetInput>;

// --- query templates ----------------------------------------------------------------------------

/**
 * How a &parameter of a template query is filled from the question.
 * date: a date written in the question, else today. month_start / month_end: the first / last day of
 * the month named in the question (with its year, else this year), else the current month.
 * text, number: a value that must be written in the question, in quotes (text) or as a number.
 */
export const TemplateParam = z.object({
  name: z.string().regex(/^[A-Za-zА-Яа-я_][A-Za-zА-Яа-я0-9_]*$/),
  type: z.enum(["date", "month_start", "month_end", "text", "number"]),
});
export type TemplateParam = z.infer<typeof TemplateParam>;

export const TemplateColumn = z.object({
  label: z.string().trim().min(1).max(80),
  format: z.enum(["text", "money", "number", "date"]).default("text"),
});
export type TemplateColumn = z.infer<typeof TemplateColumn>;

export const QueryTemplateInput = z.object({
  /** A short unique name, e.g. "cash_balance". */
  code: z.string().regex(/^[a-z][a-z0-9_]{1,59}$/),
  title: z.string().trim().min(1).max(120),
  /** Phrases that ask this question, in any language (the matcher compares words). */
  intents: z.array(z.string().trim().min(3).max(200)).min(1).max(50),
  /** A 1C query (ВЫБРАТЬ …); it reads only. Its columns are the layout's columns, in order. */
  query: z.string().trim().min(1).max(20_000),
  params: z.array(TemplateParam).max(10).default([]),
  columns: z.array(TemplateColumn).min(1).max(30),
  /** Add a totals row for the money and number columns. */
  totals: z.boolean().default(false),
  enabled: z.boolean().default(true),
});
export type QueryTemplateInput = z.infer<typeof QueryTemplateInput>;

export const QueryTemplateView = QueryTemplateInput.extend({
  id: z.string(),
  version: z.number(),
  updatedAt: z.string(),
});
export type QueryTemplateView = z.infer<typeof QueryTemplateView>;

// --- answer cache, free answers, digest ----------------------------------------------------------

/** The cache key: the company, the question and the version of its data. */
export const AnswerKey = z.object({
  company: z.string().trim().min(1).max(200),
  question: z.string().trim().min(1).max(2_000),
  dataVersion: z.string().trim().min(1).max(100),
});
export type AnswerKey = z.infer<typeof AnswerKey>;

export const AnswerStoreInput = AnswerKey.extend({ answer: z.string().min(1).max(100_000) });
export type AnswerStoreInput = z.infer<typeof AnswerStoreInput>;

export const AnswerLookup = z.discriminatedUnion("hit", [
  z.object({ hit: z.literal(false) }),
  z.object({ hit: z.literal(true), answer: z.string(), ageSeconds: z.number() }),
]);
export type AnswerLookup = z.infer<typeof AnswerLookup>;

/** An answer that never reached the model, reported so the cost dashboard counts every question. */
export const FreeAnswerInput = z.object({
  route: z.enum(["template", "cache"]),
  company: z.string().trim().min(1).max(200),
  question: z.string().trim().min(1).max(2_000),
});
export type FreeAnswerInput = z.infer<typeof FreeAnswerInput>;

/** A compact description of a company's 1C structure, built once per configuration version. */
export const DigestKey = z.object({
  company: z.string().trim().min(1).max(200),
  configName: z.string().trim().min(1).max(200),
  configVersion: z.string().trim().min(1).max(100),
});
export type DigestKey = z.infer<typeof DigestKey>;

export const DigestInput = DigestKey.extend({
  digest: z.string().min(1).max(200_000),
  tokenCount: z.number().int().min(0).max(1_000_000),
});
export type DigestInput = z.infer<typeof DigestInput>;

// --- the cost report ----------------------------------------------------------------------------

export const CostReport = z.object({
  days: z.number(),
  totalUsd: z.number(),
  /** The five numbers that tell whether the engine works, over `days` days. */
  metrics: z.object({
    questions: z.number(),
    costPerQuestionUsd: z.number(),
    /** Cache-read tokens ÷ all input tokens of the model calls. */
    cacheHitRate: z.number(),
    /** (Template + cache answers) ÷ all questions. */
    freeAnswerShare: z.number(),
    avgTokensPerQuestion: z.number(),
    avgToolCallsPerQuestion: z.number(),
  }),
  byDay: z.array(
    z.object({ date: z.string(), costUsd: z.number(), requests: z.number(), questions: z.number() }),
  ),
  byAccount: z.array(
    z.object({
      accountId: z.string(),
      accountName: z.string(),
      costUsd: z.number(),
      /** This calendar month, against the account's cap (null: no cap). */
      monthUsd: z.number(),
      limitUsd: z.number().nullable(),
      requests: z.number(),
      questions: z.number(),
    }),
  ),
  byUser: z.array(
    z.object({
      userId: z.string(),
      email: z.string(),
      accountName: z.string(),
      costUsd: z.number(),
      requests: z.number(),
    }),
  ),
  byFeature: z.array(z.object({ feature: z.string(), costUsd: z.number(), requests: z.number() })),
  byRoute: z.array(z.object({ route: z.string(), costUsd: z.number(), requests: z.number() })),
  /** The 20 most expensive questions of the last 7 days. */
  topQuestions: z.array(
    z.object({
      question: z.string(),
      accountName: z.string(),
      costUsd: z.number(),
      steps: z.number(),
      toolCalls: z.number(),
      lastAt: z.string(),
    }),
  ),
  alert: z.object({ thresholdUsd: z.number(), todayUsd: z.number(), exceeded: z.boolean() }),
});
export type CostReport = z.infer<typeof CostReport>;
