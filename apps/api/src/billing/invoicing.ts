/**
 * Prices, invoices and what paying one does. Every payment starts as our own invoice; a provider only
 * confirms it was paid, and applyInvoice then extends the plan or adds the add-on in one transaction.
 */
import {
  type ChangePlanInput,
  type ChangePlanResponse,
  type CheckoutInput,
  type CheckoutResponse,
  type InvoiceView,
  type SubscriptionResponse,
  TRIAL_DAYS,
  yearPriceOf,
} from "@platform/shared";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";

import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import {
  type InvoiceIntent,
  type InvoiceItem,
  addons,
  billingEvents,
  companies,
  invoices,
  plans,
  promoCodes,
  subscriptionAddons,
  subscriptions,
} from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { type Billing, type PlanRow, type Resolved, stateOf } from "./entitlements.js";
import { addDays, daysBetween, periodEndOf, roundUpThousand } from "./period.js";
import { clickCheckout, clickEnabled } from "./click.js";
import { grantPurchase } from "./credits.js";
import { paymeCheckoutUrl } from "./payme.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface Quote {
  items: InvoiceItem[];
  intent: InvoiceIntent;
  subtotalSum: number;
  discountSum: number;
  vatSum: number;
  totalSum: number;
}

const priceFor = (plan: PlanRow, cycle: "month" | "year") =>
  cycle === "year" ? yearPriceOf(plan.priceUzs) : plan.priceUzs;
const months = (cycle: "month" | "year") => (cycle === "year" ? 12 : 1);
const refuse = (status: number, code: string, message: string) => new HttpError(status, code, message);

export const invoiceNumber = (n: number | null) => `INV-${String(n ?? 0).padStart(6, "0")}`;

export function invoiceView(row: typeof invoices.$inferSelect): InvoiceView {
  return {
    id: row.id,
    number: invoiceNumber(row.number),
    items: row.items,
    subtotalSum: row.subtotalSum,
    discountSum: row.discountSum,
    vatSum: row.vatSum,
    totalSum: row.totalSum,
    status: row.status,
    provider: row.provider,
    dueAt: row.dueAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class Invoicing {
  constructor(
    readonly db: Db,
    readonly config: Config,
    readonly billing: Billing,
  ) {}

  /** Payment systems that work now. */
  providers(): string[] {
    return [
      ...(this.config.PAYME_MERCHANT_ID && this.config.PAYME_KEY ? ["payme"] : []),
      ...(clickEnabled(this.config) ? ["click"] : []),
      "bank",
    ];
  }

  async event(
    accountId: string,
    type: string,
    payload: Record<string, unknown> = {},
    tx: Pick<Db, "insert"> = this.db,
  ): Promise<void> {
    await tx.insert(billingEvents).values({ accountId, type, payload });
  }

  // --- quotes -----------------------------------------------------------------------------------

  private totals(items: InvoiceItem[], discountSum: number) {
    const subtotalSum = items.reduce((sum, item) => sum + item.amountSum, 0);
    const taxable = Math.max(0, subtotalSum - discountSum);
    const vatSum = Math.round((taxable * this.config.VAT_PERCENT) / 100);
    return { subtotalSum, discountSum, vatSum, totalSum: taxable + vatSum };
  }

  /**
   * A promo code's discount on a plan's price. Never on add-ons. Throws when the code does not apply:
   * unknown, switched off, outside its dates, used up, or not for this plan.
   */
  async promo(
    code: string,
    planCode: string,
    planAmount: number,
    now = new Date(),
    /** A code already running on the subscription: its redemption window and use limit no longer apply. */
    continuing = false,
  ) {
    const row = await this.db.query.promoCodes.findFirst({ where: eq(promoCodes.code, code.toUpperCase()) });
    const bad = (why: string) => refuse(400, "INVALID_PROMO", `The promo code ${why}`);
    if (!row || row.disabled) throw bad("does not exist");
    if (!continuing && row.validFrom && row.validFrom > now) throw bad("is not valid yet");
    if (!continuing && row.validTo && row.validTo < now) throw bad("has expired");
    if (!continuing && row.maxUses !== null && row.usedCount >= row.maxUses) {
      throw bad("was already used the maximum number of times");
    }
    if (row.allowedPlans.length > 0 && !row.allowedPlans.includes(planCode))
      throw bad("is not for this plan");
    const discountSum =
      row.kind === "percent"
        ? Math.round((planAmount * Math.min(100, row.value)) / 100)
        : Math.min(planAmount, row.value);
    return { row, discountSum };
  }

  /** The lines of a renewal: the plan for the next period and the recurring add-ons that go on. */
  private async renewalItems(r: Resolved, plan: PlanRow, cycle: "month" | "year"): Promise<InvoiceItem[]> {
    const items: InvoiceItem[] = [
      {
        kind: "plan",
        code: plan.code,
        title: `${plan.name} — ${cycle === "year" ? "12 months" : "1 month"}`,
        quantity: 1,
        amountSum: priceFor(plan, cycle),
      },
    ];
    const bought = await this.db
      .select({ addon: subscriptionAddons, catalog: addons })
      .from(subscriptionAddons)
      .innerJoin(addons, eq(addons.code, subscriptionAddons.addonCode))
      .where(
        and(
          eq(subscriptionAddons.subscriptionId, r.subscription.id),
          gte(subscriptionAddons.validTo, r.subscription.endsAt),
          eq(addons.kind, "recurring"),
        ),
      );
    for (const { addon, catalog } of bought) {
      if (!catalog.allowedPlans.includes(plan.code)) continue;
      items.push({
        kind: "addon",
        code: catalog.code,
        title: catalog.name,
        quantity: addon.quantity,
        amountSum: catalog.priceSum * addon.quantity * months(cycle),
      });
    }
    return items;
  }

  /** What a checkout would cost, without creating anything. */
  async quote(accountId: string, input: CheckoutInput, now = new Date()): Promise<Quote> {
    const r = await this.billing.get(accountId, now);
    const { state, subscription } = r;

    if (input.addon) {
      const addon = await this.db.query.addons.findFirst({ where: eq(addons.code, input.addon) });
      if (!addon) throw refuse(404, "NOT_FOUND", "No such add-on");
      if (state === "free" || state === "trial") {
        throw refuse(409, "ADDON_NOT_AVAILABLE", "Add-ons extend a paid plan: choose a plan first");
      }
      if (state === "grace") throw refuse(409, "PAY_OVERDUE_FIRST", "Pay the overdue invoice first");
      if (!addon.allowedPlans.includes(r.plan.code)) {
        throw refuse(409, "ADDON_NOT_AVAILABLE", `${addon.name} is not available on ${r.plan.name}`);
      }
      let amountSum = addon.priceSum * input.quantity;
      if (addon.kind === "recurring") {
        // Valid to the end of the period: charged for the part of the period that is left.
        const daysLeft = daysBetween(now, subscription.endsAt);
        const fraction = Math.min(daysLeft / 30, months(subscription.billingCycle));
        amountSum = roundUpThousand(amountSum * fraction);
      }
      const items: InvoiceItem[] = [
        { kind: "addon", code: addon.code, title: addon.name, quantity: input.quantity, amountSum },
      ];
      return {
        items,
        intent: { type: "addon", addonCode: addon.code, quantity: input.quantity },
        ...this.totals(items, 0),
      };
    }

    const plan = await this.db.query.plans.findFirst({ where: eq(plans.code, input.plan ?? "") });
    if (!plan || plan.code === "free" || (!plan.isPublic && plan.code !== r.plan.code)) {
      throw refuse(404, "NOT_FOUND", "No such plan");
    }
    let items: InvoiceItem[];
    let intent: InvoiceIntent;
    if (state === "active" || state === "grace") {
      if (plan.code !== r.plan.code) {
        throw refuse(
          409,
          state === "grace" ? "PAY_OVERDUE_FIRST" : "USE_CHANGE_PLAN",
          state === "grace"
            ? "Pay the overdue invoice first, then change the plan"
            : "Use change-plan to switch plans",
        );
      }
      // A renewal, early or overdue: the period goes on from where it ended.
      const cycle = subscription.billingCycle;
      const target = subscription.pendingPlanId
        ? ((await this.db.query.plans.findFirst({ where: eq(plans.id, subscription.pendingPlanId) })) ?? plan)
        : plan;
      items = await this.renewalItems(r, target, cycle);
      intent = {
        type: "plan",
        planCode: target.code,
        cycle,
        renewalOf: subscription.endsAt.toISOString(),
      };
    } else {
      items = [
        {
          kind: "plan",
          code: plan.code,
          title: `${plan.name} — ${input.cycle === "year" ? "12 months" : "1 month"}`,
          quantity: 1,
          amountSum: priceFor(plan, input.cycle),
        },
      ];
      intent = { type: "plan", planCode: plan.code, cycle: input.cycle };
    }
    const planAmount = items.filter((i) => i.kind === "plan").reduce((sum, i) => sum + i.amountSum, 0);
    let discountSum = 0;
    const promoCode = input.promoCode ?? (subscription.promoMonthsLeft > 0 ? subscription.promoCode : null);
    if (promoCode && intent.planCode) {
      const found = await this.promo(promoCode, intent.planCode, planAmount, now, !input.promoCode).catch(
        (e: unknown) => {
          // A promo already running on this subscription that has since ended is just dropped.
          if (!input.promoCode) return null;
          throw e;
        },
      );
      if (found) {
        discountSum = found.discountSum;
        intent.promoCode = found.row.code;
      }
    }
    return { items, intent, ...this.totals(items, discountSum) };
  }

  // --- AI credits -------------------------------------------------------------------------------

  /** What `credits` AI credits cost at `somPerCredit`: one line, VAT added like on every invoice. */
  async creditsQuote(accountId: string, credits: number, somPerCredit: number): Promise<Quote> {
    void accountId;
    const items: InvoiceItem[] = [
      {
        kind: "credits",
        code: "credits",
        title: `${credits} AI credits (${somPerCredit} soum each)`,
        quantity: credits,
        amountSum: credits * somPerCredit,
      },
    ];
    return { items, intent: { type: "credits", credits }, ...this.totals(items, 0) };
  }

  /** POST /v1/billing/credits/purchase: an invoice for the credits and where to pay it. */
  async creditsCheckout(
    accountId: string,
    credits: number,
    somPerCredit: number,
    provider: "payme" | "click" | "bank",
  ): Promise<CheckoutResponse> {
    if (provider !== "bank" && !this.providers().includes(provider)) {
      throw refuse(409, "PROVIDER_UNAVAILABLE", "Card payment is not available yet: pay by bank transfer");
    }
    const quote = await this.creditsQuote(accountId, credits, somPerCredit);
    const invoice = await this.createInvoice(accountId, quote, provider);
    return this.checkoutOf(invoice, provider);
  }

  // --- invoices ---------------------------------------------------------------------------------

  async createInvoice(
    accountId: string,
    quote: Quote,
    provider: "payme" | "click" | "bank" | null,
    dueAt?: Date,
    now = new Date(),
  ) {
    const [row] = await this.db
      .insert(invoices)
      .values({
        accountId,
        items: quote.items,
        intent: quote.intent,
        subtotalSum: quote.subtotalSum,
        discountSum: quote.discountSum,
        vatSum: quote.vatSum,
        totalSum: quote.totalSum,
        provider,
        dueAt: dueAt ?? addDays(now, this.config.INVOICE_DUE_DAYS),
      })
      .returning();
    if (!row) throw new HttpError(500, "INTERNAL", "Invoice was not saved");
    await this.event(accountId, "invoice_created", {
      invoice: invoiceNumber(row.number),
      total: row.totalSum,
    });
    return row;
  }

  checkoutUrl(invoice: typeof invoices.$inferSelect, provider: string): string | null {
    if (provider === "payme" && this.config.PAYME_MERCHANT_ID) {
      return paymeCheckoutUrl(this.config, invoice);
    }
    if (provider === "click" && clickEnabled(this.config)) return clickCheckout(this.config, invoice).url;
    return null;
  }

  /** The checkout answer of an invoice: the link, and for Click the values of its window over the page. */
  checkoutOf(invoice: typeof invoices.$inferSelect, provider: string): CheckoutResponse {
    return {
      invoice: invoiceView(invoice),
      checkoutUrl: this.checkoutUrl(invoice, provider),
      ...(provider === "click" && clickEnabled(this.config)
        ? { click: clickCheckout(this.config, invoice).values }
        : {}),
    };
  }

  /** POST /v1/billing/checkout: an invoice for the plan or add-on, and where to pay it. */
  async checkout(accountId: string, input: CheckoutInput): Promise<CheckoutResponse> {
    if (input.provider !== "bank" && !this.providers().includes(input.provider)) {
      throw refuse(409, "PROVIDER_UNAVAILABLE", "Card payment is not available yet: pay by bank transfer");
    }
    const quote = await this.quote(accountId, input);
    const invoice = await this.createInvoice(accountId, quote, input.provider);
    return this.checkoutOf(invoice, input.provider);
  }

  async listInvoices(accountId: string): Promise<InvoiceView[]> {
    const rows = await this.db.query.invoices.findMany({
      where: eq(invoices.accountId, accountId),
      orderBy: desc(invoices.createdAt),
      limit: 100,
    });
    return rows.map(invoiceView);
  }

  async invoice(accountId: string, id: string) {
    const row = await this.db.query.invoices.findFirst({
      where: and(eq(invoices.id, id), eq(invoices.accountId, accountId)),
    });
    if (!row) throw refuse(404, "NOT_FOUND", "No such invoice");
    return row;
  }

  // --- the subscription as the customer sees it -------------------------------------------------

  async subscriptionView(accountId: string): Promise<SubscriptionResponse> {
    const r = await this.billing.get(accountId);
    const { subscription: s, state } = r;
    const pending = s.pendingPlanId
      ? await this.db.query.plans.findFirst({ where: eq(plans.id, s.pendingPlanId) })
      : undefined;
    const bought = await this.db
      .select()
      .from(subscriptionAddons)
      .where(and(eq(subscriptionAddons.subscriptionId, s.id), gte(subscriptionAddons.validTo, new Date())))
      .orderBy(asc(subscriptionAddons.validFrom));
    const [next] = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.accountId, accountId), eq(invoices.status, "pending")))
      .orderBy(asc(invoices.dueAt))
      .limit(1);
    return {
      plan: r.entitlements.plan,
      status: state,
      billingCycle: s.billingCycle,
      periodStart: s.startsAt.toISOString(),
      periodEnd: state === "free" ? null : s.endsAt.toISOString(),
      autoRenew: s.autoRenew && !s.cancelAtPeriodEnd,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      pendingPlan: pending?.code ?? null,
      trialUsed: s.trialUsed,
      addons: bought.map((a) => ({
        code: a.addonCode,
        quantity: a.quantity,
        validFrom: a.validFrom.toISOString(),
        validTo: a.validTo.toISOString(),
      })),
      nextInvoice: next ? invoiceView(next) : null,
    };
  }

  // --- trial ------------------------------------------------------------------------------------

  /** The 14-day Business trial, once per account and once per INN of the first company, no card. */
  async startTrial(accountId: string, now = new Date()): Promise<SubscriptionResponse> {
    const r = await this.billing.get(accountId, now);
    if (r.subscription.trialUsed)
      throw refuse(409, "TRIAL_USED", "The trial was already used on this account");
    if (
      r.state !== "free" ||
      r.subscription.status === "suspended" ||
      r.subscription.status === "cancelled"
    ) {
      throw refuse(409, "TRIAL_NOT_AVAILABLE", "The trial starts from the Free plan");
    }
    const [first] = await this.db
      .select({ inn: companies.inn })
      .from(companies)
      .where(eq(companies.accountId, accountId))
      .orderBy(asc(companies.connectedAt))
      .limit(1);
    if (first) {
      const used = await this.db.execute<{ n: number }>(sql`
        select count(*)::int as n from companies c join subscriptions s on s.account_id = c.account_id
        where c.inn = ${first.inn} and c.account_id <> ${accountId} and s.trial_used`);
      if ((used[0]?.n ?? 0) > 0) {
        throw refuse(409, "TRIAL_USED", "A trial was already used for this company (INN)");
      }
    }
    const business = await this.db.query.plans.findFirst({ where: eq(plans.code, "business") });
    if (!business) throw new HttpError(500, "NO_PLAN", "The Business plan is missing");
    await this.db
      .update(subscriptions)
      .set({
        planId: business.id,
        status: "trial",
        startsAt: now,
        endsAt: addDays(now, TRIAL_DAYS),
        trialUsed: true,
        billingCycle: "month",
        cancelAtPeriodEnd: false,
        pendingPlanId: null,
        remindersSent: [],
      })
      .where(eq(subscriptions.id, r.subscription.id));
    await this.event(accountId, "trial_started", { ends: addDays(now, TRIAL_DAYS).toISOString() });
    this.billing.invalidate(accountId);
    return this.subscriptionView(accountId);
  }

  // --- changes of plan --------------------------------------------------------------------------

  async changePlan(accountId: string, input: ChangePlanInput, now = new Date()): Promise<ChangePlanResponse> {
    const r = await this.billing.get(accountId, now);
    const s = r.subscription;
    if (r.state === "grace")
      throw refuse(409, "PAY_OVERDUE_FIRST", "Pay the overdue invoice first, then change the plan");
    if (r.state !== "active") throw refuse(409, "USE_CHECKOUT", "Choose a plan to pay for it");
    const target = await this.db.query.plans.findFirst({ where: eq(plans.code, input.plan) });
    if (!target || target.code === "free" || !target.isPublic) throw refuse(404, "NOT_FOUND", "No such plan");
    const cycle = input.cycle ?? s.billingCycle;
    const current = r.plan;
    const none = { effect: "none" as const, checkout: null, effectiveAt: null };

    if (cycle !== s.billingCycle) {
      if (cycle === "month") {
        throw refuse(409, "CYCLE_AT_RENEWAL", "Yearly billing can be changed to monthly when it renews");
      }
      // Monthly -> yearly now: the yearly price minus the unused days of the month already paid.
      if (priceFor(target, "month") < priceFor(current, "month")) {
        throw refuse(409, "USE_CHANGE_PLAN", "Switch to yearly billing first, then move to the smaller plan");
      }
      const daysLeft = daysBetween(now, s.endsAt);
      const inPeriod = Math.max(1, daysBetween(s.startsAt, s.endsAt));
      const credit = Math.floor((current.priceUzs * daysLeft) / inPeriod / 1000) * 1000;
      const amountSum = Math.max(0, priceFor(target, "year") - credit);
      const items: InvoiceItem[] = [
        {
          kind: "upgrade",
          code: target.code,
          title: `${target.name} — 12 months, minus ${daysLeft} unused days`,
          quantity: 1,
          amountSum,
        },
      ];
      return this.invoiceForChange(
        accountId,
        items,
        { type: "upgrade", planCode: target.code, cycle: "year" },
        input.provider,
        now,
      );
    }

    if (target.code === current.code) {
      if (s.pendingPlanId) {
        await this.db.update(subscriptions).set({ pendingPlanId: null }).where(eq(subscriptions.id, s.id));
        await this.event(accountId, "downgrade_cancelled", {});
        this.billing.invalidate(accountId);
        return none;
      }
      throw refuse(409, "NOTHING_TO_CHANGE", "This is already your plan");
    }

    const newPrice = priceFor(target, s.billingCycle);
    const oldPrice = priceFor(current, s.billingCycle);
    if (newPrice < oldPrice) {
      // A downgrade waits for the end of the period; the next invoice uses the new price.
      await this.db.update(subscriptions).set({ pendingPlanId: target.id }).where(eq(subscriptions.id, s.id));
      await this.event(accountId, "downgrade_scheduled", {
        from: current.code,
        to: target.code,
        at: s.endsAt.toISOString(),
      });
      this.billing.invalidate(accountId);
      return { effect: "scheduled", checkout: null, effectiveAt: s.endsAt.toISOString() };
    }

    // An upgrade is immediate, for the prorated difference over the days left.
    const daysLeft = daysBetween(now, s.endsAt);
    const inPeriod = Math.max(1, daysBetween(s.startsAt, s.endsAt));
    const amountSum = roundUpThousand(((newPrice - oldPrice) * daysLeft) / inPeriod);
    const items: InvoiceItem[] = [
      {
        kind: "upgrade",
        code: target.code,
        title: `${current.name} → ${target.name}, ${daysLeft} days`,
        quantity: 1,
        amountSum,
      },
    ];
    return this.invoiceForChange(
      accountId,
      items,
      { type: "upgrade", planCode: target.code, cycle: s.billingCycle },
      input.provider,
      now,
    );
  }

  private async invoiceForChange(
    accountId: string,
    items: InvoiceItem[],
    intent: InvoiceIntent,
    provider: "payme" | "click" | "bank",
    now: Date,
  ): Promise<ChangePlanResponse> {
    const quote: Quote = { items, intent, ...this.totals(items, 0) };
    if (quote.subtotalSum === 0) {
      // Nothing to pay (the credit covers it): the change takes effect at once.
      await this.db.transaction((tx) => this.applyIntent(tx, accountId, intent, now, null));
      this.billing.invalidate(accountId);
      return { effect: "none", checkout: null, effectiveAt: now.toISOString() };
    }
    if (provider !== "bank" && !this.providers().includes(provider)) {
      throw refuse(409, "PROVIDER_UNAVAILABLE", "Card payment is not available yet: pay by bank transfer");
    }
    const invoice = await this.createInvoice(accountId, quote, provider, undefined, now);
    return {
      effect: "invoice",
      checkout: this.checkoutOf(invoice, provider),
      effectiveAt: null,
    };
  }

  /** Turns off auto-renewal: the plan stays until the end of the period, then Free. No refund. */
  async cancel(accountId: string): Promise<SubscriptionResponse> {
    const r = await this.billing.get(accountId);
    if (r.state !== "active" && r.state !== "grace") {
      throw refuse(409, "NOTHING_TO_CANCEL", "There is no paid plan to cancel");
    }
    await this.db
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: true, autoRenew: false })
      .where(eq(subscriptions.id, r.subscription.id));
    await this.event(accountId, "cancel_requested", { periodEnd: r.subscription.endsAt.toISOString() });
    this.billing.invalidate(accountId);
    return this.subscriptionView(accountId);
  }

  async resume(accountId: string): Promise<SubscriptionResponse> {
    const r = await this.billing.get(accountId);
    await this.db
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: false, autoRenew: true })
      .where(eq(subscriptions.id, r.subscription.id));
    await this.event(accountId, "cancel_withdrawn", {});
    this.billing.invalidate(accountId);
    return this.subscriptionView(accountId);
  }

  // --- paying -----------------------------------------------------------------------------------

  /**
   * An invoice was paid: marks it so and does what it was for, in one transaction. Calling it again
   * for a paid invoice does nothing. A payment that arrives after the invoice expired is accepted and
   * applied from the payment date, with an event for review.
   */
  async applyInvoice(
    invoiceId: string,
    paidAt = new Date(),
    via: { provider: string; ref: string } | null = null,
  ): Promise<{ applied: boolean }> {
    const result = await this.db.transaction(async (tx) => {
      const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
      if (!invoice) throw refuse(404, "NOT_FOUND", "No such invoice");
      if (invoice.status === "paid") return { applied: false, accountId: invoice.accountId };
      if (invoice.status === "cancelled")
        throw refuse(409, "INVOICE_CANCELLED", "This invoice was cancelled");
      if (invoice.status === "expired") {
        await this.event(
          invoice.accountId,
          "late_payment",
          { invoice: invoiceNumber(invoice.number), via },
          tx,
        );
      }
      await tx
        .update(invoices)
        .set({ status: "paid", paidAt, ...(via ? { provider: via.provider as "payme" } : {}) })
        .where(eq(invoices.id, invoiceId));
      await this.applyIntent(tx, invoice.accountId, invoice.intent, paidAt, invoice);
      await this.event(
        invoice.accountId,
        "invoice_paid",
        { invoice: invoiceNumber(invoice.number), total: invoice.totalSum, via },
        tx,
      );
      return { applied: true, accountId: invoice.accountId };
    });
    this.billing.invalidate(result.accountId);
    return { applied: result.applied };
  }

  /** What a paid (or free) invoice does to the subscription. */
  private async applyIntent(
    tx: Tx,
    accountId: string,
    intent: InvoiceIntent,
    now: Date,
    invoice: typeof invoices.$inferSelect | null,
  ): Promise<void> {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId))
      .for("update");
    if (!sub) throw new HttpError(402, "NO_SUBSCRIPTION", "The account has no subscription");
    const stateNow = stateOf(sub, now);

    if (intent.type === "credits") {
      const credits = intent.credits ?? 0;
      if (credits <= 0) return;
      await grantPurchase(tx, accountId, credits, invoice ? invoiceNumber(invoice.number) : "credits");
      await this.event(accountId, "credits_purchased", { credits }, tx);
      return;
    }

    if (intent.type === "addon") {
      if (!intent.addonCode) return;
      const validFrom = now;
      const validTo = stateNow === "free" || stateNow === "trial" ? addDays(now, 30) : sub.endsAt;
      await tx.insert(subscriptionAddons).values({
        subscriptionId: sub.id,
        addonCode: intent.addonCode,
        quantity: intent.quantity ?? 1,
        validFrom,
        validTo,
      });
      await this.event(
        accountId,
        "addon_added",
        { addon: intent.addonCode, quantity: intent.quantity ?? 1 },
        tx,
      );
      return;
    }

    const plan = await tx.query.plans.findFirst({ where: eq(plans.code, intent.planCode ?? "") });
    if (!plan) throw new HttpError(500, "NO_PLAN", "The plan of this invoice is missing");
    const cycle = intent.cycle ?? "month";
    const promoMonths = await this.promoMonths(tx, intent, invoice);

    if (intent.type === "upgrade") {
      // The plan changes now. A switch to yearly starts a new year; otherwise the period is kept.
      const yearly = cycle === "year" && sub.billingCycle !== "year";
      await tx
        .update(subscriptions)
        .set({
          planId: plan.id,
          status: "active",
          billingCycle: cycle,
          pendingPlanId: null,
          ...(yearly ? { startsAt: now, endsAt: periodEndOf(now, "year"), remindersSent: [] } : {}),
        })
        .where(eq(subscriptions.id, sub.id));
      await this.event(accountId, "upgraded", { from: sub.planId, to: plan.code, cycle }, tx);
      return;
    }

    const renewing = stateNow === "active" || stateNow === "grace";
    if (renewing && intent.renewalOf) {
      // The same period goes on from where it ended, even when it was paid late (within the grace).
      const start = sub.endsAt;
      const end = periodEndOf(start, cycle);
      await tx
        .update(subscriptions)
        .set({
          planId: plan.id,
          status: "active",
          billingCycle: cycle,
          startsAt: start,
          endsAt: end,
          pendingPlanId: null,
          remindersSent: [],
          ...promoMonths,
        })
        .where(eq(subscriptions.id, sub.id));
      // Recurring add-ons that were running go on with the period.
      await tx
        .update(subscriptionAddons)
        .set({ validTo: end })
        .where(and(eq(subscriptionAddons.subscriptionId, sub.id), gte(subscriptionAddons.validTo, start)));
      await this.event(
        accountId,
        stateNow === "grace" ? "renewed_in_grace" : "renewed",
        { plan: plan.code, until: end.toISOString() },
        tx,
      );
      return;
    }

    // From Free or a trial (or a lapsed plan): a new period starts today.
    const end = periodEndOf(now, cycle);
    await tx
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
        ...promoMonths,
      })
      .where(eq(subscriptions.id, sub.id));
    await this.event(
      accountId,
      "upgraded",
      { from: stateNow, to: plan.code, cycle, until: end.toISOString() },
      tx,
    );
  }

  /** The promo fields to set when this payment uses a code: months of discount left, and a use counted. */
  private async promoMonths(
    tx: Tx,
    intent: InvoiceIntent,
    invoice: typeof invoices.$inferSelect | null,
  ): Promise<{ promoCode?: string | null; promoMonthsLeft?: number }> {
    if (!invoice || !intent.promoCode) return {};
    const row = await tx.query.promoCodes.findFirst({ where: eq(promoCodes.code, intent.promoCode) });
    if (!row) return {};
    const used = months(intent.cycle ?? "month");
    // The first payment with a code counts one use; later renewals under it do not.
    const fresh = !intent.renewalOf;
    if (fresh) {
      await tx
        .update(promoCodes)
        .set({ usedCount: sql`${promoCodes.usedCount} + 1` })
        .where(eq(promoCodes.code, row.code));
    }
    const total = row.months ?? used;
    // Months still to discount after this payment: a one-off code leaves none.
    const sub = await tx.query.subscriptions.findFirst({
      where: eq(subscriptions.accountId, invoice.accountId),
    });
    const left = fresh ? Math.max(0, total - used) : Math.max(0, (sub?.promoMonthsLeft ?? 0) - used);
    return { promoCode: left > 0 ? row.code : null, promoMonthsLeft: left };
  }

  // --- printable invoice (bank transfer, PDF from the browser) ------------------------------------

  invoiceHtml(row: typeof invoices.$inferSelect, accountName: string): string {
    const esc = (v: string) =>
      v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
    const sum = (n: number) => `${new Intl.NumberFormat("ru-RU").format(n)} UZS`;
    const lines = row.items
      .map(
        (i) =>
          `<tr><td>${esc(i.title)}</td><td class="n">${i.quantity}</td><td class="n">${sum(i.amountSum)}</td></tr>`,
      )
      .join("");
    const requisites = (this.config.BANK_REQUISITES ?? "")
      .split("|")
      .map((l) => esc(l.trim()))
      .filter(Boolean)
      .join("<br>");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${invoiceNumber(row.number)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#111}
table{width:100%;border-collapse:collapse;margin:16px 0}td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left}
.n{text-align:right;white-space:nowrap}.tot td{font-weight:700;border-bottom:0}h1{font-size:22px}</style></head><body>
<h1>Invoice ${invoiceNumber(row.number)}</h1>
<p>${esc(accountName)}<br>Date: ${row.createdAt.toISOString().slice(0, 10)} · Pay by: ${row.dueAt.toISOString().slice(0, 10)}<br>Status: ${row.status}</p>
<table><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Amount</th></tr></thead><tbody>${lines}
<tr class="tot"><td colspan="2">Subtotal</td><td class="n">${sum(row.subtotalSum)}</td></tr>
${row.discountSum > 0 ? `<tr class="tot"><td colspan="2">Discount</td><td class="n">−${sum(row.discountSum)}</td></tr>` : ""}
${row.vatSum > 0 ? `<tr class="tot"><td colspan="2">VAT ${this.config.VAT_PERCENT}%</td><td class="n">${sum(row.vatSum)}</td></tr>` : ""}
<tr class="tot"><td colspan="2">Total</td><td class="n">${sum(row.totalSum)}</td></tr></tbody></table>
${requisites ? `<h2>Bank requisites</h2><p>${requisites}<br>Payment purpose: Invoice ${invoiceNumber(row.number)}</p>` : ""}
</body></html>`;
  }
}
