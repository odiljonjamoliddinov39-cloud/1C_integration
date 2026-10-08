/**
 * Control system tables (TD §10 "Backend"). Who pays and what they may use; no accounting data.
 * Migrations are generated from this file: pnpm --filter @platform/api db:generate
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const accounts = pgTable("accounts", {
  id: id(),
  name: text("name").notNull(),
  type: text("type", { enum: ["firm", "company"] })
    .notNull()
    .default("firm"),
  status: text("status", { enum: ["active", "blocked"] })
    .notNull()
    .default("active"),
  /** The assistant's model and effort for this account; null: the global setting. */
  aiModel: text("ai_model"),
  aiEffort: text("ai_effort"),
  createdAt: createdAt(),
});

export const users = pgTable(
  "users",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    phone: text("phone"),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    role: text("role", { enum: ["owner", "member"] })
      .notNull()
      .default("member"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_email_key").on(t.email)],
);

export const plans = pgTable("plans", {
  id: id(),
  code: text("code").notNull().unique(),
  priceUzs: integer("price_uzs").notNull(),
  periodDays: integer("period_days").notNull(),
  seats: integer("seats").notNull(),
  maxCompanies: integer("max_companies").notNull(),
  aiTokenQuota: integer("ai_token_quota").notNull().default(0),
  /** e.g. {"maxDevicesPerSeat": 2} */
  features: jsonb("features").$type<{ maxDevicesPerSeat?: number }>().notNull().default({}),
});

export const subscriptions = pgTable("subscriptions", {
  id: id(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  planId: uuid("plan_id")
    .notNull()
    .references(() => plans.id),
  status: text("status", { enum: ["trial", "active", "grace", "suspended", "cancelled"] }).notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  autoRenew: boolean("auto_renew").notNull().default(true),
});

export const devices = pgTable(
  "devices",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** sha256 of the PC's machine id. */
    machineId: text("machine_id").notNull(),
    name: text("name").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    revoked: boolean("revoked").notNull().default(false),
  },
  (t) => [uniqueIndex("devices_user_machine_key").on(t.userId, t.machineId)],
);

export const licenses = pgTable("licenses", {
  id: id(),
  subscriptionId: uuid("subscription_id")
    .notNull()
    .references(() => subscriptions.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id")
    .notNull()
    .references(() => devices.id, { onDelete: "cascade" }),
  tokenJti: text("token_jti").notNull().unique(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/** Connected companies: INN and name only, never their books. */
export const companies = pgTable(
  "companies",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    inn: text("inn").notNull(),
    name: text("name").notNull(),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("companies_account_inn_key").on(t.accountId, t.inn)],
);

export const refreshTokens = pgTable("refresh_tokens", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** sha256 of the token; the token itself is shown once. */
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/** One row per Claude API call made through the AI proxy (TD §8 "AI proxy"). */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull(),
    /** The 1C organization the question was about. */
    company: text("company"),
    /** "chat" or "audit". */
    feature: text("feature").notNull().default("chat"),
    /** Where the answer came from: "model", "template", "cache" or "batch". Free routes cost 0. */
    route: text("route").notNull().default("model"),
    /** Tool calls the model made in this step. */
    toolCalls: integer("tool_calls").notNull().default(0),
    /** The first step of a question (or a free answer), so questions can be counted. */
    firstStep: boolean("first_step").notNull().default(false),
    /** The question this step belongs to, cut to 200 characters (for "most expensive questions"). */
    question: text("question"),
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_usage_account_created_idx").on(t.accountId, t.createdAt),
    index("ai_usage_user_created_idx").on(t.userId, t.createdAt),
  ],
);

/** AI cost limits (see AiPolicy): the default (plan_id null) and each plan's own. Partial overrides. */
export const aiPolicies = pgTable(
  "ai_policies",
  {
    id: id(),
    planId: uuid("plan_id").references(() => plans.id, { onDelete: "cascade" }),
    policy: jsonb("policy").$type<Record<string, unknown>>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => admins.id, { onDelete: "set null" }),
  },
  (t) => [
    uniqueIndex("ai_policies_plan_key").on(t.planId),
    // At most one default policy (plan_id null; unique indexes treat nulls as distinct).
    uniqueIndex("ai_policies_default_key")
      .on(sql`(1)`)
      .where(sql`plan_id is null`),
  ],
);

/**
 * Spend of an account in a calendar month (UTC). limit_usd is the cap an admin set for this month
 * (an add-on); null: the policy's. warned_at / blocked_at: when the account first passed the warning
 * share and the cap, so the warning is sent once.
 */
export const aiBudgets = pgTable(
  "ai_budgets",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** "YYYY-MM". */
    period: text("period").notNull(),
    limitUsd: numeric("limit_usd", { precision: 12, scale: 4, mode: "number" }),
    usedUsd: numeric("used_usd", { precision: 14, scale: 6, mode: "number" }).notNull().default(0),
    warnedAt: timestamp("warned_at", { withTimezone: true }),
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("ai_budgets_account_period_key").on(t.accountId, t.period)],
);

/** Stored answers to read-only questions, by company, question and data version. */
export const aiAnswerCache = pgTable(
  "ai_answer_cache",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    company: text("company").notNull(),
    questionHash: text("question_hash").notNull(),
    normalizedQuestion: text("normalized_question").notNull(),
    dataVersion: text("data_version").notNull(),
    answer: text("answer").notNull(),
    hits: integer("hits").notNull().default(0),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("ai_answer_cache_key").on(t.accountId, t.company, t.questionHash, t.dataVersion),
    index("ai_answer_cache_expires_idx").on(t.expiresAt),
  ],
);

/** The compact structure of a company's 1C, built by the desktop once per configuration version. */
export const metadataDigests = pgTable(
  "metadata_digests",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    company: text("company").notNull(),
    configName: text("config_name").notNull(),
    configVersion: text("config_version").notNull(),
    digest: text("digest").notNull(),
    tokenCount: integer("token_count").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("metadata_digests_key").on(t.accountId, t.company, t.configName, t.configVersion)],
);

/** Known questions answered by a fixed 1C query, without the model. Managed in the admin dashboard. */
export const queryTemplates = pgTable("query_templates", {
  id: id(),
  code: text("code").notNull().unique(),
  title: text("title").notNull(),
  intents: jsonb("intents").$type<string[]>().notNull(),
  onecQuery: text("onec_query").notNull(),
  params: jsonb("params").$type<{ name: string; type: string }[]>().notNull().default([]),
  resultLayout: jsonb("result_layout")
    .$type<{ columns: { label: string; format: string }[]; totals: boolean }>()
    .notNull(),
  version: integer("version").notNull().default(1),
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => admins.id, { onDelete: "set null" }),
});

/** Our staff who use the admin dashboard (TD §8 "Admin API": owner, support). Not customers. */
export const admins = pgTable(
  "admins",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["owner", "support"] }).notNull(),
    disabled: boolean("disabled").notNull().default(false),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("admins_email_key").on(t.email)],
);

/** Every admin action (TD §10 admin_audit). The target names what it touched, e.g. "account:<id>". */
/**
 * AI tokens an admin added to an account ("recharge"). They raise the plan quota for the current
 * subscription period, and the daily cap on the day they are added, so a blocked account can go on.
 */
export const aiGrants = pgTable(
  "ai_grants",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    tokens: integer("tokens").notNull(),
    adminId: uuid("admin_id").references(() => admins.id, { onDelete: "set null" }),
    reason: text("reason").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("ai_grants_account_idx").on(t.accountId, t.createdAt)],
);

export const adminAudit = pgTable(
  "admin_audit",
  {
    id: id(),
    adminId: uuid("admin_id").references(() => admins.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    target: text("target").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("admin_audit_target_idx").on(t.target, t.createdAt)],
);

/** Settings the admin dashboard changes, by key (e.g. "ai": the assistant's model and effort). */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => admins.id, { onDelete: "set null" }),
});
