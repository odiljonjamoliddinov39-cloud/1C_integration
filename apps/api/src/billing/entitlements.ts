/**
 * getEntitlements: the one function every limit check calls. It merges the plan, the active add-ons
 * and the trial into what the account may do now, and caches the result for a short time.
 */
import {
  type BillingStatus,
  type Entitlements,
  GRACE_DAYS,
  TRIAL_AI_QUESTIONS,
  type UsageView,
} from "@platform/shared";
import { and, count, desc, eq, gte, lte } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { companies, plans, subscriptionAddons, subscriptions, usageCounters, users } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { DAY_MS, monthStart, monthlyAnchor } from "./period.js";

export type PlanRow = typeof plans.$inferSelect;
export type SubscriptionRow = typeof subscriptions.$inferSelect;

/** What an account is in right now: its stored row, read against the clock. */
export function stateOf(subscription: SubscriptionRow, now = new Date()): BillingStatus {
  const { status, endsAt } = subscription;
  if (status === "free" || status === "suspended" || status === "cancelled") return "free";
  if (now.getTime() <= endsAt.getTime())
    return status === "trial" ? "trial" : status === "grace" ? "grace" : "active";
  if (status === "trial") return "free";
  return now.getTime() <= endsAt.getTime() + GRACE_DAYS * DAY_MS ? "grace" : "free";
}

export interface Resolved {
  entitlements: Entitlements;
  subscription: SubscriptionRow;
  /** The plan the account has paid for (or the trial's), not the Free plan it fell back to. */
  plan: PlanRow;
  /** The plan whose limits apply now: `plan` while paid or on trial, else Free. */
  effectivePlan: PlanRow;
  freePlan: PlanRow;
  state: BillingStatus;
  /** Where this month's counters started. */
  counterStart: Date;
}

export class Billing {
  private readonly cache = new Map<string, { at: number; value: Resolved }>();
  constructor(
    private readonly db: Db,
    /** How long a result is reused; 0 turns the cache off. */
    private readonly cacheMs = 60_000,
  ) {}

  invalidate(accountId?: string): void {
    if (accountId) this.cache.delete(accountId);
    else this.cache.clear();
  }

  async get(accountId: string, now = new Date()): Promise<Resolved> {
    const hit = this.cache.get(accountId);
    if (hit && this.cacheMs > 0 && now.getTime() - hit.at < this.cacheMs) return hit.value;
    const value = await this.resolve(accountId, now);
    if (this.cacheMs > 0) this.cache.set(accountId, { at: now.getTime(), value });
    return value;
  }

  private async resolve(accountId: string, now: Date): Promise<Resolved> {
    const [row] = await this.db
      .select({ subscription: subscriptions, plan: plans })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(eq(subscriptions.accountId, accountId))
      .orderBy(desc(subscriptions.endsAt))
      .limit(1);
    if (!row) throw new HttpError(402, "NO_SUBSCRIPTION", "The account has no subscription");
    const freePlan = await this.db.query.plans.findFirst({ where: eq(plans.code, "free") });
    if (!freePlan) throw new HttpError(500, "NO_FREE_PLAN", "The Free plan is missing");

    const { subscription, plan } = row;
    const state = stateOf(subscription, now);
    const paid = state === "active" || state === "grace" || state === "trial";
    const effective = paid ? plan : freePlan;

    let companiesLimit = effective.maxCompanies;
    let usersLimit = effective.seats;
    let aiQuestions = effective.aiQuestionsPerMonth;
    if (state === "trial") aiQuestions = Math.min(aiQuestions, TRIAL_AI_QUESTIONS);
    if (state === "active" || state === "grace") {
      const bought = await this.db
        .select({ addon: subscriptionAddons })
        .from(subscriptionAddons)
        .where(
          and(
            eq(subscriptionAddons.subscriptionId, subscription.id),
            lte(subscriptionAddons.validFrom, now),
            gte(subscriptionAddons.validTo, now),
          ),
        );
      const catalog = await this.db.query.addons.findMany();
      for (const { addon } of bought) {
        const grants = catalog.find((a) => a.code === addon.addonCode)?.grants ?? {};
        companiesLimit += (grants.companies ?? 0) * addon.quantity;
        usersLimit += (grants.users ?? 0) * addon.quantity;
        aiQuestions += (grants.aiQuestions ?? 0) * addon.quantity;
      }
    }

    const counterStart =
      state === "trial"
        ? subscription.startsAt
        : paid
          ? monthlyAnchor(subscription.startsAt, now)
          : monthStart(now);
    const entitlements: Entitlements = {
      plan: effective.code as Entitlements["plan"],
      status: state,
      periodEnd: state === "free" ? null : subscription.endsAt.toISOString(),
      companies: companiesLimit,
      users: usersLimit,
      importsPerMonth: effective.importsPerMonth,
      auditsPerMonth: effective.auditsPerMonth,
      aiQuestionsPerMonth: aiQuestions,
      features: {
        excelExport: effective.features.excelExport ?? false,
        prioritySupport: effective.features.prioritySupport ?? false,
      },
    };
    return { entitlements, subscription, plan, effectivePlan: effective, freePlan, state, counterStart };
  }

  async usage(accountId: string, now = new Date()): Promise<UsageView> {
    const { counterStart } = await this.get(accountId, now);
    const [counter] = await this.db
      .select()
      .from(usageCounters)
      .where(and(eq(usageCounters.accountId, accountId), eq(usageCounters.periodStart, counterStart)));
    const [companyCount] = await this.db
      .select({ n: count() })
      .from(companies)
      .where(eq(companies.accountId, accountId));
    const [userCount] = await this.db
      .select({ n: count() })
      .from(users)
      .where(eq(users.accountId, accountId));
    return {
      periodStart: counterStart.toISOString(),
      companies: companyCount?.n ?? 0,
      users: userCount?.n ?? 0,
      imports: counter?.imports ?? 0,
      audits: counter?.audits ?? 0,
      aiQuestions: counter?.aiQuestions ?? 0,
    };
  }
}
