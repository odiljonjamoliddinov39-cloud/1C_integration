/**
 * The scheduled side of billing: reminders, renewal invoices, grace, and the move to Free. Nothing
 * here deletes data: an account that does not pay lands on Free, with its books untouched.
 */
import { GRACE_DAYS } from "@platform/shared";
import { and, eq, lt, sql } from "drizzle-orm";

import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { aiQuestionCharges, invoices, plans, subscriptions, usageCounters } from "../db/schema.js";
import type { Billing } from "./entitlements.js";
import { type Invoicing, invoiceNumber } from "./invoicing.js";
import { DAY_MS, FREE_END, addDays, daysBetween } from "./period.js";

export interface JobReport {
  graceStarted: number;
  movedToFree: number;
  invoicesExpired: number;
  reminders: number;
  renewalInvoices: number;
}

export class Lifecycle {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly billing: Billing,
    private readonly invoicing: Invoicing,
  ) {}

  /** Back to Free: the plan, add-ons' effect and promo end; companies over the limit turn read-only later. */
  private async toFree(sub: typeof subscriptions.$inferSelect, reason: string, now: Date): Promise<void> {
    const free = await this.db.query.plans.findFirst({ where: eq(plans.code, "free") });
    if (!free) return;
    await this.db
      .update(subscriptions)
      .set({
        planId: free.id,
        status: "free",
        startsAt: now,
        endsAt: FREE_END,
        autoRenew: true,
        cancelAtPeriodEnd: false,
        pendingPlanId: null,
        billingCycle: "month",
        promoCode: null,
        promoMonthsLeft: 0,
        remindersSent: [],
      })
      .where(eq(subscriptions.id, sub.id));
    await this.invoicing.event(sub.accountId, "moved_to_free", { from: sub.status, reason });
    this.billing.invalidate(sub.accountId);
  }

  /** Hourly: overdue plans go to grace; ended trials, finished grace and cancelled plans go to Free. */
  async hourly(
    now = new Date(),
  ): Promise<Pick<JobReport, "graceStarted" | "movedToFree" | "invoicesExpired">> {
    let graceStarted = 0;
    let movedToFree = 0;
    const ended = await this.db
      .select()
      .from(subscriptions)
      .where(and(lt(subscriptions.endsAt, now), sql`${subscriptions.status} in ('trial','active','grace')`));
    for (const sub of ended) {
      if (sub.status === "trial") {
        await this.toFree(sub, "trial_ended", now);
        movedToFree++;
      } else if (sub.cancelAtPeriodEnd) {
        await this.toFree(sub, "cancelled_at_period_end", now);
        movedToFree++;
      } else if (now.getTime() > sub.endsAt.getTime() + GRACE_DAYS * DAY_MS) {
        await this.toFree(sub, "grace_ended", now);
        movedToFree++;
      } else if (sub.status === "active") {
        await this.db.update(subscriptions).set({ status: "grace" }).where(eq(subscriptions.id, sub.id));
        await this.invoicing.event(sub.accountId, "grace_started", { due: sub.endsAt.toISOString() });
        this.billing.invalidate(sub.accountId);
        graceStarted++;
      }
    }
    const expired = await this.db
      .update(invoices)
      .set({ status: "expired" })
      .where(and(eq(invoices.status, "pending"), lt(invoices.dueAt, now)))
      .returning({ id: invoices.id });
    return { graceStarted, movedToFree, invoicesExpired: expired.length };
  }

  /**
   * Daily: reminders 7 and 1 days before the period ends (and each day of the grace), and the
   * renewal invoice, made once per period. Sending the reminder to the customer is left to a
   * notifier (e-mail, Telegram) that this system does not have yet: each one is recorded as an
   * event, and the desktop shows the state in the sidebar.
   */
  async daily(now = new Date()): Promise<Pick<JobReport, "reminders" | "renewalInvoices">> {
    let reminders = 0;
    let renewalInvoices = 0;
    const live = await this.db
      .select()
      .from(subscriptions)
      .where(sql`${subscriptions.status} in ('trial','active','grace')`);
    for (const sub of live) {
      const left = daysBetween(now, sub.endsAt);
      if (sub.status === "grace") {
        await this.invoicing.event(sub.accountId, "reminder_grace", {
          daysLeft: Math.max(0, GRACE_DAYS - daysBetween(sub.endsAt, now)),
        });
        reminders++;
        continue;
      }
      for (const mark of [7, 1] as const) {
        if (left <= mark && !sub.remindersSent.includes(String(mark))) {
          await this.invoicing.event(
            sub.accountId,
            sub.status === "trial" ? "reminder_trial_ending" : "reminder_renewal",
            {
              daysLeft: left,
            },
          );
          await this.db
            .update(subscriptions)
            .set({ remindersSent: sql`array_append(${subscriptions.remindersSent}, ${String(mark)})` })
            .where(eq(subscriptions.id, sub.id));
          sub.remindersSent = [...sub.remindersSent, String(mark)];
          reminders++;
        }
      }
      if (sub.status === "active" && sub.autoRenew && !sub.cancelAtPeriodEnd && left <= 7) {
        const made = await this.renewalInvoice(sub.accountId, now);
        if (made) renewalInvoices++;
      }
    }
    // Counters of closed months are only history.
    await this.db.delete(usageCounters).where(lt(usageCounters.periodStart, addDays(now, -400)));
    await this.db.delete(aiQuestionCharges).where(lt(aiQuestionCharges.createdAt, addDays(now, -7)));
    return { reminders, renewalInvoices };
  }

  /** One pending renewal invoice per period; none when this period already has one. */
  private async renewalInvoice(accountId: string, now: Date): Promise<boolean> {
    const r = await this.billing.get(accountId, now);
    const endIso = r.subscription.endsAt.toISOString();
    const existing = await this.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.accountId, accountId),
          sql`${invoices.intent}->>'renewalOf' = ${endIso}`,
          sql`${invoices.status} in ('pending','paid')`,
        ),
      )
      .limit(1);
    if (existing.length > 0) return false;
    const quote = await this.invoicing.quote(
      accountId,
      { plan: r.plan.code, quantity: 1, cycle: r.subscription.billingCycle, provider: "bank" },
      now,
    );
    const invoice = await this.invoicing.createInvoice(accountId, quote, null, r.subscription.endsAt, now);
    await this.invoicing.event(accountId, "renewal_invoice", { invoice: invoiceNumber(invoice.number) });
    return true;
  }

  async runAll(now = new Date()): Promise<JobReport> {
    return { ...(await this.hourly(now)), ...(await this.daily(now)) };
  }
}

/** Starts the hourly and daily jobs; returns what stops them. */
export function startBillingJobs(
  lifecycle: Lifecycle,
  log: { error: (obj: unknown, msg?: string) => void },
): () => void {
  const safely = (job: () => Promise<unknown>) => () =>
    void job().catch((e: unknown) => log.error(e, "billing job failed"));
  const hourly = setInterval(
    safely(() => lifecycle.hourly()),
    60 * 60 * 1000,
  );
  const daily = setInterval(
    safely(() => lifecycle.daily()),
    24 * 60 * 60 * 1000,
  );
  // A restart catches up at once; a minute in, so start-up is not slowed.
  const first = setTimeout(
    safely(async () => {
      await lifecycle.hourly();
      await lifecycle.daily();
    }),
    60_000,
  );
  for (const timer of [hourly, daily, first]) timer.unref();
  return () => {
    clearInterval(hourly);
    clearInterval(daily);
    clearTimeout(first);
  };
}
