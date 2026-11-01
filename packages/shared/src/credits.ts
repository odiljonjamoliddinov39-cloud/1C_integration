/**
 * AI credits (TZ "AI Buxgalter kredit tizimi"): one balance per account, every AI call is paid from it at its real cost.
 * 1 credit = $0.01 (the unit of the Anthropic price list); the customer sees credits and their price in soum.
 */
import { z } from "zod";

/** What one credit is worth, in USD. */
export const CREDIT_USD = 0.01;
/** Credits of a call that costs `costUsd`, exactly (the balance keeps four decimals). */
export const creditsOfUsd = (costUsd: number): number => Math.round((costUsd / CREDIT_USD) * 10_000) / 10_000;

/** The monthly credits of the plans (a 40% share of the price goes to AI): $5, $30.4, $81.1, $199.3. */
export const PLAN_MONTHLY_CREDITS: Record<string, number> = {
  free: 500,
  start: 3_040,
  business: 8_110,
  firm: 19_930,
};
/** The credits of the 14-day trial, given once per account and company INN ($15). */
export const TRIAL_CREDITS = 1_500;
/** The most an account may hold: $500, 6 000 000 soum at the starting price. Purchases and monthly credits stop at it. */
export const ROLLOVER_CAP_CREDITS = 50_000;
/** The least an auto-recharge can buy (credits). */
export const MIN_PURCHASE_CREDITS = 1_000;

/**
 * What a plan's AI may cost, by its monthly payment: the normal budget is this share (percent) of the price, and the cost never
 * goes over the ceiling share. The server's AI_BUDGET_PCT / AI_COST_CAP_PCT can change them.
 */
export const AI_BUDGET_PCT = 40;
export const AI_COST_CAP_PCT = 45;
/** Free has no price to take a share of: its AI budget is this many soum a month. */
export const FREE_AI_BUDGET_SUM = 20_000;
/** An extra top-up: this share of the sum paid becomes AI balance (the rest is the margin). */
export const TOPUP_BALANCE_SHARE = 0.7;
/** The least a top-up can be, in soum: any sum from this up. */
export const MIN_TOPUP_SUM = 10_000;
export const MAX_TOPUP_SUM = 100_000_000;
/** Until there is real use to learn from: what a question costs on average, in soum. */
export const FALLBACK_QUESTION_SOM = 2_800;

/** The AI credits a top-up of `paidSum` soum gives, at `somPerCredit`. */
export const topupCredits = (paidSum: number, somPerCredit: number): number =>
  Math.floor((paidSum * TOPUP_BALANCE_SHARE) / somPerCredit);
/** The soum to pay so that `credits` are added by a top-up (the other way round of topupCredits). */
export const payForCredits = (credits: number, somPerCredit: number): number =>
  Math.ceil((credits * somPerCredit) / TOPUP_BALANCE_SHARE);
/** The starting price of a credit, in soum (the CBU rate of the day it was set was about 11 839). */
export const START_SOM_PER_CREDIT = 120;
export const START_CBU_RATE = 11_839;
/** The price of a credit follows the CBU rate with a small reserve over the market rate (about 1.3%). */
export const CREDIT_RATE_MARGIN = 1.013;
/** The price is worked out again when the CBU rate moved this share from the rate it was set at. */
export const RATE_CHANGE_SHARE = 0.05;
/** A low-balance warning: under this many credits, or this share of the plan's monthly credits, whichever is smaller. */
export const LOW_BALANCE_CREDITS = 500;
export const LOW_BALANCE_SHARE = 0.2;

/** soum per credit from a CBU rate (soum per USD), rounded to the nearest 10. */
export const somPerCreditOf = (cbuRate: number): number =>
  Math.max(10, Math.round((cbuRate * CREDIT_USD * CREDIT_RATE_MARGIN) / 10) * 10);

export const CREDIT_TRANSACTION_TYPES = [
  "monthly_grant",
  "trial_grant",
  "purchase",
  "bonus",
  "ai_usage",
  "rollover",
  "admin_adjustment",
] as const;
export const CreditTransactionType = z.enum(CREDIT_TRANSACTION_TYPES);
export type CreditTransactionType = z.infer<typeof CreditTransactionType>;

export const CreditTransactionView = z.object({
  id: z.string(),
  type: CreditTransactionType,
  /** Signed: a grant is positive, AI use negative. */
  amountCredits: z.number(),
  balanceAfter: z.number(),
  note: z.string().nullable(),
  /** Which balance it moved: the plan's credits or the extra (bought) ones. */
  pool: z.enum(["plan", "extra"]).default("plan"),
  createdAt: z.string(),
});
export type CreditTransactionView = z.infer<typeof CreditTransactionView>;

export const AutoRechargeSettings = z.object({
  enabled: z.boolean(),
  /** Recharge when the balance falls under this many credits. */
  thresholdCredits: z.number().int().min(0).max(ROLLOVER_CAP_CREDITS),
  /** How many credits each recharge buys. */
  amountCredits: z.number().int().min(MIN_PURCHASE_CREDITS).max(ROLLOVER_CAP_CREDITS),
  method: z.enum(["payme", "click"]).nullable(),
  /** Whether a card is saved for it (the card itself never reaches us). */
  hasCard: z.boolean(),
});
export type AutoRechargeSettings = z.infer<typeof AutoRechargeSettings>;

export const CreditRequestStatus = z.enum(["pending", "approved", "rejected", "cancelled"]);
export type CreditRequestStatus = z.infer<typeof CreditRequestStatus>;

/** A request to buy more credits, as the customer sees it. */
export const CreditRequestView = z.object({
  id: z.string(),
  credits: z.number(),
  somPerCredit: z.number(),
  totalSom: z.number(),
  status: CreditRequestStatus,
  /** What the admin wrote when deciding. */
  note: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type CreditRequestView = z.infer<typeof CreditRequestView>;

/** The customer asks for credits: no payment provider, the admin approves. */
export const RequestCreditsInput = z.object({
  /** The soum the customer pays: any sum from the minimum up. */
  sum: z.number().int().min(MIN_TOPUP_SUM).max(MAX_TOPUP_SUM),
});
export type RequestCreditsInput = z.infer<typeof RequestCreditsInput>;

/** A day's or a week's limit of the plan's credits and how much of it is used. */
export const CreditLimitView = z.object({
  limitCredits: z.number(),
  usedCredits: z.number(),
  /** When the window starts over. */
  resetsAt: z.string(),
});
export type CreditLimitView = z.infer<typeof CreditLimitView>;

/** What stops the plan's credits now: the day's limit, the week's limit, or nothing left of them (null: nothing). */
export const CreditBlock = z.enum(["daily", "weekly", "plan"]).nullable();
export type CreditBlock = z.infer<typeof CreditBlock>;

export const CreditsView = z.object({
  /** The plan's credits: what the plan gives each month, with what was carried over. */
  balanceCredits: z.number(),
  /** The extra credits: bought or given as a bonus. Used only when the plan's credits or a limit are out, and only if allowed. */
  extraCredits: z.number().default(0),
  /** The customer allowed the extra credits to be used when the plan's credits or a limit are out. */
  extraEnabled: z.boolean().default(false),
  /** The day's and the week's limits of the plan's credits (null: the plan has none). */
  daily: CreditLimitView.nullable().default(null),
  weekly: CreditLimitView.nullable().default(null),
  /** Why the plan's credits cannot be used now, if they cannot. */
  blocked: CreditBlock.default(null),
  /** When the plan's credits are added again. */
  planResetsAt: z.string().nullable().default(null),
  /** The balance in soum at the current price of a credit. */
  balanceSom: z.number(),
  somPerCredit: z.number(),
  /** The credits the plan adds each month. */
  monthlyCredits: z.number(),
  rolloverCapCredits: z.number(),
  /** The balance is under the warning level (see LOW_BALANCE_CREDITS). */
  low: z.boolean(),
  /** The account is at the cap: new monthly credits are not added. */
  atCap: z.boolean(),
  /** Credits are not added to a Free account's balance by purchase: it has no payment method. */
  canPurchase: z.boolean(),
  /** A top-up: the least sum in soum, and the share of it that becomes balance. */
  minTopupSum: z.number().default(MIN_TOPUP_SUM),
  topupShare: z.number().default(TOPUP_BALANCE_SHARE),
  /** The ceiling of the plan's credits in a period (the cost never goes over it), and how much is used of it. */
  capCredits: z.number().default(0),
  usedPeriodCredits: z.number().default(0),
  /** What a question costs on average, in soum, and its tokens (null until there is use to learn from). */
  questionSom: z.number().default(FALLBACK_QUESTION_SOM),
  tokensPerQuestion: z.number().nullable().default(null),
  autoRecharge: AutoRechargeSettings,
  /** Extra credits are added when an admin approves a request (see CreditRequestView), not paid online. */
  approvalRequired: z.boolean(),
  /** The account's latest purchase requests, newest first. */
  requests: z.array(CreditRequestView),
  history: z.array(CreditTransactionView),
});
export type CreditsView = z.infer<typeof CreditsView>;

/** The short form on the entitlements: enough for the desktop's sidebar and its "no credits" dialog. */
export const CreditsSummary = z.object({
  balanceCredits: z.number(),
  /** What a question costs on average, in soum, and its tokens (null until there is use to learn from). */
  questionSom: z.number().default(FALLBACK_QUESTION_SOM),
  tokensPerQuestion: z.number().nullable().default(null),
  extraCredits: z.number().default(0),
  extraEnabled: z.boolean().default(false),
  blocked: CreditBlock.default(null),
  /** The day's and the week's limits of the plan's credits, with how much is used (null: the plan has none). */
  daily: CreditLimitView.nullable().default(null),
  weekly: CreditLimitView.nullable().default(null),
  /** When the day's or the week's limit starts over, while it is the one reached. */
  resetsAt: z.string().nullable().default(null),
  somPerCredit: z.number(),
  monthlyCredits: z.number(),
  low: z.boolean(),
});
export type CreditsSummary = z.infer<typeof CreditsSummary>;

export const PurchaseCreditsInput = z.object({
  sum: z.number().int().min(MIN_TOPUP_SUM).max(MAX_TOPUP_SUM),
  provider: z.enum(["payme", "click", "bank"]).default("payme"),
});
export type PurchaseCreditsInput = z.infer<typeof PurchaseCreditsInput>;

/** The customer allows (or stops) the extra credits being used when the plan's credits or a limit are out. */
export const ExtraCreditsInput = z.object({ enabled: z.boolean() });
export type ExtraCreditsInput = z.infer<typeof ExtraCreditsInput>;

export const AutoRechargeInput = z.object({
  enabled: z.boolean(),
  thresholdCredits: z.number().int().min(0).max(ROLLOVER_CAP_CREDITS),
  amountCredits: z.number().int().min(MIN_PURCHASE_CREDITS).max(ROLLOVER_CAP_CREDITS),
  method: z.enum(["payme", "click"]).nullable().default(null),
  /** The token of the card the payment system saved (set once, kept; never the card number). */
  cardToken: z.string().min(4).max(200).optional(),
});
export type AutoRechargeInput = z.infer<typeof AutoRechargeInput>;

// --- the admin side ----------------------------------------------------------------------------

export const AdminCreditAdjustInput = z.object({
  /** Added (positive) or taken away (negative). */
  credits: z
    .number()
    .int()
    .refine((n) => n !== 0, "Not zero")
    .refine((n) => Math.abs(n) <= ROLLOVER_CAP_CREDITS),
  reason: z.string().trim().min(3).max(300),
  /** A bonus or promo credit, or a plain correction. */
  kind: z.enum(["bonus", "admin_adjustment"]).default("admin_adjustment"),
  /** Which balance: the plan's credits or the extra ones. */
  pool: z.enum(["plan", "extra"]).default("plan"),
});
export type AdminCreditAdjustInput = z.infer<typeof AdminCreditAdjustInput>;

export const AdminCreditRateInput = z.object({
  somPerCredit: z.number().int().min(10).max(100_000),
  reason: z.string().trim().min(3).max(300),
});
export type AdminCreditRateInput = z.infer<typeof AdminCreditRateInput>;

export const CreditRateRow = z.object({
  id: z.string(),
  oldSomPerCredit: z.number(),
  newSomPerCredit: z.number(),
  cbuRate: z.number(),
  setBy: z.string(),
  note: z.string().nullable(),
  createdAt: z.string(),
});
export type CreditRateRow = z.infer<typeof CreditRateRow>;

export const CreditFailureRow = z.object({
  id: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  amountCredits: z.number(),
  reason: z.string(),
  createdAt: z.string(),
});
export type CreditFailureRow = z.infer<typeof CreditFailureRow>;

export const AdminCreditsReport = z.object({
  somPerCredit: z.number(),
  cbuRate: z.number(),
  /** Credits sold by purchase, and what they were paid in soum (VAT excluded), over the last 30 days. */
  soldCredits30d: z.number(),
  soldSom30d: z.number(),
  spentCredits30d: z.number(),
  /** Unused monthly credits carried to the next month (30 days). */
  rolledOverCredits30d: z.number(),
  accountsAtCap: z.number(),
  totalBalanceCredits: z.number(),
  /** Requests waiting for an admin. */
  pendingRequests: z.number(),
  rates: z.array(CreditRateRow),
  failures: z.array(CreditFailureRow),
});
export type AdminCreditsReport = z.infer<typeof AdminCreditsReport>;

/** A purchase request in the dashboard. */
export const AdminCreditRequest = CreditRequestView.extend({
  accountId: z.string(),
  accountName: z.string(),
  /** Whom the request came from. */
  userEmail: z.string().nullable(),
  /** The account's balance now, to judge the request by. */
  balanceCredits: z.number(),
  decidedBy: z.string().nullable(),
});
export type AdminCreditRequest = z.infer<typeof AdminCreditRequest>;

export const AdminCreditRequestsResponse = z.object({
  pendingCount: z.number(),
  requests: z.array(AdminCreditRequest),
});
export type AdminCreditRequestsResponse = z.infer<typeof AdminCreditRequestsResponse>;

export const AdminCreditDecisionInput = z.object({
  note: z.string().trim().max(300).optional(),
});
export type AdminCreditDecisionInput = z.infer<typeof AdminCreditDecisionInput>;

/** What "Restart payments" cleared for a customer. */
export const AdminRestartPaymentsResult = z.object({
  cancelledInvoices: z.number(),
  cancelledRequests: z.number(),
});
export type AdminRestartPaymentsResult = z.infer<typeof AdminRestartPaymentsResult>;

export const AdminAccountCredits = z.object({
  balanceCredits: z.number(),
  extraCredits: z.number(),
  extraEnabled: z.boolean(),
  somPerCredit: z.number(),
  rolloverCapCredits: z.number(),
  requests: z.array(AdminCreditRequest),
  history: z.array(CreditTransactionView),
});
export type AdminAccountCredits = z.infer<typeof AdminAccountCredits>;
