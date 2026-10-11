/** Billing from the admin dashboard: plans and add-ons, subscriptions, revenue and promo codes. */
import type {
  AddonSaveInput,
  AdminBillingDetail,
  AdminPlansView,
  AdminSubscriptionRow,
  PlanSaveInput,
  PromoInput,
  PromoView,
  RevenueReport,
  SubscriptionActionInput,
} from "@platform/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import type { AdminIdentity } from "../admin/service.js";
import type { Db } from "../db/client.js";
import {
  addons,
  adminAudit,
  billingEvents,
  invoices,
  plans,
  promoCodes,
  subscriptionAddons,
  subscriptions,
} from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import type { Billing } from "./entitlements.js";
import { type Invoicing, invoiceView } from "./invoicing.js";
import { addDays, periodEndOf } from "./period.js";
import { planView } from "./service.js";

export class AdminBilling {
  constructor(
    private readonly db: Db,
    private readonly billing: Billing,
    private readonly invoicing: Invoicing,
  ) {}

  private audit(admin: AdminIdentity, action: string, target: string, payload: Record<string, unknown>) {
    return this.db.insert(adminAudit).values({ adminId: admin.id, action, target, payload });
  }

  // --- plans and add-ons -------------------------------------------------------------------------

  async plansView(): Promise<AdminPlansView> {
    const planRows = await this.db.select().from(plans).orderBy(asc(plans.sortOrder), asc(plans.priceUzs));
    const addonRows = await this.db.select().from(addons).orderBy(asc(addons.priceSum));
    return {
      plans: planRows.map(planView),
      addons: addonRows.map((a) => ({
        code: a.code,
        name: a.name,
        priceSum: a.priceSum,
        kind: a.kind,
        allowedPlans: a.allowedPlans,
        grants: a.grants,
        isPublic: a.isPublic,
      })),
    };
  }

  /** Prices live in the table: a change is the next period's price for existing customers. */
  async savePlan(admin: AdminIdentity, code: string, input: PlanSaveInput): Promise<AdminPlansView> {
    if (!/^[a-z0-9_]{2,40}$/.test(code))
      throw new HttpError(400, "VALIDATION", "Plan code: lowercase letters, digits, _");
    const values = {
      name: input.name,
      priceUzs: input.priceMonthSum,
      priceYearSum: input.priceYearSum,
      maxCompanies: input.companies,
      seats: input.users,
      importsPerMonth: input.importsPerMonth,
      auditsPerMonth: input.auditsPerMonth,
      aiQuestionsPerMonth: input.aiQuestionsPerMonth,
      isPublic: input.isPublic,
      sortOrder: input.sortOrder,
    };
    const existing = await this.db.query.plans.findFirst({ where: eq(plans.code, code) });
    // Keep what the editor does not show (devices per seat) and replace what it does.
    const features = { ...(existing?.features ?? { maxDevicesPerSeat: 2 }), ...input.features };
    if (existing)
      await this.db
        .update(plans)
        .set({ ...values, features })
        .where(eq(plans.id, existing.id));
    else await this.db.insert(plans).values({ code, ...values, features, periodDays: 30 });
    await this.audit(admin, existing ? "plan.update" : "plan.create", `plan:${code}`, { ...input });
    this.billing.invalidate();
    return this.plansView();
  }

  async saveAddon(admin: AdminIdentity, code: string, input: AddonSaveInput): Promise<AdminPlansView> {
    if (!/^[a-z0-9_]{2,40}$/.test(code))
      throw new HttpError(400, "VALIDATION", "Add-on code: lowercase letters, digits, _");
    await this.db
      .insert(addons)
      .values({ code, ...input })
      .onConflictDoUpdate({ target: addons.code, set: { ...input } });
    await this.audit(admin, "addon.save", `addon:${code}`, { ...input });
    this.billing.invalidate();
    return this.plansView();
  }

  // --- subscriptions -----------------------------------------------------------------------------

  private async rows(like: string | null, accountId: string | null): Promise<AdminSubscriptionRow[]> {
    const rows = await this.db.execute<{
      account_id: string;
      subscription_id: string;
      account_name: string;
      owner_email: string | null;
      plan: string;
      status: string;
      billing_cycle: string;
      ends_at: Date;
      auto_renew: boolean;
      cancel_at_period_end: boolean;
      pending_plan: string | null;
      trial_used: boolean;
      promo_code: string | null;
      paid_invoices: number;
      pending_invoices: number;
    }>(sql`
      select a.id as account_id, s.id as subscription_id, a.name as account_name,
        (select u.email from users u where u.account_id = a.id order by u.created_at limit 1) as owner_email,
        p.code as plan, s.status, s.billing_cycle, s.ends_at, s.auto_renew, s.cancel_at_period_end,
        pp.code as pending_plan, s.trial_used, s.promo_code,
        (select count(*)::int from invoices i where i.account_id = a.id and i.status = 'paid') as paid_invoices,
        (select count(*)::int from invoices i where i.account_id = a.id and i.status = 'pending') as pending_invoices
      from accounts a
      join subscriptions s on s.account_id = a.id
      join plans p on p.id = s.plan_id
      left join plans pp on pp.id = s.pending_plan_id
      where (${accountId}::uuid is null or a.id = ${accountId}::uuid)
        and (${like}::text is null or a.name ilike ${like}
          or exists (select 1 from users u where u.account_id = a.id and u.email ilike ${like}))
      order by a.created_at desc
      limit 500`);
    return rows.map((r) => ({
      accountId: r.account_id,
      subscriptionId: r.subscription_id,
      accountName: r.account_name,
      ownerEmail: r.owner_email ?? "",
      plan: r.plan,
      status: r.status,
      billingCycle: r.billing_cycle,
      periodEnd: r.status === "free" ? null : new Date(r.ends_at).toISOString(),
      autoRenew: r.auto_renew,
      cancelAtPeriodEnd: r.cancel_at_period_end,
      pendingPlan: r.pending_plan,
      trialUsed: r.trial_used,
      promoCode: r.promo_code,
      paidInvoices: r.paid_invoices,
      pendingInvoices: r.pending_invoices,
    }));
  }

  async subscriptionList(query: {
    q?: string;
    plan?: string;
    status?: string;
  }): Promise<AdminSubscriptionRow[]> {
    const all = await this.rows(query.q ? `%${query.q}%` : null, null);
    return all.filter(
      (r) => (!query.plan || r.plan === query.plan) && (!query.status || r.status === query.status),
    );
  }

  async detail(accountId: string): Promise<AdminBillingDetail> {
    const [subscription] = await this.rows(null, accountId);
    if (!subscription) throw new HttpError(404, "NOT_FOUND", "No such account");
    const bought = await this.db
      .select()
      .from(subscriptionAddons)
      .where(eq(subscriptionAddons.subscriptionId, subscription.subscriptionId))
      .orderBy(desc(subscriptionAddons.validFrom));
    const invoiceRows = await this.db.query.invoices.findMany({
      where: eq(invoices.accountId, accountId),
      orderBy: desc(invoices.createdAt),
      limit: 100,
    });
    const eventRows = await this.db.query.billingEvents.findMany({
      where: eq(billingEvents.accountId, accountId),
      orderBy: desc(billingEvents.createdAt),
      limit: 200,
    });
    return {
      subscription,
      addons: bought.map((a) => ({
        code: a.addonCode,
        quantity: a.quantity,
        validFrom: a.validFrom.toISOString(),
        validTo: a.validTo.toISOString(),
      })),
      invoices: invoiceRows.map(invoiceView),
      events: eventRows.map((e) => ({
        id: e.id,
        type: e.type,
        payload: e.payload,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  /** Subscription actions by id (the subscription row's id). */
  async act(
    admin: AdminIdentity,
    subscriptionId: string,
    input: SubscriptionActionInput,
  ): Promise<AdminBillingDetail> {
    const sub = await this.db.query.subscriptions.findFirst({ where: eq(subscriptions.id, subscriptionId) });
    if (!sub) throw new HttpError(404, "NOT_FOUND", "No such subscription");
    const accountId = sub.accountId;
    const now = new Date();
    const did: string[] = [];

    if (input.markPaidInvoiceId) {
      const invoice = await this.db.query.invoices.findFirst({
        where: and(eq(invoices.id, input.markPaidInvoiceId), eq(invoices.accountId, accountId)),
      });
      if (!invoice) throw new HttpError(404, "NOT_FOUND", "No such invoice on this account");
      await this.invoicing.applyInvoice(invoice.id, now, { provider: "bank", ref: `admin:${admin.id}` });
      did.push("mark_paid");
    }

    if (input.plan) {
      const plan = await this.db.query.plans.findFirst({ where: eq(plans.code, input.plan) });
      if (!plan) throw new HttpError(404, "NOT_FOUND", "No such plan");
      const cycle = input.cycle ?? sub.billingCycle;
      if (plan.code === "free") {
        await this.db
          .update(subscriptions)
          .set({
            planId: plan.id,
            status: "free",
            startsAt: now,
            endsAt: new Date("2999-01-01T00:00:00Z"),
            pendingPlanId: null,
            cancelAtPeriodEnd: false,
          })
          .where(eq(subscriptions.id, sub.id));
      } else {
        // A comp or a manual sale: the plan starts now for one period (or the days given).
        const end = input.days ? addDays(now, input.days) : periodEndOf(now, cycle);
        await this.db
          .update(subscriptions)
          .set({
            planId: plan.id,
            status: "active",
            billingCycle: cycle,
            startsAt: now,
            endsAt: end,
            autoRenew: true,
            cancelAtPeriodEnd: false,
            pendingPlanId: null,
            remindersSent: [],
          })
          .where(eq(subscriptions.id, sub.id));
      }
      await this.invoicing.event(accountId, "plan_set_by_admin", {
        plan: plan.code,
        by: admin.id,
        reason: input.reason,
      });
      did.push("plan");
    } else if (input.days) {
      const current = await this.db.query.subscriptions.findFirst({ where: eq(subscriptions.id, sub.id) });
      if (!current || current.status === "free") {
        throw new HttpError(
          409,
          "FREE_HAS_NO_PERIOD",
          "A Free account has no period to extend: put it on a plan first",
        );
      }
      const from = Math.max(now.getTime(), current.endsAt.getTime());
      await this.db
        .update(subscriptions)
        .set({
          endsAt: addDays(new Date(from), input.days),
          status:
            current.status === "grace" || current.status === "suspended" || current.status === "cancelled"
              ? "active"
              : current.status,
        })
        .where(eq(subscriptions.id, sub.id));
      await this.invoicing.event(accountId, "extended_by_admin", {
        days: input.days,
        by: admin.id,
        reason: input.reason,
      });
      did.push("extend");
    }

    if (input.addon) {
      const addon = await this.db.query.addons.findFirst({ where: eq(addons.code, input.addon) });
      if (!addon) throw new HttpError(404, "NOT_FOUND", "No such add-on");
      const current = await this.db.query.subscriptions.findFirst({ where: eq(subscriptions.id, sub.id) });
      const validTo = current && current.status !== "free" ? current.endsAt : addDays(now, 30);
      await this.db.insert(subscriptionAddons).values({
        subscriptionId: sub.id,
        addonCode: addon.code,
        quantity: input.quantity,
        validFrom: now,
        validTo,
      });
      await this.invoicing.event(accountId, "addon_granted_by_admin", {
        addon: addon.code,
        quantity: input.quantity,
        by: admin.id,
        reason: input.reason,
      });
      did.push("addon");
    }

    if (did.length === 0)
      throw new HttpError(400, "VALIDATION", "Nothing to do: choose a plan, days, an invoice or an add-on");
    await this.audit(admin, `subscription.${did.join("+")}`, `account:${accountId}`, { ...input });
    this.billing.invalidate(accountId);
    return this.detail(accountId);
  }

  // --- revenue -----------------------------------------------------------------------------------

  async revenue(now = new Date()): Promise<RevenueReport> {
    const subs = await this.db.execute<{
      plan: string;
      status: string;
      billing_cycle: string;
      ends_at: Date;
      month_price: number;
      year_price: number;
      addons_mrr: number;
    }>(sql`
      select p.code as plan, s.status, s.billing_cycle, s.ends_at, p.price_uzs::float8 as month_price,
        p.price_year_sum::float8 as year_price,
        coalesce((select sum(ad.price_sum * sa.quantity) from subscription_addons sa
          join addons ad on ad.code = sa.addon_code
          where sa.subscription_id = s.id and ad.kind = 'recurring' and sa.valid_to >= ${now.toISOString()}::timestamptz), 0)::float8 as addons_mrr
      from subscriptions s join plans p on p.id = s.plan_id`);
    const byPlan = new Map<string, { accounts: number; mrrSum: number }>();
    let free = 0;
    let trial = 0;
    let paid = 0;
    let mrr = 0;
    for (const s of subs) {
      const ended = new Date(s.ends_at).getTime() < now.getTime();
      const status = s.status;
      if (
        status === "free" ||
        (status === "trial" && ended) ||
        status === "suspended" ||
        status === "cancelled"
      ) {
        free++;
        continue;
      }
      if (status === "trial") {
        trial++;
        continue;
      }
      paid++;
      const monthly = (s.billing_cycle === "year" ? s.year_price / 12 : s.month_price) + s.addons_mrr;
      mrr += monthly;
      const row = byPlan.get(s.plan) ?? { accounts: 0, mrrSum: 0 };
      row.accounts += 1;
      row.mrrSum += monthly;
      byPlan.set(s.plan, row);
    }
    const accounts = subs.length;
    const [everPaid] = await this.db.execute<{ n: number }>(
      sql`select count(distinct account_id)::int as n from invoices where status = 'paid'`,
    );
    const [collected] = await this.db.execute<{ sum: number }>(sql`
      select coalesce(sum(total_sum), 0)::float8 as sum from invoices
      where status = 'paid' and paid_at >= ${addDays(now, -30).toISOString()}::timestamptz`);
    const overdueRows = await this.db.execute<{
      number: number;
      account_name: string;
      total_sum: number;
      due_at: Date;
    }>(sql`
      select i.number, a.name as account_name, i.total_sum::float8 as total_sum, i.due_at
      from invoices i join accounts a on a.id = i.account_id
      where i.status in ('pending', 'expired') and i.due_at < ${now.toISOString()}::timestamptz
      order by i.due_at limit 100`);
    return {
      mrrSum: Math.round(mrr),
      byPlan: [...byPlan.entries()].map(([plan, v]) => ({
        plan,
        accounts: v.accounts,
        mrrSum: Math.round(v.mrrSum),
      })),
      accounts,
      freeAccounts: free,
      trialAccounts: trial,
      paidAccounts: paid,
      conversionPercent: accounts === 0 ? 0 : Math.round(((everPaid?.n ?? 0) / accounts) * 1000) / 10,
      collected30dSum: Math.round(collected?.sum ?? 0),
      overdue: {
        count: overdueRows.length,
        totalSum: overdueRows.reduce((sum, r) => sum + r.total_sum, 0),
        items: overdueRows.map((r) => ({
          number: `INV-${String(r.number).padStart(6, "0")}`,
          accountName: r.account_name,
          totalSum: r.total_sum,
          dueAt: new Date(r.due_at).toISOString(),
        })),
      },
    };
  }

  // --- promo codes -------------------------------------------------------------------------------

  private promoView(row: typeof promoCodes.$inferSelect): PromoView {
    return {
      code: row.code,
      kind: row.kind,
      value: row.value,
      allowedPlans: row.allowedPlans,
      validFrom: row.validFrom?.toISOString() ?? null,
      validTo: row.validTo?.toISOString() ?? null,
      maxUses: row.maxUses,
      usedCount: row.usedCount,
      months: row.months,
      disabled: row.disabled,
    };
  }

  async promos(): Promise<PromoView[]> {
    const rows = await this.db.select().from(promoCodes).orderBy(desc(promoCodes.code));
    return rows.map((r) => this.promoView(r));
  }

  async createPromo(admin: AdminIdentity, input: PromoInput): Promise<PromoView[]> {
    if (input.kind === "percent" && input.value > 100)
      throw new HttpError(400, "VALIDATION", "A percent is at most 100");
    const taken = await this.db.query.promoCodes.findFirst({ where: eq(promoCodes.code, input.code) });
    if (taken) throw new HttpError(409, "PROMO_EXISTS", "This code already exists");
    await this.db.insert(promoCodes).values({
      ...input,
      validFrom: input.validFrom ? new Date(input.validFrom) : null,
      validTo: input.validTo ? new Date(input.validTo) : null,
    });
    await this.audit(admin, "promo.create", `promo:${input.code}`, { ...input });
    return this.promos();
  }

  async setPromoDisabled(admin: AdminIdentity, code: string, disabled: boolean): Promise<PromoView[]> {
    const [row] = await this.db
      .update(promoCodes)
      .set({ disabled })
      .where(eq(promoCodes.code, code))
      .returning();
    if (!row) throw new HttpError(404, "NOT_FOUND", "No such promo code");
    await this.audit(admin, disabled ? "promo.disable" : "promo.enable", `promo:${code}`, {});
    return this.promos();
  }
}
