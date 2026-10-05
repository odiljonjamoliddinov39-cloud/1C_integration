/**
 * The admin dashboard's side of the control system (TD §8 "Admin API", "Admin dashboard"): our staff
 * look up customers, extend licenses and manage their PCs. Every change is written to admin_audit.
 * Roles: owner can do everything; support cannot block accounts or manage admins.
 */
import { hash, verify } from "@node-rs/argon2";
import type {
  AccountDetail,
  AccountRow,
  AccountsQuery,
  AdminRole,
  AdminSession,
  AdminView,
  AuditEntry,
  CreateAdminInput,
  ExtendInput,
  Overview,
  RechargeInput,
  SubscriptionStatus,
  UsageDay,
  UsageRow,
} from "@platform/shared";
import { desc, eq, sql } from "drizzle-orm";

import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { accounts, adminAudit, admins, aiGrants, devices, subscriptions, users } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import type { Tokens } from "../lib/tokens.js";
import { aiLimits } from "../ai/quota.js";
import { effectiveStatus } from "../service.js";

const DAY = 86_400_000;
const DUMMY_HASH = await hash("not-a-real-admin-password-for-timing");

export interface AdminIdentity {
  id: string;
  role: AdminRole;
}

type Admin = typeof admins.$inferSelect;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

function adminView(a: Admin): AdminView {
  return {
    id: a.id,
    email: a.email,
    name: a.name,
    role: a.role,
    disabled: a.disabled,
    lastLoginAt: iso(a.lastLoginAt),
  };
}

export class AdminService {
  constructor(
    private readonly db: Db,
    private readonly tokens: Tokens,
    private readonly config: Config,
  ) {}

  /** Creates the first owner from ADMIN_EMAIL / ADMIN_PASSWORD, or resets its password to them. */
  async bootstrap(log: { info: (msg: string) => void }): Promise<void> {
    const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = this.config;
    if (!email || !password) return;
    const existing = await this.db.query.admins.findFirst({ where: eq(admins.email, email) });
    if (!existing) {
      await this.db
        .insert(admins)
        .values({ email, name: "Owner", passwordHash: await hash(password), role: "owner" });
      log.info(`Admin ${email} created`);
    } else if (!(await verify(existing.passwordHash, password).catch(() => false)) || existing.disabled) {
      await this.db
        .update(admins)
        .set({ passwordHash: await hash(password), disabled: false })
        .where(eq(admins.id, existing.id));
      log.info(`Admin ${email}: password set from ADMIN_PASSWORD`);
    }
  }

  // --- sign-in --------------------------------------------------------------------------------

  async login(email: string, password: string): Promise<AdminSession> {
    const admin = await this.db.query.admins.findFirst({ where: eq(admins.email, email) });
    const ok = await verify(admin?.passwordHash ?? DUMMY_HASH, password).catch(() => false);
    if (!admin || !ok) throw new HttpError(401, "INVALID_CREDENTIALS", "Wrong email or password");
    if (admin.disabled) throw new HttpError(403, "ADMIN_DISABLED", "This admin is disabled");
    const [updated] = await this.db
      .update(admins)
      .set({ lastLoginAt: new Date() })
      .where(eq(admins.id, admin.id))
      .returning();
    await this.audit(admin.id, "admin.login", `admin:${admin.id}`);
    const { token, expiresIn } = await this.tokens.adminToken(admin.id);
    return { accessToken: token, expiresIn, admin: adminView(updated ?? admin) };
  }

  /** The admin behind a token; disabled admins are signed out at once. */
  async identify(token: string): Promise<AdminIdentity | null> {
    const id = await this.tokens.verifyAdmin(token);
    if (!id) return null;
    const admin = await this.db.query.admins.findFirst({ where: eq(admins.id, id) });
    return admin && !admin.disabled ? { id: admin.id, role: admin.role } : null;
  }

  async me(id: string): Promise<AdminView> {
    const admin = await this.db.query.admins.findFirst({ where: eq(admins.id, id) });
    if (!admin) throw new HttpError(401, "UNAUTHORIZED", "Sign in again");
    return adminView(admin);
  }

  // --- customers ------------------------------------------------------------------------------

  async listAccounts(query: AccountsQuery): Promise<AccountRow[]> {
    const rows = await this.accountRows(query.q ? `%${query.q}%` : null, null);
    return query.status ? rows.filter((r) => r.status === query.status) : rows;
  }

  async account(id: string): Promise<AccountDetail> {
    const [account] = await this.accountRows(null, id);
    if (!account) throw new HttpError(404, "NOT_FOUND", "No such account");

    const userRows = await this.db.query.users.findMany({
      where: eq(users.accountId, id),
      orderBy: users.createdAt,
    });
    const subs = await this.db.execute<{
      id: string;
      plan: string;
      status: SubscriptionStatus;
      starts_at: Date;
      ends_at: Date;
      ai_token_quota: number;
    }>(sql`
      select s.id, p.code as plan, s.status, s.starts_at, s.ends_at, p.ai_token_quota
      from subscriptions s join plans p on p.id = s.plan_id
      where s.account_id = ${id} order by s.ends_at desc`);
    const deviceRows = await this.db.execute<{
      id: string;
      name: string;
      email: string;
      activated_at: Date;
      last_seen_at: Date;
      revoked: boolean;
    }>(sql`
      select d.id, d.name, u.email, d.activated_at, d.last_seen_at, d.revoked
      from devices d join users u on u.id = d.user_id
      where u.account_id = ${id} order by d.revoked, d.last_seen_at desc`);
    const companyRows = await this.db.execute<{ inn: string; name: string; connected_at: Date }>(sql`
      select inn, name, connected_at from companies where account_id = ${id} order by connected_at`);

    const current = subs[0];
    const limits = await aiLimits(
      this.db,
      id,
      { startsAt: new Date(current?.starts_at ?? 0), planQuota: Number(current?.ai_token_quota ?? 0) },
      this.config.AI_DAILY_TOKENS,
    );

    return {
      account,
      users: userRows.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        lastLoginAt: iso(u.lastLoginAt),
      })),
      subscriptions: subs.map((s) => ({
        id: s.id,
        plan: s.plan,
        status: effectiveStatus(s.status, new Date(s.ends_at)),
        startsAt: new Date(s.starts_at).toISOString(),
        endsAt: new Date(s.ends_at).toISOString(),
      })),
      devices: deviceRows.map((d) => ({
        id: d.id,
        name: d.name,
        userEmail: d.email,
        activatedAt: new Date(d.activated_at).toISOString(),
        lastSeenAt: new Date(d.last_seen_at).toISOString(),
        revoked: d.revoked,
      })),
      companies: companyRows.map((c) => ({
        inn: c.inn,
        name: c.name,
        connectedAt: new Date(c.connected_at).toISOString(),
      })),
      aiQuota: limits.quota,
      aiUsedTokens: limits.used,
      aiGranted: limits.granted,
      aiDailyLimit: limits.dailyLimit,
      aiUsedToday: limits.usedToday,
      usage: await this.usageByDay(30, id),
      audit: await this.auditEntries(`account:${id}`, 50),
    };
  }

  /**
   * Extends the current subscription by `days` from its end, or from today when it has already
   * ended. A suspended or cancelled subscription becomes active again; a trial stays a trial.
   */
  async extend(admin: AdminIdentity, accountId: string, input: ExtendInput): Promise<AccountDetail> {
    const current = await this.db.query.subscriptions.findFirst({
      where: eq(subscriptions.accountId, accountId),
      orderBy: desc(subscriptions.endsAt),
    });
    if (!current) throw new HttpError(404, "NOT_FOUND", "The account has no subscription");
    const from = Math.max(Date.now(), current.endsAt.getTime());
    const endsAt = new Date(from + input.days * DAY);
    const status =
      current.status === "suspended" || current.status === "cancelled" ? "active" : current.status;
    await this.db.update(subscriptions).set({ endsAt, status }).where(eq(subscriptions.id, current.id));
    await this.audit(admin.id, "license.extend", `account:${accountId}`, {
      days: input.days,
      reason: input.reason,
      from: current.endsAt.toISOString(),
      to: endsAt.toISOString(),
    });
    return this.account(accountId);
  }

  /**
   * Adds AI tokens to an account ("recharge", e.g. after a payment): they raise this period's quota
   * and today's cap, so a customer stopped by either can go on at once.
   */
  async recharge(admin: AdminIdentity, accountId: string, input: RechargeInput): Promise<AccountDetail> {
    const account = await this.db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
    if (!account) throw new HttpError(404, "NOT_FOUND", "No such account");
    await this.db.insert(aiGrants).values({
      accountId,
      tokens: input.tokens,
      adminId: admin.id,
      reason: input.reason,
    });
    await this.audit(admin.id, "ai.recharge", `account:${accountId}`, {
      tokens: input.tokens,
      reason: input.reason,
    });
    return this.account(accountId);
  }

  /** A blocked account cannot sign in, get licenses or use the assistant. Owner only. */
  async setBlocked(admin: AdminIdentity, accountId: string, blocked: boolean): Promise<AccountDetail> {
    requireOwner(admin);
    const [row] = await this.db
      .update(accounts)
      .set({ status: blocked ? "blocked" : "active" })
      .where(eq(accounts.id, accountId))
      .returning({ id: accounts.id });
    if (!row) throw new HttpError(404, "NOT_FOUND", "No such account");
    await this.audit(admin.id, blocked ? "account.block" : "account.unblock", `account:${accountId}`);
    return this.account(accountId);
  }

  /** Removes a PC from the account (frees its seat) or lets it back in. */
  async setDeviceRevoked(admin: AdminIdentity, deviceId: string, revoked: boolean): Promise<AccountDetail> {
    const [device] = await this.db
      .select({ id: devices.id, name: devices.name, accountId: users.accountId })
      .from(devices)
      .innerJoin(users, eq(users.id, devices.userId))
      .where(eq(devices.id, deviceId));
    if (!device) throw new HttpError(404, "NOT_FOUND", "No such PC");
    await this.db.update(devices).set({ revoked }).where(eq(devices.id, deviceId));
    await this.audit(admin.id, revoked ? "device.revoke" : "device.restore", `account:${device.accountId}`, {
      deviceId,
      name: device.name,
    });
    return this.account(device.accountId);
  }

  // --- usage ----------------------------------------------------------------------------------

  async overview(): Promise<Overview> {
    const rows = await this.accountRows(null, null);
    const byStatus: Record<SubscriptionStatus, number> = {
      trial: 0,
      active: 0,
      grace: 0,
      suspended: 0,
      cancelled: 0,
    };
    for (const r of rows) if (r.status) byStatus[r.status] += 1;
    const weekAgo = Date.now() - 7 * DAY;
    const [devicesRow] = await this.db.execute<{ n: number }>(sql`
      select count(*)::int as n from devices where not revoked and last_seen_at > now() - interval '1 day'`);
    const usage = await this.usageByDay(30);
    const today = new Date().toISOString().slice(0, 10);
    return {
      accounts: rows.length,
      newAccounts7d: rows.filter((r) => Date.parse(r.createdAt) > weekAgo).length,
      byStatus,
      activeDevices24h: devicesRow?.n ?? 0,
      ai: {
        requests30d: usage.reduce((s, d) => s + d.requests, 0),
        tokens30d: usage.reduce((s, d) => s + d.tokens, 0),
        costUsd30d: round(usage.reduce((s, d) => s + d.costUsd, 0)),
        costUsdToday: usage.find((d) => d.date === today)?.costUsd ?? 0,
      },
      usage,
    };
  }

  /** AI use per account over the last `days` days, most expensive first. */
  async usage(days: number): Promise<UsageRow[]> {
    const rows = await this.db.execute<{
      account_id: string;
      name: string;
      requests: number;
      tokens: number;
      cost: number;
    }>(sql`
      select a.id as account_id, a.name, count(*)::int as requests,
        sum(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens)::float8 as tokens,
        sum(u.cost_usd)::float8 as cost
      from ai_usage u join accounts a on a.id = u.account_id
      where u.created_at > now() - make_interval(days => ${days})
      group by a.id, a.name order by cost desc`);
    return rows.map((r) => ({
      accountId: r.account_id,
      accountName: r.name,
      requests: r.requests,
      tokens: r.tokens,
      costUsd: round(r.cost),
    }));
  }

  async auditEntries(target?: string, limit = 200): Promise<AuditEntry[]> {
    const rows = await this.db
      .select({ entry: adminAudit, email: admins.email })
      .from(adminAudit)
      .leftJoin(admins, eq(admins.id, adminAudit.adminId))
      .where(target ? eq(adminAudit.target, target) : undefined)
      .orderBy(desc(adminAudit.createdAt))
      .limit(limit);
    return rows.map(({ entry, email }) => ({
      id: entry.id,
      at: entry.createdAt.toISOString(),
      adminEmail: email,
      action: entry.action,
      target: entry.target,
      payload: entry.payload,
    }));
  }

  // --- admins ---------------------------------------------------------------------------------

  async listAdmins(admin: AdminIdentity): Promise<AdminView[]> {
    requireOwner(admin);
    const rows = await this.db.query.admins.findMany({ orderBy: admins.createdAt });
    return rows.map(adminView);
  }

  async createAdmin(admin: AdminIdentity, input: CreateAdminInput): Promise<AdminView> {
    requireOwner(admin);
    const existing = await this.db.query.admins.findFirst({ where: eq(admins.email, input.email) });
    if (existing) throw new HttpError(409, "EMAIL_TAKEN", "An admin with this email already exists");
    const [created] = await this.db
      .insert(admins)
      .values({
        email: input.email,
        name: input.name,
        role: input.role,
        passwordHash: await hash(input.password),
      })
      .returning();
    if (!created) throw new HttpError(500, "INTERNAL", "Admin was not created");
    await this.audit(admin.id, "admin.create", `admin:${created.id}`, {
      email: input.email,
      role: input.role,
    });
    return adminView(created);
  }

  async setAdminDisabled(admin: AdminIdentity, id: string, disabled: boolean): Promise<AdminView> {
    requireOwner(admin);
    if (id === admin.id) throw new HttpError(400, "SELF", "You cannot disable yourself");
    const [row] = await this.db.update(admins).set({ disabled }).where(eq(admins.id, id)).returning();
    if (!row) throw new HttpError(404, "NOT_FOUND", "No such admin");
    await this.audit(admin.id, disabled ? "admin.disable" : "admin.enable", `admin:${id}`, {
      email: row.email,
    });
    return adminView(row);
  }

  // --- helpers --------------------------------------------------------------------------------

  private async audit(
    adminId: string,
    action: string,
    target: string,
    payload: Record<string, unknown> = {},
  ) {
    await this.db.insert(adminAudit).values({ adminId, action, target, payload });
  }

  /** Customers with their current subscription and activity; `like` filters by name or user email. */
  private async accountRows(like: string | null, id: string | null): Promise<AccountRow[]> {
    const rows = await this.db.execute<{
      id: string;
      name: string;
      account_status: "active" | "blocked";
      created_at: Date;
      owner_email: string | null;
      plan: string | null;
      sub_status: SubscriptionStatus | null;
      ends_at: Date | null;
      users: number;
      active_devices: number;
      companies: number;
      last_activity: Date | null;
      ai_cost: number;
    }>(sql`
      select a.id, a.name, a.status as account_status, a.created_at,
        (select u.email from users u where u.account_id = a.id
          order by (u.role = 'owner') desc, u.created_at limit 1) as owner_email,
        p.code as plan, s.status as sub_status, s.ends_at,
        (select count(*) from users u where u.account_id = a.id)::int as users,
        (select count(*) from devices d join users u on u.id = d.user_id
          where u.account_id = a.id and not d.revoked)::int as active_devices,
        (select count(*) from companies c where c.account_id = a.id)::int as companies,
        greatest(
          (select max(u.last_login_at) from users u where u.account_id = a.id),
          (select max(d.last_seen_at) from devices d join users u on u.id = d.user_id where u.account_id = a.id)
        ) as last_activity,
        coalesce((select sum(x.cost_usd) from ai_usage x
          where x.account_id = a.id and x.created_at > now() - interval '30 days'), 0)::float8 as ai_cost
      from accounts a
      left join lateral (
        select * from subscriptions s where s.account_id = a.id order by s.ends_at desc limit 1
      ) s on true
      left join plans p on p.id = s.plan_id
      where (${id}::uuid is null or a.id = ${id}::uuid)
        and (${like}::text is null or a.name ilike ${like}
          or exists (select 1 from users u where u.account_id = a.id and u.email ilike ${like}))
      order by a.created_at desc
      limit 500`);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      ownerEmail: r.owner_email,
      blocked: r.account_status === "blocked",
      plan: r.plan,
      status: r.sub_status && r.ends_at ? effectiveStatus(r.sub_status, new Date(r.ends_at)) : null,
      endsAt: iso(r.ends_at),
      users: r.users,
      activeDevices: r.active_devices,
      companies: r.companies,
      lastActivityAt: iso(r.last_activity),
      aiCostUsd30d: round(r.ai_cost),
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  /** Daily AI use for the last `days` days (every day present, zeros included). */
  private async usageByDay(days: number, accountId?: string): Promise<UsageDay[]> {
    const since = new Date(Date.now() - (days - 1) * DAY);
    since.setUTCHours(0, 0, 0, 0);
    const rows = await this.db.execute<{ day: string; requests: number; tokens: number; cost: number }>(sql`
      select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day, count(*)::int as requests,
        sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)::float8 as tokens,
        sum(cost_usd)::float8 as cost
      from ai_usage
      where created_at >= ${since.toISOString()}::timestamptz and (${accountId ?? null}::uuid is null or account_id = ${accountId ?? null}::uuid)
      group by 1`);
    const byDay = new Map(rows.map((r) => [r.day, r]));
    return Array.from({ length: days }, (_, i) => {
      const date = new Date(since.getTime() + i * DAY).toISOString().slice(0, 10);
      const r = byDay.get(date);
      return { date, requests: r?.requests ?? 0, tokens: r?.tokens ?? 0, costUsd: round(r?.cost ?? 0) };
    });
  }
}

function requireOwner(admin: AdminIdentity): void {
  if (admin.role !== "owner") throw new HttpError(403, "FORBIDDEN", "Only an owner can do this");
}

function round(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}
