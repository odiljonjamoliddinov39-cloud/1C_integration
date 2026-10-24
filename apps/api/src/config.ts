import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  /** HS256 secret for 15-minute access tokens. */
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  /** Ed25519 private key (PKCS#8 PEM) that signs license tokens; the desktop checks them offline. */
  LICENSE_PRIVATE_KEY: z.string().includes("PRIVATE KEY"),
  ACCESS_TOKEN_MINUTES: z.coerce.number().default(15),
  REFRESH_TOKEN_DAYS: z.coerce.number().default(30),
  /** The offline grace of the desktop app (TD §4). */
  LICENSE_TOKEN_DAYS: z.coerce.number().default(7),
  /** The website (https://...), where the desktop sends a customer to upgrade; empty: no link. */
  SITE_URL: z
    .string()
    .optional()
    .transform((v) => v?.trim().replace(/\/+$/, "") || undefined),
  /** VAT added to every invoice (shown separately); prices of the plans exclude it. */
  VAT_PERCENT: z.coerce.number().min(0).max(100).default(12),
  /** Days an invoice can be paid before it expires (a late payment is still accepted). */
  INVOICE_DUE_DAYS: z.coerce.number().int().min(1).default(3),
  /** Payme Merchant API (docs/billing.md): off until both are set. The key signs the webhook's Basic auth. */
  PAYME_MERCHANT_ID: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),
  PAYME_KEY: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),
  /** "true": the checkout of Payme's sandbox (checkout.test.paycom.uz) is used; "false": the real one. */
  PAYME_TEST: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /**
   * Fiscal receipt data for Payme ("detail" in CheckPerformTransaction), needed when the merchant has fiscalization switched
   * on in Payme's cabinet: the IKPU code and the package code of the service, and the unit of measurement. Off until the
   * code and the package are both set; take them from the tax authority's classifier, they are not guessed here.
   */
  PAYME_FISCAL_CODE: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),
  PAYME_FISCAL_PACKAGE: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),
  PAYME_FISCAL_UNITS: z.coerce.number().int().min(0).optional(),
  /** Our bank requisites, printed on invoices paid by bank transfer (plain text, lines separated by "|"). */
  BANK_REQUISITES: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),
  /** The scheduled billing jobs (reminders, grace, move to Free): "off" in tests. */
  BILLING_JOBS: z.enum(["on", "off"]).default("on"),
  /**
   * A heavy job counts as more than one AI question: one more for each further this many dollars of
   * real AI cost (an ordinary question, under it, is 1). 0: every question counts as 1.
   */
  AI_QUESTION_UNIT_USD: z.coerce.number().min(0).default(0.5),
  /** How long a computed set of limits is reused (0: never; tests use 0). */
  ENTITLEMENTS_CACHE_SECONDS: z.coerce.number().min(0).default(60),
  /** Open sign-up from the desktop app during the prototype (the website takes over later). */
  ALLOW_REGISTRATION: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  LOG_LEVEL: z.string().default("info"),
  /** Sign-up, sign-in and refresh attempts per IP per minute. */
  AUTH_RATE_PER_MINUTE: z.coerce.number().int().positive().default(10),
  /** Claude API key for the AI proxy. Without it the assistant answers AI_NOT_CONFIGURED. */
  ANTHROPIC_API_KEY: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),
  /** TD §8: default Sonnet 5.5. */
  AI_MODEL: z.string().default("claude-sonnet-5-5"),
  /**
   * How much the model thinks before each step: "high" (default) thinks the job through, for the
   * best quality on multi-step work in 1C; "low" answers and works fastest.
   */
  AI_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  /**
   * "on" (default): the plans' limits apply: companies, users, PCs, imports, audits, AI questions
   * and the daily AI cap. "off": none is enforced and the assistant's request ceiling is high; use
   * is still counted and shown in the admin dashboard.
   * Blocked accounts, inactive subscriptions and the sign-in rate limit apply either way.
   */
  PLAN_LIMITS: z.enum(["on", "off"]).default("on"),
  /**
   * Effort for questions that come with files to enter into 1C ("import"): careful transcription
   * needs less thinking, and the thinking is most of the wait. The account's own effort still wins
   * when it is lower. Use the same as AI_EFFORT to turn this off.
   */
  AI_IMPORT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  /** Per-account daily cap (input + output + cache tokens), on top of the plan's quota. */
  AI_DAILY_TOKENS: z.coerce.number().int().positive().default(1_000_000),
  /**
   * The first admin (owner) of the admin dashboard. On start the API creates it, or sets this
   * password when it changed, so the password can be reset by changing the secret.
   */
  ADMIN_EMAIL: z
    .string()
    .optional()
    .transform((v) => v?.trim().toLowerCase() || undefined),
  ADMIN_PASSWORD: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  ADMIN_TOKEN_HOURS: z.coerce.number().positive().default(12),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid configuration:\n  ${problems}`);
  }
  // .env files often hold the PEM with literal "\n"
  return { ...parsed.data, LICENSE_PRIVATE_KEY: parsed.data.LICENSE_PRIVATE_KEY.replaceAll("\\n", "\n") };
}
