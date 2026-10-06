/**
 * Contract between the admin dashboard and the control system (TD §8 "Admin API", "Admin
 * dashboard"). Admins are our staff, not customers: they have their own sign-in and roles.
 * Like the rest of the control system, nothing here holds a customer's accounting data.
 */
import { z } from "zod";

import { Email, Password, SubscriptionStatus } from "./control-api.js";

/** owner: everything; support: look up customers, extend licenses, manage their PCs. */
export const AdminRole = z.enum(["owner", "support"]);
export type AdminRole = z.infer<typeof AdminRole>;

export const AdminLoginInput = z.object({ email: Email, password: z.string().min(1).max(200) });
export type AdminLoginInput = z.infer<typeof AdminLoginInput>;

export const AdminView = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: AdminRole,
  disabled: z.boolean(),
  lastLoginAt: z.string().nullable(),
});
export type AdminView = z.infer<typeof AdminView>;

export const AdminSession = z.object({ accessToken: z.string(), expiresIn: z.number(), admin: AdminView });
export type AdminSession = z.infer<typeof AdminSession>;

export const CreateAdminInput = z.object({
  email: Email,
  name: z.string().trim().min(1).max(120),
  password: Password,
  role: AdminRole,
});
export type CreateAdminInput = z.infer<typeof CreateAdminInput>;

export const ExtendInput = z.object({
  days: z.number().int().min(1).max(366),
  /** Why, for the audit log (e.g. "paid by bank transfer"). */
  reason: z.string().trim().max(300).default(""),
});
export type ExtendInput = z.infer<typeof ExtendInput>;

/** Adds AI tokens to an account: to this period's quota, and to today's cap. */
export const RechargeInput = z.object({
  tokens: z.number().int().min(1_000).max(100_000_000),
  /** Why, for the audit log (e.g. "paid 50 000 so'm"). */
  reason: z.string().trim().max(300).default(""),
});
export type RechargeInput = z.infer<typeof RechargeInput>;

/**
 * Models the assistant can run on. Both take adaptive thinking with progress notes, all five effort
 * levels and 128K output, so switching between them needs nothing else.
 */
export const AI_MODELS = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", price: "$2 / $10 per million tokens (in / out)" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", price: "$4 / $20 per million tokens (in / out)" },
] as const;
export const AiModelId = z.enum(["claude-sonnet-5-5", "claude-opus-5-5"]);
export type AiModelId = z.infer<typeof AiModelId>;
/** How much the model thinks before each step: low is fastest and cheapest, max the most thorough. */
export const AiEffort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type AiEffort = z.infer<typeof AiEffort>;

/** The model and effort every account gets unless it has its own. Owner only. */
export const AiSettingsInput = z.object({ model: AiModelId, effort: AiEffort });
export type AiSettingsInput = z.infer<typeof AiSettingsInput>;

export const AiSettingsView = z.object({
  model: z.string(),
  effort: z.string(),
  /** "admin": set in this dashboard; "server": the server's default (AI_MODEL / AI_EFFORT). */
  source: z.enum(["admin", "server"]),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
export type AiSettingsView = z.infer<typeof AiSettingsView>;

/** One account's own model and effort; null keeps the global one. Owner only. */
export const AccountAiInput = z.object({ model: AiModelId.nullable(), effort: AiEffort.nullable() });
export type AccountAiInput = z.infer<typeof AccountAiInput>;

export const AccountsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: SubscriptionStatus.optional(),
});
export type AccountsQuery = z.infer<typeof AccountsQuery>;

/** A row of the customers list. */
export const AccountRow = z.object({
  id: z.string(),
  name: z.string(),
  ownerEmail: z.string().nullable(),
  blocked: z.boolean(),
  plan: z.string().nullable(),
  status: SubscriptionStatus.nullable(),
  endsAt: z.string().nullable(),
  users: z.number(),
  activeDevices: z.number(),
  companies: z.number(),
  /** Last sign-in or license check of any of its PCs. */
  lastActivityAt: z.string().nullable(),
  aiCostUsd30d: z.number(),
  createdAt: z.string(),
});
export type AccountRow = z.infer<typeof AccountRow>;

export const AdminDeviceView = z.object({
  id: z.string(),
  name: z.string(),
  userEmail: z.string(),
  activatedAt: z.string(),
  lastSeenAt: z.string(),
  revoked: z.boolean(),
});
export type AdminDeviceView = z.infer<typeof AdminDeviceView>;

export const UsageDay = z.object({
  date: z.string(),
  requests: z.number(),
  tokens: z.number(),
  costUsd: z.number(),
});
export type UsageDay = z.infer<typeof UsageDay>;

export const AuditEntry = z.object({
  id: z.string(),
  at: z.string(),
  adminEmail: z.string().nullable(),
  action: z.string(),
  target: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AccountDetail = z.object({
  account: AccountRow,
  users: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      name: z.string(),
      role: z.string(),
      lastLoginAt: z.string().nullable(),
    }),
  ),
  subscriptions: z.array(
    z.object({
      id: z.string(),
      plan: z.string(),
      status: SubscriptionStatus,
      startsAt: z.string(),
      endsAt: z.string(),
    }),
  ),
  devices: z.array(AdminDeviceView),
  companies: z.array(z.object({ inn: z.string(), name: z.string(), connectedAt: z.string() })),
  /** Plan quota plus the tokens added this period; cached prompt tokens count a tenth. */
  aiQuota: z.number(),
  aiUsedTokens: z.number(),
  /** Tokens added by admins this period (part of aiQuota). */
  aiGranted: z.number(),
  /** The daily cap plus the tokens added today, and today's use (UTC day). */
  aiDailyLimit: z.number(),
  aiUsedToday: z.number(),
  /** The account's own model and effort (null: the global one), and what it runs on now. */
  ai: z.object({
    model: z.string().nullable(),
    effort: z.string().nullable(),
    effective: z.object({ model: z.string(), effort: z.string() }),
  }),
  usage: z.array(UsageDay),
  audit: z.array(AuditEntry),
});
export type AccountDetail = z.infer<typeof AccountDetail>;

export const Overview = z.object({
  accounts: z.number(),
  newAccounts7d: z.number(),
  byStatus: z.record(SubscriptionStatus, z.number()),
  activeDevices24h: z.number(),
  ai: z.object({
    requests30d: z.number(),
    tokens30d: z.number(),
    costUsd30d: z.number(),
    costUsdToday: z.number(),
  }),
  usage: z.array(UsageDay),
});
export type Overview = z.infer<typeof Overview>;

export const UsageRow = z.object({
  accountId: z.string(),
  accountName: z.string(),
  requests: z.number(),
  tokens: z.number(),
  costUsd: z.number(),
});
export type UsageRow = z.infer<typeof UsageRow>;
