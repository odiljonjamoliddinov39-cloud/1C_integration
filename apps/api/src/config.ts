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
