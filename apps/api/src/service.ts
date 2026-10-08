/**
 * Accounts, sign-in, devices and licenses. Routes stay thin; the rules live here.
 */
import { hash, verify } from "@node-rs/argon2";
import type {
  DeviceView,
  LicenseResponse,
  Me,
  RegisterInput,
  SubscriptionStatus,
  TokenPair,
} from "@platform/shared";
import { and, count, desc, eq, gt, isNull } from "drizzle-orm";

import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { accounts, devices, licenses, plans, refreshTokens, subscriptions, users } from "./db/schema.js";
import { HttpError } from "./lib/errors.js";
import { type Tokens, newRefreshToken, sha256 } from "./lib/tokens.js";

const DAY = 86_400_000;
/** No payment by the end date -> 3-day grace -> suspended (TD §8 "Billing logic"). */
const GRACE_DAYS = 3;
// A real hash to compare against when the email is unknown, so timing does not reveal accounts.
const DUMMY_HASH = await hash("not-a-real-password-for-timing");

export function effectiveStatus(
  status: SubscriptionStatus,
  endsAt: Date,
  now = new Date(),
): SubscriptionStatus {
  if (status === "suspended" || status === "cancelled") return status;
  if (now.getTime() <= endsAt.getTime()) return status;
  return now.getTime() <= endsAt.getTime() + GRACE_DAYS * DAY ? "grace" : "suspended";
}

export class Service {
  constructor(
    private readonly db: Db,
    private readonly tokens: Tokens,
    private readonly config: Config,
  ) {}

  // --- auth -----------------------------------------------------------------------------------

  async register(input: RegisterInput): Promise<TokenPair & { me: Me }> {
    if (!this.config.ALLOW_REGISTRATION)
      throw new HttpError(403, "REGISTRATION_CLOSED", "Sign-up is on the website");
    const existing = await this.db.query.users.findFirst({ where: eq(users.email, input.email) });
    if (existing) throw new HttpError(409, "EMAIL_TAKEN", "An account with this email already exists");
    const trial = await this.db.query.plans.findFirst({ where: eq(plans.code, "trial") });
    if (!trial) throw new HttpError(500, "NO_TRIAL_PLAN", "The trial plan is missing");

    const passwordHash = await hash(input.password);
    const userId = await this.db.transaction(async (tx) => {
      const [account] = await tx.insert(accounts).values({ name: input.accountName }).returning();
      if (!account) throw new HttpError(500, "INTERNAL", "Account was not created");
      const [user] = await tx
        .insert(users)
        .values({ accountId: account.id, email: input.email, name: input.name, passwordHash, role: "owner" })
        .returning();
      if (!user) throw new HttpError(500, "INTERNAL", "User was not created");
      const now = new Date();
      await tx.insert(subscriptions).values({
        accountId: account.id,
        planId: trial.id,
        status: "trial",
        startsAt: now,
        endsAt: new Date(now.getTime() + this.config.TRIAL_DAYS * DAY),
      });
      return user.id;
    });
    return { ...(await this.issueTokens(userId)), me: await this.me(userId) };
  }

  async login(email: string, password: string): Promise<TokenPair & { me: Me }> {
    const user = await this.db.query.users.findFirst({ where: eq(users.email, email) });
    const ok = await verify(user?.passwordHash ?? DUMMY_HASH, password).catch(() => false);
    if (!user || !ok) throw new HttpError(401, "INVALID_CREDENTIALS", "Wrong email or password");
    const account = await this.db.query.accounts.findFirst({ where: eq(accounts.id, user.accountId) });
    if (account?.status === "blocked") throw new HttpError(403, "ACCOUNT_BLOCKED", "This account is blocked");
    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    return { ...(await this.issueTokens(user.id)), me: await this.me(user.id) };
  }

  /** Rotates the refresh token: the old one stops working. */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const row = await this.db.query.refreshTokens.findFirst({
      where: and(
        eq(refreshTokens.tokenHash, sha256(refreshToken)),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, new Date()),
      ),
    });
    if (!row) throw new HttpError(401, "INVALID_REFRESH", "Sign in again");
    await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));
    return this.issueTokens(row.userId);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.tokenHash, sha256(refreshToken)));
  }

  private async issueTokens(userId: string): Promise<TokenPair> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new HttpError(401, "INVALID_REFRESH", "Sign in again");
    const refreshToken = newRefreshToken();
    await this.db.insert(refreshTokens).values({
      userId,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + this.config.REFRESH_TOKEN_DAYS * DAY),
    });
    const access = await this.tokens.accessToken(userId, user.accountId);
    return { accessToken: access.token, expiresIn: access.expiresIn, refreshToken };
  }

  // --- account ----------------------------------------------------------------------------------

  async me(userId: string): Promise<Me> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new HttpError(401, "UNAUTHORIZED", "Sign in again");
    const account = await this.db.query.accounts.findFirst({ where: eq(accounts.id, user.accountId) });
    if (!account) throw new HttpError(401, "UNAUTHORIZED", "Sign in again");
    const { subscription, plan } = await this.currentSubscription(user.accountId);
    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      account: { id: account.id, name: account.name },
      subscription: {
        plan: plan.code,
        status: effectiveStatus(subscription.status, subscription.endsAt),
        endsAt: subscription.endsAt.toISOString(),
      },
    };
  }

  async isBlocked(accountId: string): Promise<boolean> {
    const account = await this.db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
    return account?.status === "blocked";
  }

  async currentSubscription(accountId: string) {
    const [row] = await this.db
      .select({ subscription: subscriptions, plan: plans })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(eq(subscriptions.accountId, accountId))
      .orderBy(desc(subscriptions.endsAt))
      .limit(1);
    if (!row) throw new HttpError(402, "NO_SUBSCRIPTION", "The account has no subscription");
    return row;
  }

  // --- devices and licenses -----------------------------------------------------------------------

  /** Activates this PC for the user (within the plan's device limit) and issues a license token. */
  async activateDevice(userId: string, machineId: string, name: string): Promise<LicenseResponse> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new HttpError(401, "UNAUTHORIZED", "Sign in again");
    const { plan } = await this.currentSubscription(user.accountId);
    let device = await this.db.query.devices.findFirst({
      where: and(eq(devices.userId, userId), eq(devices.machineId, machineId)),
    });
    if (device?.revoked) throw new HttpError(403, "DEVICE_REVOKED", "This PC was removed from the account");
    if (!device) {
      const [{ value: active } = { value: 0 }] = await this.db
        .select({ value: count() })
        .from(devices)
        .where(and(eq(devices.userId, userId), eq(devices.revoked, false)));
      const limit = plan.seats * (plan.features.maxDevicesPerSeat ?? 2);
      if (this.config.PLAN_LIMITS === "on" && active >= limit) {
        throw new HttpError(
          409,
          "DEVICE_LIMIT",
          `The plan allows ${limit} PCs; remove one in the cabinet first`,
        );
      }
      [device] = await this.db.insert(devices).values({ userId, machineId, name }).returning();
      if (!device) throw new HttpError(500, "INTERNAL", "Device was not saved");
    }
    return this.issueLicense(user.id, user.accountId, device.id, machineId);
  }

  async listDevices(userId: string): Promise<DeviceView[]> {
    const rows = await this.db.query.devices.findMany({
      where: eq(devices.userId, userId),
      orderBy: desc(devices.lastSeenAt),
    });
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      activatedAt: d.activatedAt.toISOString(),
      lastSeenAt: d.lastSeenAt.toISOString(),
      revoked: d.revoked,
    }));
  }

  /** Frees a seat: that PC stops getting licenses and must not sign in again (TD §4). */
  async revokeDevice(userId: string, deviceId: string): Promise<void> {
    const [row] = await this.db
      .update(devices)
      .set({ revoked: true })
      .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
      .returning({ id: devices.id });
    if (!row) throw new HttpError(404, "NOT_FOUND", "No such PC on this account");
  }

  /** The desktop's periodic check (every 6 hours): a fresh token, or the reason it cannot have one. */
  async checkLicense(userId: string, machineId: string): Promise<LicenseResponse> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new HttpError(401, "UNAUTHORIZED", "Sign in again");
    const device = await this.db.query.devices.findFirst({
      where: and(eq(devices.userId, userId), eq(devices.machineId, machineId)),
    });
    if (!device) throw new HttpError(404, "DEVICE_NOT_ACTIVATED", "Activate this PC first");
    if (device.revoked) throw new HttpError(403, "DEVICE_REVOKED", "This PC was removed from the account");
    return this.issueLicense(user.id, user.accountId, device.id, machineId);
  }

  private async issueLicense(
    userId: string,
    accountId: string,
    deviceId: string,
    machineId: string,
  ): Promise<LicenseResponse> {
    if (await this.isBlocked(accountId))
      throw new HttpError(403, "ACCOUNT_BLOCKED", "This account is blocked");
    const { subscription, plan } = await this.currentSubscription(accountId);
    const status = effectiveStatus(subscription.status, subscription.endsAt);
    const { token, claims } = await this.tokens.license({
      sub: userId,
      acc: accountId,
      dev: deviceId,
      mid: machineId,
      plan: plan.code,
      status,
      paidUntil: subscription.endsAt.toISOString(),
      maxCompanies: plan.maxCompanies,
    });
    await this.db.insert(licenses).values({
      subscriptionId: subscription.id,
      deviceId,
      tokenJti: claims.jti,
      expiresAt: new Date(claims.exp * 1000),
    });
    await this.db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, deviceId));
    return { licenseToken: token, claims };
  }
}
