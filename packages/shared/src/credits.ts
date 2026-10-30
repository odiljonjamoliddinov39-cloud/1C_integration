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
/** The least a purchase can be (1 000 credits = 120 000 soum at the starting price). */
export const MIN_PURCHASE_CREDITS = 1_000;
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

export const CreditsView = z.object({
  balanceCredits: z.number(),
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
  minPurchaseCredits: z.number(),
  autoRecharge: AutoRechargeSettings,
  history: z.array(CreditTransactionView),
});
export type CreditsView = z.infer<typeof CreditsView>;

/** The short form on the entitlements: enough for the desktop's sidebar and its "no credits" dialog. */
export const CreditsSummary = z.object({
  balanceCredits: z.number(),
  somPerCredit: z.number(),
  monthlyCredits: z.number(),
  low: z.boolean(),
});
export type CreditsSummary = z.infer<typeof CreditsSummary>;

export const PurchaseCreditsInput = z.object({
  credits: z.number().int().min(MIN_PURCHASE_CREDITS).max(ROLLOVER_CAP_CREDITS),
  provider: z.enum(["payme", "click", "bank"]).default("payme"),
});
export type PurchaseCreditsInput = z.infer<typeof PurchaseCreditsInput>;

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
  rates: z.array(CreditRateRow),
  failures: z.array(CreditFailureRow),
});
export type AdminCreditsReport = z.infer<typeof AdminCreditsReport>;

export const AdminAccountCredits = z.object({
  balanceCredits: z.number(),
  somPerCredit: z.number(),
  rolloverCapCredits: z.number(),
  history: z.array(CreditTransactionView),
});
export type AdminAccountCredits = z.infer<typeof AdminAccountCredits>;
