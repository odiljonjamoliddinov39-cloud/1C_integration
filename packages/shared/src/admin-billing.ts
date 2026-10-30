/** The admin dashboard's billing screens: plans and add-ons, subscriptions, revenue, promo codes. */
import { z } from "zod";

import { AddonView, BillingCycle, type InvoiceView, PlanView } from "./billing.js";

/** Edit a plan's price and limits; a new code (e.g. "custom") makes a plan by hand. */
export const PlanSaveInput = z.object({
  name: z.string().trim().min(1).max(60),
  priceMonthSum: z.number().int().min(0).max(1_000_000_000),
  priceYearSum: z.number().int().min(0).max(10_000_000_000),
  companies: z.number().int().min(1).max(10_000),
  users: z.number().int().min(1).max(10_000),
  importsPerMonth: z.number().int().min(0).nullable(),
  auditsPerMonth: z.number().int().min(0).nullable(),
  aiQuestionsPerMonth: z.number().int().min(0).max(1_000_000),
  /** The AI credits the plan adds each month. */
  monthlyCredits: z.number().int().min(0).max(1_000_000).default(0),
  features: z.object({
    excelExport: z.boolean(),
    prioritySupport: z.boolean(),
    support: z.string().trim().max(40),
    telegram: z.boolean().default(false),
  }),
  isPublic: z.boolean(),
  sortOrder: z.number().int().min(0).max(1000),
});
export type PlanSaveInput = z.infer<typeof PlanSaveInput>;

export const AddonSaveInput = z.object({
  name: z.string().trim().min(1).max(80),
  priceSum: z.number().int().min(0).max(1_000_000_000),
  kind: z.enum(["recurring", "one_off"]),
  allowedPlans: z.array(z.string().min(1).max(40)).max(20),
  grants: z.object({
    companies: z.number().int().min(0).optional(),
    users: z.number().int().min(0).optional(),
    aiQuestions: z.number().int().min(0).optional(),
  }),
  isPublic: z.boolean(),
});
export type AddonSaveInput = z.infer<typeof AddonSaveInput>;

export const AdminPlansView = z.object({
  plans: z.array(PlanView),
  addons: z.array(AddonView.extend({ isPublic: z.boolean() })),
});
export type AdminPlansView = z.infer<typeof AdminPlansView>;

/**
 * What an admin does to a subscription: put it on a plan (a comp or a manual sale), extend it, mark a
 * bank-transfer invoice paid, or give an add-on. Every one is written to the audit log with the reason.
 */
export const SubscriptionActionInput = z.object({
  /** Put the account on this plan now. */
  plan: z.string().min(1).max(40).optional(),
  cycle: BillingCycle.optional(),
  /** Add days to the end of the period (to today when it has passed). */
  days: z.number().int().min(1).max(366).optional(),
  /** A bank-transfer invoice that was paid: it is applied as if the provider confirmed it. */
  markPaidInvoiceId: z.uuid().optional(),
  /** Give an add-on for the rest of the period. */
  addon: z.string().min(1).max(40).optional(),
  quantity: z.number().int().min(1).max(50).default(1),
  reason: z.string().trim().max(300).default(""),
});
export type SubscriptionActionInput = z.infer<typeof SubscriptionActionInput>;

export interface AdminSubscriptionRow {
  accountId: string;
  subscriptionId: string;
  accountName: string;
  ownerEmail: string;
  plan: string;
  status: string;
  billingCycle: string;
  periodEnd: string | null;
  autoRenew: boolean;
  cancelAtPeriodEnd: boolean;
  pendingPlan: string | null;
  trialUsed: boolean;
  promoCode: string | null;
  paidInvoices: number;
  pendingInvoices: number;
}

export interface AdminBillingDetail {
  subscription: AdminSubscriptionRow;
  addons: { code: string; quantity: number; validFrom: string; validTo: string }[];
  invoices: InvoiceView[];
  events: { id: string; type: string; payload: Record<string, unknown>; createdAt: string }[];
}

export interface RevenueReport {
  /** Monthly recurring revenue: each paid subscription at its monthly price (a year's price / 12), VAT excluded. */
  mrrSum: number;
  /** Accounts by what they are now. */
  byPlan: { plan: string; accounts: number; mrrSum: number }[];
  accounts: number;
  freeAccounts: number;
  trialAccounts: number;
  paidAccounts: number;
  /** Accounts that ever paid, of all accounts: Free → paid conversion. */
  conversionPercent: number;
  /** Paid invoices in the last 30 days, VAT included. */
  collected30dSum: number;
  /** Invoices still unpaid after their due date. */
  overdue: {
    count: number;
    totalSum: number;
    items: { number: string; accountName: string; totalSum: number; dueAt: string }[];
  };
}

export const PromoInput = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{3,40}$/, "Letters, digits, - and _ only"),
  kind: z.enum(["percent", "fixed"]),
  value: z.number().int().min(1),
  allowedPlans: z.array(z.string().min(1).max(40)).max(20).default([]),
  validFrom: z.string().nullable().default(null),
  validTo: z.string().nullable().default(null),
  maxUses: z.number().int().min(1).nullable().default(null),
  /** How many months of paid periods get the discount; null: the first payment only. */
  months: z.number().int().min(1).max(60).nullable().default(null),
});
export type PromoInput = z.infer<typeof PromoInput>;

export interface PromoView {
  code: string;
  kind: "percent" | "fixed";
  value: number;
  allowedPlans: string[];
  validFrom: string | null;
  validTo: string | null;
  maxUses: number | null;
  usedCount: number;
  months: number | null;
  disabled: boolean;
}
