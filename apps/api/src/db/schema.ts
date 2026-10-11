/**
 * Control system tables (TD §10 "Backend"). Who pays and what they may use; no accounting data.
 * Migrations are generated from this file: pnpm --filter @platform/api db:generate
 */
import { sql } from "drizzle-orm";
import {
  bigint,
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

/**
 * What a plan allows and costs (tariffs: docs/billing.md). Prices are whole sum, VAT excluded.
 * price_uzs is the monthly price; seats is the number of users; null limits mean unlimited.
 */
export const plans = pgTable("plans", {
  id: id(),
  code: text("code").notNull().unique(),
  name: text("name").notNull().default(""),
  priceUzs: bigint("price_uzs", { mode: "number" }).notNull(),
  /** 12 months for the price of 10. */
  priceYearSum: bigint("price_year_sum", { mode: "number" }).notNull().default(0),
  periodDays: integer("period_days").notNull(),
  seats: integer("seats").notNull(),
  maxCompanies: integer("max_companies").notNull(),
  aiTokenQuota: integer("ai_token_quota").notNull().default(0),
  importsPerMonth: integer("imports_per_month"),
  auditsPerMonth: integer("audits_per_month"),
  aiQuestionsPerMonth: integer("ai_questions_per_month").notNull().default(0),
  /** e.g. {"maxDevicesPerSeat": 2, "excelExport": true}. */
  features: jsonb("features").$type<PlanFeatures>().notNull().default({}),
  isPublic: boolean("is_public").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export interface PlanFeatures {
  maxDevicesPerSeat?: number;
  excelExport?: boolean;
  prioritySupport?: boolean;
  /** "docs" | "telegram" | "telegram-priority" | "manager": shown on the pricing page. */
  support?: string;
}

/** Extras that widen a paid plan: one more company or user, or 100 more AI questions this period. */
export const addons = pgTable("addons", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  priceSum: bigint("price_sum", { mode: "number" }).notNull(),
  kind: text("kind", { enum: ["recurring", "one_off"] }).notNull(),
  allowedPlans: text("allowed_plans").array().notNull(),
  grants: jsonb("grants").$type<{ companies?: number; users?: number; aiQuestions?: number }>().notNull(),
  isPublic: boolean("is_public").notNull().default(true),
});

/**
 * One row per account, changed in place. starts_at / ends_at are the period (a Free account's
 * period never ends); status is what the account has been put in, see effectiveStatus for what it is
 * now. pending_plan_id: a downgrade that takes effect at the end of the period.
 */
export const subscriptions = pgTable("subscriptions", {
  id: id(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  planId: uuid("plan_id")
    .notNull()
    .references(() => plans.id),
  status: text("status", { enum: ["free", "trial", "active", "grace", "suspended", "cancelled"] }).notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  autoRenew: boolean("auto_renew").notNull().default(true),
  billingCycle: text("billing_cycle", { enum: ["month", "year"] })
    .notNull()
    .default("month"),
  /** The Business trial was started once: per account (and per INN of the first company). */
  trialUsed: boolean("trial_used").notNull().default(false),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  pendingPlanId: uuid("pending_plan_id").references(() => plans.id),
  /** Reminders sent for the current period: "7", "1". */
  remindersSent: text("reminders_sent")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
});

export const subscriptionAddons = pgTable(
  "subscription_addons",
  {
    id: id(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    addonCode: text("addon_code")
      .notNull()
      .references(() => addons.code),
    quantity: integer("quantity").notNull().default(1),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }).notNull(),
  },
  (t) => [index("subscription_addons_sub_idx").on(t.subscriptionId)],
);

/** What an account used in a period: the key is where the period started. */
export const usageCounters = pgTable(
  "usage_counters",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    imports: integer("imports").notNull().default(0),
    audits: integer("audits").notNull().default(0),
    aiQuestions: integer("ai_questions").notNull().default(0),
    /** The 80% warning of the AI questions was shown for this period. */
    aiWarnedAt: timestamp("ai_warned_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("usage_counters_key").on(t.accountId, t.periodStart)],
);

export interface InvoiceItem {
  kind: "plan" | "upgrade" | "addon";
  code: string;
  title: string;
  quantity: number;
  amountSum: number;
}

/** What paying an invoice does: see applyInvoice. */
export interface InvoiceIntent {
  type: "plan" | "upgrade" | "addon";
  planCode?: string;
  cycle?: "month" | "year";
  addonCode?: string;
  quantity?: number;
  promoCode?: string;
}

/** Our own invoice: the provider only confirms that it was paid. Amounts are whole sum. */
export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    /** Short number for the customer and for the payment systems: INV-000123. */
    number: integer("number").generatedAlwaysAsIdentity(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    items: jsonb("items").$type<InvoiceItem[]>().notNull(),
    intent: jsonb("intent").$type<InvoiceIntent>().notNull(),
    subtotalSum: bigint("subtotal_sum", { mode: "number" }).notNull(),
    discountSum: bigint("discount_sum", { mode: "number" }).notNull().default(0),
    vatSum: bigint("vat_sum", { mode: "number" }).notNull(),
    totalSum: bigint("total_sum", { mode: "number" }).notNull(),
    status: text("status", { enum: ["pending", "paid", "cancelled", "expired"] })
      .notNull()
      .default("pending"),
    provider: text("provider", { enum: ["payme", "click", "bank"] }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("invoices_account_idx").on(t.accountId, t.createdAt),
    uniqueIndex("invoices_number_key").on(t.number),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: id(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /** The provider's transaction id: a repeated call with it returns what was stored. */
    providerTxnId: text("provider_txn_id").notNull().unique(),
    amountSum: bigint("amount_sum", { mode: "number" }).notNull(),
    state: text("state").notNull(),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("payments_invoice_idx").on(t.invoiceId)],
);

export const promoCodes = pgTable("promo_codes", {
  code: text("code").primaryKey(),
  kind: text("kind", { enum: ["percent", "fixed"] }).notNull(),
  /** Percent (1-100) or sum. */
  value: bigint("value", { mode: "number" }).notNull(),
  /** Plans it applies to; empty: all paid plans. */
  allowedPlans: text("allowed_plans")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validTo: timestamp("valid_to", { withTimezone: true }),
  maxUses: integer("max_uses"),
  usedCount: integer("used_count").notNull().default(0),
  /** How many months of paid periods get the discount; null: the first payment only. */
  months: integer("months"),
  disabled: boolean("disabled").notNull().default(false),
});

/** Plan changes, payments and lifecycle steps of an account, for support and review. */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("billing_events_account_idx").on(t.accountId, t.createdAt)],
);

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
    /** Over the plan's company limit after a downgrade: data visible, imports and AI off. */
    readOnly: boolean("read_only").notNull().default(false),
    /** The owner chose to keep it active when a downgrade leaves room for fewer companies. */
    preferred: boolean("preferred").notNull().default(false),
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
  /** Set for a learned template: it belongs to this account's company only. */
  accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
  company: text("company"),
  source: text("source", { enum: ["admin", "learned"] })
    .notNull()
    .default("admin"),
  hits: integer("hits").notNull().default(0),
  rejected: integer("rejected").notNull().default(0),
  /** After the query: prepare a card from its references (see TemplateAction). */
  action: jsonb("action").$type<{ tool: string; refsColumn: number } | null>(),
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

/** What was done for each finished question, without the data: what the engine learns from. */
export const aiTraces = pgTable(
  "ai_traces",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    company: text("company").notNull(),
    question: text("question").notNull(),
    outcome: text("outcome").notNull(),
    steps: jsonb("steps").$type<unknown[]>().notNull(),
    /** What the PC's rules found: the query, phrase, parameter types, columns and action. */
    learnable: jsonb("learnable").$type<Record<string, unknown> | null>(),
    /** The query (and action) the question was answered by: traces with the same are one group. */
    groupKey: text("group_key"),
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_traces_account_idx").on(t.accountId, t.createdAt),
    index("ai_traces_group_idx").on(t.accountId, t.groupKey),
  ],
);

/**
 * Questions answered by the same query, and what the reasoner decided about them. pending: not
 * enough sightings yet, or not decided; accepted: a template was made; rejected: not reusable.
 */
export const templateGroups = pgTable(
  "template_groups",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    company: text("company").notNull(),
    groupKey: text("group_key").notNull(),
    phrase: text("phrase").notNull(),
    question: text("question").notNull(),
    action: text("action"),
    hits: integer("hits").notNull().default(0),
    status: text("status", { enum: ["pending", "accepted", "rejected"] })
      .notNull()
      .default("pending"),
    reason: text("reason").notNull().default(""),
    /** Times the reasoner failed to give a usable answer; after 3 it stops asking. */
    attempts: integer("attempts").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("template_groups_key").on(t.accountId, t.company, t.groupKey)],
);
