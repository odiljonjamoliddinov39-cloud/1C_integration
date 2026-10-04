/**
 * Contract between the desktop app and the control system (TD §8): accounts, sign-in, device
 * activation and signed license tokens. The control system never receives accounting data.
 */
import { z } from "zod";

export const Email = z.email().transform((e) => e.trim().toLowerCase());
export const Password = z.string().min(10, "at least 10 characters").max(200);

export const RegisterInput = z.object({
  email: Email,
  password: Password,
  name: z.string().trim().min(1).max(120),
  /** Firm or company name shown on invoices from us. */
  accountName: z.string().trim().min(1).max(200),
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const LoginInput = z.object({ email: Email, password: z.string().min(1).max(200) });
export type LoginInput = z.infer<typeof LoginInput>;

export const RefreshInput = z.object({ refreshToken: z.string().min(20) });

export const TokenPair = z.object({
  accessToken: z.string(),
  /** Seconds until the access token expires. */
  expiresIn: z.number(),
  refreshToken: z.string(),
});
export type TokenPair = z.infer<typeof TokenPair>;

export const SubscriptionStatus = z.enum(["trial", "active", "grace", "suspended", "cancelled"]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

export const Me = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string(), role: z.enum(["owner", "member"]) }),
  account: z.object({ id: z.string(), name: z.string() }),
  subscription: z.object({
    plan: z.string(),
    status: SubscriptionStatus,
    endsAt: z.string(),
  }),
});
export type Me = z.infer<typeof Me>;

export const ActivateDeviceInput = z.object({
  /** sha256 of the PC's machine id; the raw id never leaves the PC. */
  machineId: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().trim().min(1).max(120),
});
export type ActivateDeviceInput = z.infer<typeof ActivateDeviceInput>;

export const LicenseCheckInput = ActivateDeviceInput.pick({ machineId: true });

/** A PC activated for the user, as the customer cabinet shows it. */
export const DeviceView = z.object({
  id: z.string(),
  name: z.string(),
  activatedAt: z.string(),
  lastSeenAt: z.string(),
  revoked: z.boolean(),
});
export type DeviceView = z.infer<typeof DeviceView>;

/** Claims of the Ed25519-signed license token (TD §4 "Licensing behavior", §11 "Pirated copies"). */
export const LicenseClaims = z.object({
  sub: z.string(), // user id
  acc: z.string(), // account id
  dev: z.string(), // device id
  mid: z.string(), // machine id hash
  plan: z.string(),
  status: SubscriptionStatus,
  /** End of the paid or trial period (ISO). */
  paidUntil: z.string(),
  maxCompanies: z.number(),
  jti: z.string(),
  iat: z.number(),
  /** The token itself is the offline grace: valid 7 days from issue. */
  exp: z.number(),
});
export type LicenseClaims = z.infer<typeof LicenseClaims>;

export const LicenseResponse = z.object({ licenseToken: z.string(), claims: LicenseClaims });
export type LicenseResponse = z.infer<typeof LicenseResponse>;

export const ApiErrorBody = z.object({ code: z.string(), message: z.string() });
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

/** How often the desktop re-checks its license, and how long it works offline (TD §4). */
export const LICENSE_CHECK_HOURS = 6;
export const LICENSE_OFFLINE_DAYS = 7;
