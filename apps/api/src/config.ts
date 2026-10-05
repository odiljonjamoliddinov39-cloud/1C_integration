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
  TRIAL_DAYS: z.coerce.number().default(14),
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
