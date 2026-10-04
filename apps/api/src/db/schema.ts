/**
 * Control system tables (TD §10 "Backend"). Who pays and what they may use; no accounting data.
 * Migrations are generated from this file: pnpm --filter @platform/api db:generate
 */
import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
