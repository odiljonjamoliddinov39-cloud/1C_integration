/**
 * Tariffs and billing (docs/billing.md): what a plan allows, what an account may do now, and what the
 * customer pays. Prices are whole sum, VAT excluded unless a field says otherwise.
 */
import { z } from "zod";

export const PlanCode = z.enum(["free", "start", "business", "firm", "custom"]);
export type PlanCode = z.infer<typeof PlanCode>;

/** Free is where every account starts and where an unpaid one lands. trial: the Business trial. */
export const BillingStatus = z.enum(["active", "trial", "grace", "free"]);
export type BillingStatus = z.infer<typeof BillingStatus>;

export const BillingCycle = z.enum(["month", "year"]);
export type BillingCycle = z.infer<typeof BillingCycle>;

/** The account's current limits: the plan, its add-ons, the trial and the promo merged (one function). */
export const Entitlements = z.object({
  plan: z.string(),
  status: BillingStatus,
  /** End of the paid, trial or grace period; null for Free. */
  periodEnd: z.string().nullable(),
  companies: z.number(),
  users: z.number(),
  /** null: unlimited. */
  importsPerMonth: z.number().nullable(),
  auditsPerMonth: z.number().nullable(),
  aiQuestionsPerMonth: z.number(),
  features: z.object({ excelExport: z.boolean(), prioritySupport: z.boolean() }),
});
export type Entitlements = z.infer<typeof Entitlements>;

/** What the account has used in the current period, next to what it has (EntitlementsResponse). */
export const UsageView = z.object({
  /** Where the counting period started (ISO). */
  periodStart: z.string(),
  companies: z.number(),
  users: z.number(),
  imports: z.number(),
  audits: z.number(),
  aiQuestions: z.number(),
});
export type UsageView = z.infer<typeof UsageView>;

export const EntitlementsResponse = z.object({
  entitlements: Entitlements,
  usage: UsageView,
  /** Companies over the plan's limit: data is visible, imports and AI are off. Their INNs. */
  readOnlyCompanies: z.array(z.string()),
  /** A trial can still be started (never used, Free). */
  canStartTrial: z.boolean(),
  /** The plan takes effect later (a scheduled downgrade) or the account will fall back to Free. */
  pendingPlan: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  /** The website's cabinet, where "Upgrade" leads (null when the server does not know the site). */
  cabinetUrl: z.string().nullable(),
});
export type EntitlementsResponse = z.infer<typeof EntitlementsResponse>;

/** A year is paid as 10 months (12 for 10: "2 months free"), the rule the pricing page and the invoices follow. */
export const YEAR_PAID_MONTHS = 10;
export const YEAR_MONTHS = 12;

/** The yearly price of a plan is always worked out from its monthly price (12 for 10); no yearly price is kept by hand. */
export const yearPriceOf = (monthSum: number): number => monthSum * YEAR_PAID_MONTHS;

export const PlanView = z.object({
  code: z.string(),
  name: z.string(),
  priceMonthSum: z.number(),
  priceYearSum: z.number(),
  companies: z.number(),
  users: z.number(),
  importsPerMonth: z.number().nullable(),
  auditsPerMonth: z.number().nullable(),
  aiQuestionsPerMonth: z.number(),
  features: z.object({
    excelExport: z.boolean(),
    prioritySupport: z.boolean(),
    support: z.string(),
    /** Telegram remote control (docs/remote-control.md). */
    telegram: z.boolean().default(false),
  }),
  isPublic: z.boolean(),
  sortOrder: z.number(),
});
export type PlanView = z.infer<typeof PlanView>;

export const AddonView = z.object({
  code: z.string(),
  name: z.string(),
  priceSum: z.number(),
  kind: z.enum(["recurring", "one_off"]),
  allowedPlans: z.array(z.string()),
  grants: z.object({
    companies: z.number().optional(),
    users: z.number().optional(),
    aiQuestions: z.number().optional(),
  }),
});
export type AddonView = z.infer<typeof AddonView>;

/** The public pricing page's data. */
export const CatalogResponse = z.object({
  plans: z.array(PlanView),
  addons: z.array(AddonView),
  vatPercent: z.number(),
  trialDays: z.number(),
  /** The payment systems that work now (e.g. ["payme", "bank"]). */
  providers: z.array(z.string()),
});
export type CatalogResponse = z.infer<typeof CatalogResponse>;

export const InvoiceItemView = z.object({
  kind: z.enum(["plan", "upgrade", "addon"]),
  code: z.string(),
  title: z.string(),
  quantity: z.number(),
  amountSum: z.number(),
});

export const InvoiceStatus = z.enum(["pending", "paid", "cancelled", "expired"]);

export const InvoiceView = z.object({
  id: z.string(),
  number: z.string(),
  items: z.array(InvoiceItemView),
  subtotalSum: z.number(),
  discountSum: z.number(),
  vatSum: z.number(),
  totalSum: z.number(),
  status: InvoiceStatus,
  provider: z.string().nullable(),
  dueAt: z.string(),
  paidAt: z.string().nullable(),
  createdAt: z.string(),
});
export type InvoiceView = z.infer<typeof InvoiceView>;

export const SubscriptionResponse = z.object({
  plan: z.string(),
  status: BillingStatus,
  billingCycle: BillingCycle,
  periodStart: z.string(),
  periodEnd: z.string().nullable(),
  autoRenew: z.boolean(),
  cancelAtPeriodEnd: z.boolean(),
  pendingPlan: z.string().nullable(),
  trialUsed: z.boolean(),
  addons: z.array(
    z.object({ code: z.string(), quantity: z.number(), validFrom: z.string(), validTo: z.string() }),
  ),
  /** The invoice the next payment is for, when one exists (pending). */
  nextInvoice: InvoiceView.nullable(),
});
export type SubscriptionResponse = z.infer<typeof SubscriptionResponse>;

export const PaymentProvider = z.enum(["payme", "click", "bank"]);
export type PaymentProvider = z.infer<typeof PaymentProvider>;

/** Body of POST /v1/billing/checkout: a plan or an add-on, how often, and an optional promo code. */
export const CheckoutInput = z
  .object({
    plan: z.string().min(1).max(40).optional(),
    addon: z.string().min(1).max(40).optional(),
    quantity: z.number().int().min(1).max(50).default(1),
    cycle: BillingCycle.default("month"),
    promoCode: z.string().trim().min(1).max(40).optional(),
    provider: PaymentProvider.default("payme"),
  })
  .refine((v) => Boolean(v.plan) !== Boolean(v.addon), "Choose a plan or an add-on");
export type CheckoutInput = z.infer<typeof CheckoutInput>;

export const CheckoutResponse = z.object({
  invoice: InvoiceView,
  /** Where to send the customer to pay; null for a bank transfer (the invoice is the instruction). */
  checkoutUrl: z.string().nullable(),
  /**
   * Click: the values of its in-page payment window (checkout.js), so that the cabinet can open it over the page instead of
   * leaving it. The card is typed in Click's window; nothing of it reaches the cabinet or the server.
   */
  click: z
    .object({
      serviceId: z.string(),
      merchantId: z.string(),
      merchantUserId: z.string().optional(),
      amount: z.string(),
      transactionParam: z.string(),
    })
    .optional(),
});
export type CheckoutResponse = z.infer<typeof CheckoutResponse>;

export const ChangePlanInput = z.object({
  plan: z.string().min(1).max(40),
  cycle: BillingCycle.optional(),
  provider: PaymentProvider.default("payme"),
});
export type ChangePlanInput = z.infer<typeof ChangePlanInput>;

/** An upgrade makes an invoice to pay; a downgrade is scheduled for the end of the period. */
export const ChangePlanResponse = z.object({
  effect: z.enum(["invoice", "scheduled", "none"]),
  checkout: CheckoutResponse.nullable(),
  /** When a scheduled change takes effect. */
  effectiveAt: z.string().nullable(),
});
export type ChangePlanResponse = z.infer<typeof ChangePlanResponse>;

/** The error code a refused action carries, with the plan that would allow it. */
export const LimitCode = z.enum([
  "COMPANY_LIMIT",
  "USER_LIMIT",
  "IMPORT_LIMIT",
  "AUDIT_LIMIT",
  "AI_QUESTIONS_LIMIT",
  "FEATURE_UNAVAILABLE",
  "COMPANY_READ_ONLY",
]);
export type LimitCode = z.infer<typeof LimitCode>;

export const CompanyInput = z.object({
  inn: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(200),
});
export type CompanyInput = z.infer<typeof CompanyInput>;

export const CompanyView = z.object({
  id: z.string(),
  inn: z.string(),
  name: z.string(),
  readOnly: z.boolean(),
  connectedAt: z.string(),
});
export type CompanyView = z.infer<typeof CompanyView>;

export const ImportInput = z.object({
  /** Documents written to 1C in this call. */
  count: z.number().int().min(1).max(500).default(1),
  inn: z.string().trim().max(20).optional(),
});
export type ImportInput = z.infer<typeof ImportInput>;

export const AuditRunInput = z.object({ inn: z.string().trim().max(20).optional() });
export type AuditRunInput = z.infer<typeof AuditRunInput>;

export const InviteUserInput = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(200),
});
export type InviteUserInput = z.infer<typeof InviteUserInput>;

/** The Business trial: 14 days, AI questions capped for the whole trial. */
export const TRIAL_AI_QUESTIONS = 30;
export const TRIAL_DAYS = 14;
/** Days of full access after a missed payment. */
export const GRACE_DAYS = 3;
