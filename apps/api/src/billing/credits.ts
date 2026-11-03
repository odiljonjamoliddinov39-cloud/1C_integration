/**
 * AI credits (TZ "AI Buxgalter kredit tizimi"): one balance per account that every AI call is paid from at its real cost.
 * The monthly credits of the plan, the trial's credits, purchases and admin bonuses go in; AI use goes out; an unused
 * balance carries over, up to a cap. All changes are rows of credit_transactions, so the balance can always be re-added up.
 */
import {
  type AutoRechargeInput,
  type AutoRechargeSettings,
  type CreditBlock,
  type CreditLimitView,
  type CreditsSummary,
  type CreditsView,
  FALLBACK_QUESTION_SOM,
  FREE_AI_BUDGET_SUM,
  MIN_TOPUP_SUM,
  TOPUP_BALANCE_SHARE,
  payForCredits,
  topupCredits,
  type CreditTransactionType,
  LOW_BALANCE_CREDITS,
  LOW_BALANCE_SHARE,
  MIN_PURCHASE_CREDITS,
  PLAN_MONTHLY_CREDITS,
  ROLLOVER_CAP_CREDITS,
  TRIAL_AI_QUESTIONS,
  TRIAL_CREDITS,
  creditsOfUsd,
} from "@platform/shared";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";

import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import {
  accounts,
  addons,
  creditAccounts,
  creditRateHistory,
  creditRechargeFailures,
  creditTransactions,
  subscriptionAddons,
  usageCounters,
} from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import type { Billing, PlanRow, Resolved } from "./entitlements.js";
import { dayStart, limitCredits, weekStart } from "./credit-limits.js";
import { requestsOf } from "./credit-requests.js";
import type { Invoicing } from "./invoicing.js";
import { DAY_MS, addMonths } from "./period.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Charges the card an account saved for auto-recharge. Real card charging needs the payment system's merchant access. */
export interface CardCharger {
  charge(input: {
    accountId: string;
    method: "payme" | "click";
    cardToken: string;
    amountSom: number;
    invoiceId: string;
  }): Promise<{ ok: true; ref: string } | { ok: false; reason: string }>;
}

/** The charger of a server with no card-charging access: every recharge fails, and the customer is told. */
export const noCardCharger: CardCharger = {
  async charge() {
    return { ok: false, reason: "Charging a saved card is not set up on the server" };
  },
};

interface Entry {
  type: CreditTransactionType;
  credits: number;
  note?: string | null;
  periodKey?: string | null;
  relatedUsageId?: string | null;
  meta?: Record<string, unknown>;
}

/** Locks the account's balance row (made at the first need). */
async function lockRow(tx: Tx, accountId: string) {
  await tx.insert(creditAccounts).values({ accountId }).onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.accountId, accountId))
    .for("update");
  if (!row) throw new HttpError(500, "INTERNAL", "The credit balance could not be read");
  return row;
}

/** Writes one entry and moves a balance (the plan's or the extra one); `balanceAfter` is what that balance is then. */
async function write(
  tx: Tx,
  accountId: string,
  pool: "plan" | "extra",
  balance: number,
  entry: Entry,
): Promise<number> {
  const after = round4(balance + entry.credits);
  await tx.insert(creditTransactions).values({
    accountId,
    pool,
    type: entry.type,
    amountCredits: round4(entry.credits),
    balanceAfter: after,
    relatedUsageId: entry.relatedUsageId ?? null,
    periodKey: entry.periodKey ?? null,
    note: entry.note ?? null,
    meta: entry.meta ?? {},
  });
  await tx
    .update(creditAccounts)
    .set(
      pool === "plan"
        ? { balanceCredits: after, updatedAt: new Date() }
        : { extraCredits: after, updatedAt: new Date() },
    )
    .where(eq(creditAccounts.accountId, accountId));
  return after;
}

/** An entry of the plan's credits (monthly, trial, carried over, AI use). */
const post = (tx: Tx, accountId: string, balance: number, entry: Entry) =>
  write(tx, accountId, "plan", balance, entry);

/** An entry of the extra credits (bought, bonus). */
const postExtra = (tx: Tx, accountId: string, balance: number, entry: Entry) =>
  write(tx, accountId, "extra", balance, entry);

/**
 * Credits bought (an invoice paid, or a request an admin approved): added to the extra credits whole, even over the cap, as they
 * are already paid for. A customer who bought credits means to use them, so using the extra credits is turned on with them (the
 * cabinet can turn it off again); otherwise the plan's last credits would run out and the bought ones would sit unused.
 */
export async function grantPurchase(
  tx: Tx,
  accountId: string,
  credits: number,
  note: string,
): Promise<number> {
  const row = await lockRow(tx, accountId);
  const balance = await postExtra(tx, accountId, row.extraCredits, { type: "purchase", credits, note });
  if (!row.extraEnabled)
    await tx
      .update(creditAccounts)
      .set({ extraEnabled: true, updatedAt: new Date() })
      .where(eq(creditAccounts.accountId, accountId));
  return balance;
}

export const lowLevel = (monthlyCredits: number): number =>
  Math.min(LOW_BALANCE_CREDITS, Math.max(1, Math.round(monthlyCredits * LOW_BALANCE_SHARE)));

export class Credits {
  /** accountId → "state:period" the grants were made for, so most calls do not look at the table. */
  private readonly granted = new Map<string, string>();
  private readonly recharging = new Set<string>();
  private priceCache: { at: number; somPerCredit: number; cbuRate: number } | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly billing: Billing,
    private readonly invoicing: Invoicing,
    private readonly charger: CardCharger = noCardCharger,
  ) {}

  /** Off: the old questions and dollar budget are used (the way back, TZ 12.3). */
  get enabled(): boolean {
    return this.config.AI_CREDITS === "on";
  }

  // --- the price ----------------------------------------------------------------------------------

  async price(): Promise<{ somPerCredit: number; cbuRate: number }> {
    if (this.priceCache && Date.now() - this.priceCache.at < 30_000) return this.priceCache;
    const [row] = await this.db
      .select()
      .from(creditRateHistory)
      .orderBy(desc(creditRateHistory.createdAt))
      .limit(1);
    const value = { somPerCredit: row?.newSomPerCredit ?? 120, cbuRate: row?.cbuRate ?? 11_839 };
    this.priceCache = { at: Date.now(), ...value };
    return value;
  }

  invalidatePrice(): void {
    this.priceCache = null;
  }

  // --- what the plan's AI may cost, by the monthly payment ---------------------------------------

  /** The soum the add-ons that renew each month (an extra company or user) were paid, so their share is added to the budget. */
  private async recurringAddonSum(r: Resolved, now: Date): Promise<number> {
    const rows = await this.db
      .select({ price: addons.priceSum, quantity: subscriptionAddons.quantity, kind: addons.kind })
      .from(subscriptionAddons)
      .innerJoin(addons, eq(addons.code, subscriptionAddons.addonCode))
      .where(
        and(
          eq(subscriptionAddons.subscriptionId, r.subscription.id),
          lte(subscriptionAddons.validFrom, now),
          gte(subscriptionAddons.validTo, now),
        ),
      );
    return rows.filter((a) => a.kind === "recurring").reduce((sum, a) => sum + a.price * a.quantity, 0);
  }

  /**
   * The AI an account's plan allows a month. The budget is a share of what the customer pays (40%), and the cost never goes
   * over the ceiling share (45%); a paid add-on adds its own share. Free has no price: a fixed small budget. A trial has its credits.
   */
  async planBudget(r: Resolved, somPerCredit: number, now = new Date()) {
    const budgetPct = this.config.AI_BUDGET_PCT;
    const capPct = this.config.AI_COST_CAP_PCT;
    let budgetSum: number;
    let capSum: number;
    if (r.state === "trial") {
      budgetSum = TRIAL_CREDITS * somPerCredit;
      capSum = (budgetSum * capPct) / budgetPct;
    } else if (r.effectivePlan.priceUzs <= 0) {
      budgetSum = FREE_AI_BUDGET_SUM;
      capSum = (budgetSum * capPct) / budgetPct;
    } else {
      const paying = r.state === "active" || r.state === "grace";
      const paid = r.effectivePlan.priceUzs + (paying ? await this.recurringAddonSum(r, now) : 0);
      budgetSum = (paid * budgetPct) / 100;
      capSum = (paid * capPct) / 100;
    }
    return {
      budgetSum: Math.round(budgetSum),
      capSum: Math.round(capSum),
      budgetCredits: Math.round(budgetSum / somPerCredit),
      capCredits: Math.round(capSum / somPerCredit),
    };
  }

  /** What a plan's AI comes to by its price alone (for the price list), with the questions and tokens it is worth. */
  async planAi(plan: PlanRow) {
    const { somPerCredit } = await this.price();
    const { questionSom, tokensPerQuestion } = await this.estimates();
    const budgetSum =
      plan.priceUzs > 0 ? Math.round((plan.priceUzs * this.config.AI_BUDGET_PCT) / 100) : FREE_AI_BUDGET_SUM;
    const capSum =
      plan.priceUzs > 0
        ? Math.round((plan.priceUzs * this.config.AI_COST_CAP_PCT) / 100)
        : Math.round((FREE_AI_BUDGET_SUM * this.config.AI_COST_CAP_PCT) / this.config.AI_BUDGET_PCT);
    const estQuestions = Math.max(1, Math.round(budgetSum / questionSom));
    return {
      monthlyCredits: Math.round(budgetSum / somPerCredit),
      aiBudgetSum: budgetSum,
      aiCapSum: capSum,
      estQuestions,
      estTokens: tokensPerQuestion === null ? null : estQuestions * tokensPerQuestion,
    };
  }

  private estimateCache: { at: number; questionSom: number; tokensPerQuestion: number | null } | null = null;

  /**
   * What a question costs on average (soum) and how many tokens it takes, learned from the last 30 days of questions answered by
   * the model; until there are enough of them, a fixed average and no token figure.
   */
  async estimates(): Promise<{ questionSom: number; tokensPerQuestion: number | null }> {
    if (this.estimateCache && Date.now() - this.estimateCache.at < 600_000) return this.estimateCache;
    const { cbuRate } = await this.price();
    const [row] = await this.db.execute<{ q: number; usd: number; tokens: number }>(sql`
      select count(*) filter (where first_step)::int as q,
        coalesce(sum(cost_usd), 0)::float8 as usd,
        coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0)::float8 as tokens
      from ai_usage
      where route = 'model' and feature = 'chat' and created_at >= now() - interval '30 days'`);
    const enough = (row?.q ?? 0) >= 30 && (row?.usd ?? 0) > 0;
    const value = enough
      ? {
          questionSom: Math.round(((row?.usd ?? 0) * cbuRate) / (row?.q ?? 1)),
          tokensPerQuestion: Math.round((row?.tokens ?? 0) / (row?.q ?? 1)),
        }
      : { questionSom: FALLBACK_QUESTION_SOM, tokensPerQuestion: null };
    this.estimateCache = { at: Date.now(), ...value };
    return value;
  }

  // --- grants -------------------------------------------------------------------------------------

  /**
   * The credits an account is due and has not got: the trial's (once per account and company INN) while on a trial, else
   * this month's credits of its plan (once per month). Cheap to call: it only reads the table when the month changed.
   */
  async ensureGrants(accountId: string, now = new Date()): Promise<void> {
    const r = await this.billing.get(accountId, now);
    const period = r.counterStart.toISOString().slice(0, 10);
    const mark = `${r.state}:${period}:${r.effectivePlan.code}`;
    if (this.granted.get(accountId) === mark) return;
    if (r.state === "trial") {
      await this.trialGrant(accountId);
    } else {
      const monthly = (await this.planBudget(r, (await this.price()).somPerCredit, now)).budgetCredits;
      if (monthly > 0) await this.monthlyGrant(accountId, period, monthly);
    }
    this.granted.set(accountId, mark);
  }

  private async monthlyGrant(
    accountId: string,
    period: string,
    monthly: number,
    note?: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await lockRow(tx, accountId);
      const [done] = await tx
        .select({ id: creditTransactions.id })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.accountId, accountId),
            eq(creditTransactions.type, "monthly_grant"),
            eq(creditTransactions.periodKey, period),
          ),
        );
      if (done) return;
      const before = row.balanceCredits;
      const room = Math.max(0, row.rolloverCapCredits - before);
      const give = Math.min(monthly, room);
      // The unused part of the last month stays in the balance: say so once, so the rollover can be followed.
      const [earlier] = await tx
        .select({ id: creditTransactions.id })
        .from(creditTransactions)
        .where(and(eq(creditTransactions.accountId, accountId), eq(creditTransactions.type, "monthly_grant")))
        .limit(1);
      let balance = before;
      if (earlier && before > 0) {
        balance = await post(tx, accountId, balance, {
          type: "rollover",
          credits: 0,
          periodKey: period,
          note: "Unused credits carried to the new month",
          meta: { carried: Math.round(before) },
        });
      }
      await post(tx, accountId, balance, {
        type: "monthly_grant",
        credits: give,
        periodKey: period,
        note:
          note ??
          (give < monthly
            ? `The balance is at the cap (${row.rolloverCapCredits}): ${give} of ${monthly} credits added`
            : "Monthly credits of the plan"),
        meta: { planCredits: monthly },
      });
    });
  }

  private async trialGrant(accountId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await lockRow(tx, accountId);
      const [done] = await tx
        .select({ id: creditTransactions.id })
        .from(creditTransactions)
        .where(and(eq(creditTransactions.accountId, accountId), eq(creditTransactions.type, "trial_grant")));
      if (done) return;
      // Once per company INN too: a second account of the same company gets no second trial.
      const taken = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from credit_transactions t
          join companies c on c.account_id = t.account_id
          join companies mine on mine.inn = c.inn and mine.account_id = ${accountId}
        where t.type = 'trial_grant' and t.account_id <> ${accountId}`);
      const repeat = (taken[0]?.n ?? 0) > 0;
      await post(tx, accountId, row.balanceCredits, {
        type: "trial_grant",
        credits: repeat ? 0 : TRIAL_CREDITS,
        periodKey: "trial",
        note: repeat ? "This company already had a trial on another account" : "Credits of the 14-day trial",
      });
    });
  }

  // --- reading ------------------------------------------------------------------------------------

  async balance(accountId: string): Promise<number> {
    await this.ensureGrants(accountId);
    const [row] = await this.db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
    return row?.balanceCredits ?? 0;
  }

  private settings(row: typeof creditAccounts.$inferSelect | undefined): AutoRechargeSettings {
    return {
      enabled: row?.autoEnabled ?? false,
      thresholdCredits: row?.autoThreshold ?? 300,
      amountCredits: row?.autoAmount ?? 1_000,
      method: row?.autoMethod ?? null,
      hasCard: Boolean(row?.autoCardToken),
    };
  }

  /** The plan's credits used since `since` (AI use only), in credits; of one user when `userId` is given. */
  private async planUsed(accountId: string, since: Date, userId?: string): Promise<number> {
    const [row] = await this.db.execute<{ used: number }>(sql`
      select coalesce(-sum(t.amount_credits), 0)::float8 as used from credit_transactions t
      ${userId ? sql`join ai_usage u on u.id = t.related_usage_id` : sql``}
      where t.account_id = ${accountId} and t.type = 'ai_usage' and t.pool = 'plan'
        and t.created_at >= ${since.toISOString()}::timestamptz
        ${userId ? sql`and u.user_id = ${userId}` : sql``}`);
    return row?.used ?? 0;
  }

  /**
   * What stops the plan's credits now: nothing left of them, the week's limit, or the day's limit (the plan gives each a
   * share of its monthly credits). The extra credits are not touched by any of these.
   */
  async gate(
    accountId: string,
    row: typeof creditAccounts.$inferSelect | undefined,
    now = new Date(),
    userId?: string,
  ): Promise<{
    blocked: CreditBlock;
    daily: CreditLimitView | null;
    weekly: CreditLimitView | null;
    planResetsAt: string;
    budget: Awaited<ReturnType<Credits["planBudget"]>>;
    usedPeriod: number;
  }> {
    const r = await this.billing.get(accountId, now);
    const { somPerCredit } = await this.price();
    const budget = await this.planBudget(r, somPerCredit, now);
    const monthly = budget.budgetCredits;
    const window = async (pct: number, start: Date, length: number): Promise<CreditLimitView | null> => {
      const limit = limitCredits(monthly, pct);
      if (limit === null) return null;
      return {
        limitCredits: limit,
        usedCredits: await this.planUsed(accountId, start),
        resetsAt: new Date(start.getTime() + length).toISOString(),
      };
    };
    const daily = await window(r.effectivePlan.dailyLimitPct, dayStart(now), DAY_MS);
    const weekly = await window(r.effectivePlan.weeklyLimitPct, weekStart(now), 7 * DAY_MS);
    const reached = (w: CreditLimitView | null) => w !== null && w.usedCredits >= w.limitCredits;
    // The cost of a period never goes over the ceiling (a share of what the customer pays), whatever is left of the balance.
    const usedPeriod = await this.planUsed(accountId, r.counterStart);
    // With several users a day's limit is shared: one user may use at most 2 / (users) of it, so a colleague cannot take it all.
    let userReached = false;
    const seats = r.entitlements.users;
    if (userId && daily && seats > 1) {
      const userLimit = Math.ceil(daily.limitCredits * Math.min(1, 2 / seats));
      userReached = (await this.planUsed(accountId, dayStart(now), userId)) >= userLimit;
    }
    const blocked: CreditBlock =
      (row?.balanceCredits ?? 0) <= 0 || usedPeriod >= budget.capCredits
        ? "plan"
        : reached(weekly)
          ? "weekly"
          : reached(daily) || userReached
            ? "daily"
            : null;
    return {
      blocked,
      daily,
      weekly,
      planResetsAt: addMonths(r.counterStart, 1).toISOString(),
      budget,
      usedPeriod,
    };
  }

  async summary(accountId: string): Promise<CreditsSummary> {
    await this.ensureGrants(accountId);
    const [row] = await this.db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
    const balance = row?.balanceCredits ?? 0;
    const gate = await this.gate(accountId, row);
    const monthly = gate.budget.budgetCredits;
    return {
      balanceCredits: Math.floor(balance),
      ...(await this.estimates()),
      extraCredits: Math.floor(row?.extraCredits ?? 0),
      extraEnabled: row?.extraEnabled ?? false,
      blocked: gate.blocked,
      daily: gate.daily,
      weekly: gate.weekly,
      resetsAt:
        gate.blocked === "daily"
          ? (gate.daily?.resetsAt ?? null)
          : gate.blocked === "weekly"
            ? (gate.weekly?.resetsAt ?? null)
            : gate.blocked === "plan"
              ? gate.planResetsAt
              : null,
      somPerCredit: (await this.price()).somPerCredit,
      monthlyCredits: monthly,
      low: balance < lowLevel(monthly) && Math.floor(row?.extraCredits ?? 0) <= 0,
    };
  }

  async view(accountId: string, historyLimit = 60): Promise<CreditsView> {
    await this.ensureGrants(accountId);
    const r = await this.billing.get(accountId);
    const [row] = await this.db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
    const balance = row?.balanceCredits ?? 0;
    const cap = row?.rolloverCapCredits ?? ROLLOVER_CAP_CREDITS;
    const { somPerCredit } = await this.price();
    const gate = await this.gate(accountId, row);
    const monthly = gate.budget.budgetCredits;
    const history = await this.db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.accountId, accountId))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(historyLimit);
    return {
      balanceCredits: Math.floor(balance),
      extraCredits: Math.floor(row?.extraCredits ?? 0),
      extraEnabled: row?.extraEnabled ?? false,
      daily: gate.daily,
      weekly: gate.weekly,
      blocked: gate.blocked,
      planResetsAt: gate.planResetsAt,
      balanceSom: Math.round(balance * somPerCredit),
      somPerCredit,
      monthlyCredits: monthly,
      capCredits: gate.budget.capCredits,
      usedPeriodCredits: Math.round(gate.usedPeriod * 100) / 100,
      ...(await this.estimates()),
      rolloverCapCredits: cap,
      low: balance < lowLevel(monthly) && Math.floor(row?.extraCredits ?? 0) <= 0,
      atCap: balance >= cap,
      canPurchase: r.effectivePlan.code !== "free",
      minTopupSum: MIN_TOPUP_SUM,
      topupShare: TOPUP_BALANCE_SHARE,
      autoRecharge: this.settings(row),
      approvalRequired: this.approvalRequired,
      requests: await requestsOf(this.db, accountId),
      history: history.map((h) => ({
        id: h.id,
        type: h.type,
        amountCredits: h.amountCredits,
        balanceAfter: h.balanceAfter,
        pool: h.pool,
        note: h.note,
        createdAt: h.createdAt.toISOString(),
      })),
    };
  }

  // --- spending -----------------------------------------------------------------------------------

  /**
   * Before an AI call. The plan's credits are used first: they must not be out, and the day's and the week's limits of the plan
   * must not be reached. When one is, the extra credits (bought or given) are used if the customer allowed it and has some;
   * else the call is refused with the reason, and the customer is offered to turn the extra credits on, buy more, or wait.
   * Returns a warning (once) when the plan's credits are low. An answer already being written is never cut: this runs before
   * a step, and one step may take a balance under zero.
   */
  async ensureCanSpend(
    accountId: string,
    userId?: string,
  ): Promise<{ code: string; message: string } | null> {
    await this.ensureGrants(accountId);
    let [row] = await this.db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
    const gate = await this.gate(accountId, row, new Date(), userId);
    if (gate.blocked) {
      if (row?.extraEnabled && (row.extraCredits ?? 0) <= 0 && (await this.autoRecharge(accountId))) {
        [row] = await this.db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
      }
      // spend() takes this call's cost from the extra credits.
      if (row?.extraEnabled && (row.extraCredits ?? 0) > 0) return null;
      throw this.refusal(gate, row);
    }
    const balance = row?.balanceCredits ?? 0;
    // Extra credits (bought or given) are there to take over when the plan's run out: no warning to buy while there are some.
    if (balance < lowLevel(gate.budget.budgetCredits) && Math.floor(row?.extraCredits ?? 0) <= 0) {
      const warned = await this.markLow(accountId, balance);
      if (warned)
        return {
          code: "AI_CREDITS_LOW",
          message: `Your plan's AI credits are running low: ${Math.floor(balance)} credits left.`,
        };
    }
    return null;
  }

  /** The refusal for a call the plan's credits cannot take now, in words that name what to do. */
  private refusal(
    gate: {
      blocked: CreditBlock;
      daily: CreditLimitView | null;
      weekly: CreditLimitView | null;
      planResetsAt: string;
    },
    row: typeof creditAccounts.$inferSelect | undefined,
  ): HttpError {
    const extra = Math.floor(row?.extraCredits ?? 0);
    const options = row?.extraEnabled
      ? "Your extra credits are used up: buy more to continue now."
      : extra > 0
        ? "To continue now, turn on your extra credits in the cabinet."
        : "To continue now, buy extra credits in the cabinet.";
    if (gate.blocked === "daily")
      return new HttpError(
        429,
        "AI_LIMIT_DAILY",
        `Today's limit of your plan is reached; it starts over at ${gate.daily?.resetsAt}. ${options}`,
      );
    if (gate.blocked === "weekly")
      return new HttpError(
        429,
        "AI_LIMIT_WEEKLY",
        `This week's limit of your plan is reached; it starts over at ${gate.weekly?.resetsAt}. ${options}`,
      );
    return new HttpError(
      429,
      "AI_BUDGET_EXCEEDED",
      `Your plan's AI credits are used up; they are added again at ${gate.planResetsAt}. ${options}`,
    );
  }

  /** The low-balance mark: true the first time the balance is under the level (it is cleared when the balance recovers). */
  private async markLow(accountId: string, balance: number): Promise<boolean> {
    const rows = await this.db
      .update(creditAccounts)
      .set({ lowWarnedAt: new Date() })
      .where(and(eq(creditAccounts.accountId, accountId), sql`${creditAccounts.lowWarnedAt} is null`))
      .returning({ id: creditAccounts.accountId });
    if (rows.length === 0) return false;
    await this.invoicing.event(accountId, balance <= 0 ? "credits_exhausted" : "credits_low", {
      balanceCredits: Math.floor(balance),
    });
    return true;
  }

  /**
   * After an AI call: its real cost leaves the plan's credits, once, as a transaction tied to the call's usage row. When the
   * plan's credits cannot take it (out, or a limit reached) and the customer allowed it, it leaves the extra credits.
   */
  async spend(accountId: string, costUsd: number, usageId: string | null, userId?: string): Promise<void> {
    const credits = creditsOfUsd(costUsd);
    if (credits <= 0) return;
    const [before] = await this.db
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.accountId, accountId));
    const gate = await this.gate(accountId, before, new Date(), userId);
    const { pool, balance } = await this.db.transaction(async (tx) => {
      const row = await lockRow(tx, accountId);
      const entry = {
        type: "ai_usage" as const,
        credits: -credits,
        relatedUsageId: usageId,
        note: `$${costUsd.toFixed(4)}`,
      };
      if (gate.blocked && row.extraEnabled && row.extraCredits > 0)
        return { pool: "extra" as const, balance: await postExtra(tx, accountId, row.extraCredits, entry) };
      return { pool: "plan" as const, balance: await post(tx, accountId, row.balanceCredits, entry) };
    });
    const [row] = await this.db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
    if (pool === "extra" && row?.autoEnabled && balance <= row.autoThreshold)
      void this.autoRecharge(accountId);
  }

  // --- adding -------------------------------------------------------------------------------------

  /** An admin adds or takes credits (a bonus, a correction); a reason is required and goes to the history. */
  async adjust(
    accountId: string,
    credits: number,
    kind: "bonus" | "admin_adjustment",
    reason: string,
    adminId: string,
    pool: "plan" | "extra" = "plan",
  ): Promise<number> {
    const account = await this.db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
    if (!account) throw new HttpError(404, "NOT_FOUND", "No such account");
    await this.ensureGrants(accountId);
    const r = await this.billing.get(accountId);
    const level = lowLevel((await this.planBudget(r, (await this.price()).somPerCredit)).budgetCredits);
    const balance = await this.db.transaction(async (tx) => {
      const row = await lockRow(tx, accountId);
      const current = pool === "extra" ? row.extraCredits : row.balanceCredits;
      if (current + credits < 0) throw new HttpError(409, "BELOW_ZERO", "The balance cannot go below zero");
      const after = await write(tx, accountId, pool, current, {
        type: kind,
        credits,
        note: reason,
        meta: { adminId },
      });
      if (pool === "plan" && after >= level) {
        await tx
          .update(creditAccounts)
          .set({ lowWarnedAt: null })
          .where(eq(creditAccounts.accountId, accountId));
      }
      return after;
    });
    return balance;
  }

  // --- purchase and auto-recharge ----------------------------------------------------------------

  /** Extra credits are added when an admin approves a request, not paid online. */
  get approvalRequired(): boolean {
    return this.config.CREDIT_APPROVAL === "on";
  }

  /** A purchase or a request is possible: a paid plan, and the balance stays under the cap. */
  async assertCanBuy(accountId: string, credits: number): Promise<void> {
    const r = await this.billing.get(accountId);
    if (r.effectivePlan.code === "free")
      throw new HttpError(
        409,
        "CREDITS_NOT_AVAILABLE",
        "Credits are bought on a paid plan: choose a plan first",
      );
    await this.ensureGrants(accountId);
    const [row] = await this.db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
    const balance = row?.extraCredits ?? 0;
    const cap = row?.rolloverCapCredits ?? ROLLOVER_CAP_CREDITS;
    if (balance + credits > cap)
      throw new HttpError(
        409,
        "CREDIT_CAP",
        `The balance can hold at most ${cap} credits: you can add up to ${Math.max(0, Math.floor(cap - balance))} now`,
      );
  }

  /**
   * A top-up by the sum the customer pays (any sum from the minimum up): an invoice for it, to be paid by Payme, Click or bank
   * transfer. The extra balance gets the share of it that is AI (70%).
   */
  async purchase(accountId: string, sum: number, provider: "payme" | "click" | "bank") {
    if (this.approvalRequired)
      throw new HttpError(
        409,
        "APPROVAL_REQUIRED",
        "Credits are added when an admin approves a request: send a request instead",
      );
    const { somPerCredit } = await this.price();
    const credits = topupCredits(sum, somPerCredit);
    await this.assertCanBuy(accountId, credits);
    return this.invoicing.creditsCheckout(accountId, credits, somPerCredit, provider, sum);
  }

  /** The customer allows (or stops) the extra credits being used when the plan's credits or a limit are out. */
  async setExtraEnabled(accountId: string, enabled: boolean): Promise<void> {
    await this.db.transaction(async (tx) => {
      await lockRow(tx, accountId);
      await tx
        .update(creditAccounts)
        .set({ extraEnabled: enabled, updatedAt: new Date() })
        .where(eq(creditAccounts.accountId, accountId));
    });
    await this.invoicing.event(accountId, enabled ? "extra_credits_on" : "extra_credits_off", {});
  }

  async saveAutoRecharge(accountId: string, input: AutoRechargeInput): Promise<AutoRechargeSettings> {
    const r = await this.billing.get(accountId);
    if (input.enabled && r.effectivePlan.code === "free")
      throw new HttpError(409, "AUTO_RECHARGE_NOT_AVAILABLE", "Auto-recharge needs a paid plan");
    await this.db.transaction(async (tx) => {
      const row = await lockRow(tx, accountId);
      const token = input.cardToken ?? row.autoCardToken;
      if (input.enabled && (!input.method || !token))
        throw new HttpError(400, "CARD_REQUIRED", "Save a card for Payme or Click first");
      await tx
        .update(creditAccounts)
        .set({
          autoEnabled: input.enabled,
          autoThreshold: input.thresholdCredits,
          autoAmount: input.amountCredits,
          autoMethod: input.method,
          autoCardToken: token ?? null,
          updatedAt: new Date(),
        })
        .where(eq(creditAccounts.accountId, accountId));
    });
    const [row] = await this.db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
    return this.settings(row);
  }

  /**
   * Buys credits with the saved card when auto-recharge is on. True when credits were added. A failure is kept for the admin and
   * recorded for the customer, who then gets the "credits used up" message; it does not stop the call that asked.
   */
  async autoRecharge(accountId: string): Promise<boolean> {
    if (this.recharging.has(accountId)) return false;
    this.recharging.add(accountId);
    try {
      const [row] = await this.db
        .select()
        .from(creditAccounts)
        .where(eq(creditAccounts.accountId, accountId));
      if (!row?.autoEnabled) return false;
      const r = await this.billing.get(accountId);
      if (r.effectivePlan.code === "free") return false;
      const room = Math.floor(row.rolloverCapCredits - row.extraCredits);
      const amount = Math.min(row.autoAmount, room);
      const fail = async (reason: string) => {
        await this.db
          .insert(creditRechargeFailures)
          .values({ accountId, amountCredits: row.autoAmount, reason });
        await this.invoicing.event(accountId, "auto_recharge_failed", {
          reason,
          amountCredits: row.autoAmount,
        });
        return false;
      };
      if (amount < MIN_PURCHASE_CREDITS) return await fail("The balance is at the cap: nothing to add");
      if (!row.autoMethod || !row.autoCardToken) return await fail("No saved card");
      const { somPerCredit } = await this.price();
      const quote = await this.invoicing.creditsQuote(
        accountId,
        amount,
        somPerCredit,
        payForCredits(amount, somPerCredit),
      );
      const invoice = await this.invoicing.createInvoice(accountId, quote, row.autoMethod);
      const result = await this.charger.charge({
        accountId,
        method: row.autoMethod,
        cardToken: row.autoCardToken,
        amountSom: invoice.totalSum,
        invoiceId: invoice.id,
      });
      if (!result.ok) return await fail(result.reason);
      await this.invoicing.applyInvoice(invoice.id, new Date(), {
        provider: row.autoMethod,
        ref: result.ref,
      });
      await this.invoicing.event(accountId, "auto_recharged", { amountCredits: amount, invoice: invoice.id });
      await this.db
        .update(creditAccounts)
        .set({ lowWarnedAt: null })
        .where(eq(creditAccounts.accountId, accountId));
      return true;
    } finally {
      this.recharging.delete(accountId);
    }
  }

  // --- the move to credits (TZ 12.2) -------------------------------------------------------------

  /**
   * Accounts that have no balance yet get one worked out from what is left of their month: the questions left of the plan's
   * allowance, times the plan's monthly credits over its questions. Run at start-up; an account that has a balance is left alone.
   */
  async migrateExisting(now = new Date()): Promise<number> {
    const rows = await this.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(sql`not exists (select 1 from credit_accounts c where c.account_id = ${accounts.id})`);
    let moved = 0;
    for (const { id } of rows) {
      try {
        const r = await this.billing.get(id, now);
        const period = r.counterStart.toISOString().slice(0, 10);
        const [counter] = await this.db
          .select()
          .from(usageCounters)
          .where(and(eq(usageCounters.accountId, id), eq(usageCounters.periodStart, r.counterStart)));
        const used = counter?.aiQuestions ?? 0;
        const trial = r.state === "trial";
        const quota = trial ? TRIAL_AI_QUESTIONS : r.effectivePlan.aiQuestionsPerMonth;
        const base = trial
          ? TRIAL_CREDITS
          : (PLAN_MONTHLY_CREDITS[r.effectivePlan.code] ?? r.effectivePlan.monthlyCredits);
        const share = quota > 0 ? Math.max(0, quota - used) / quota : 1;
        const credits = Math.round(base * share);
        await this.db.transaction(async (tx) => {
          const row = await lockRow(tx, id);
          await post(tx, id, row.balanceCredits, {
            type: trial ? "trial_grant" : "monthly_grant",
            credits,
            periodKey: trial ? "trial" : period,
            note: "Moved to credits: what was left of this month's AI questions",
            meta: { migrated: true, questionsUsed: used, questionsQuota: quota },
          });
        });
        this.granted.set(id, `${r.state}:${period}:${r.effectivePlan.code}`);
        moved++;
      } catch {
        // an account without a subscription cannot be priced: it gets its credits at its first use
      }
    }
    return moved;
  }

  // --- the admin ---------------------------------------------------------------------------------

  async adminAccount(accountId: string, limit = 100) {
    await this.ensureGrants(accountId).catch(() => undefined);
    const [row] = await this.db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
    const history = await this.db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.accountId, accountId))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(limit);
    return {
      balanceCredits: row?.balanceCredits ?? 0,
      extraCredits: row?.extraCredits ?? 0,
      extraEnabled: row?.extraEnabled ?? false,
      somPerCredit: (await this.price()).somPerCredit,
      rolloverCapCredits: row?.rolloverCapCredits ?? ROLLOVER_CAP_CREDITS,
      history: history.map((h) => ({
        id: h.id,
        type: h.type,
        amountCredits: h.amountCredits,
        balanceAfter: h.balanceAfter,
        pool: h.pool,
        note: h.note,
        createdAt: h.createdAt.toISOString(),
      })),
    };
  }

  async report(now = new Date()) {
    const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const [totals] = await this.db.execute<{
      sold: number;
      spent: number;
      rolled: number;
      at_cap: number;
      balance: number;
    }>(sql`
      select
        coalesce(sum(amount_credits) filter (where type = 'purchase' and created_at >= ${since}::timestamptz), 0)::float8 as sold,
        coalesce(-sum(amount_credits) filter (where type = 'ai_usage' and created_at >= ${since}::timestamptz), 0)::float8 as spent,
        coalesce(sum((meta->>'carried')::float8) filter (where type = 'rollover' and created_at >= ${since}::timestamptz), 0)::float8 as rolled,
        (select count(*)::int from credit_accounts where balance_credits >= rollover_cap_credits) as at_cap,
        (select coalesce(sum(balance_credits + extra_credits), 0)::float8 from credit_accounts) as balance
      from credit_transactions`);
    const [paid] = await this.db.execute<{ som: number }>(sql`
      select coalesce(sum(subtotal_sum - discount_sum), 0)::float8 as som from invoices
      where status = 'paid' and paid_at >= ${since}::timestamptz and intent->>'type' = 'credits'`);
    const rates = await this.db
      .select()
      .from(creditRateHistory)
      .orderBy(desc(creditRateHistory.createdAt))
      .limit(30);
    const failures = await this.db
      .select({ f: creditRechargeFailures, name: accounts.name })
      .from(creditRechargeFailures)
      .innerJoin(accounts, eq(accounts.id, creditRechargeFailures.accountId))
      .orderBy(desc(creditRechargeFailures.createdAt))
      .limit(50);
    const price = await this.price();
    const [waiting] = await this.db.execute<{ n: number }>(
      sql`select count(*)::int as n from credit_requests where status = 'pending'`,
    );
    return {
      somPerCredit: price.somPerCredit,
      pendingRequests: waiting?.n ?? 0,
      cbuRate: price.cbuRate,
      soldCredits30d: Math.round(totals?.sold ?? 0),
      soldSom30d: Math.round(paid?.som ?? 0),
      spentCredits30d: Math.round(totals?.spent ?? 0),
      rolledOverCredits30d: Math.round(totals?.rolled ?? 0),
      accountsAtCap: totals?.at_cap ?? 0,
      totalBalanceCredits: Math.round(totals?.balance ?? 0),
      rates: rates.map((x) => ({
        id: x.id,
        oldSomPerCredit: x.oldSomPerCredit,
        newSomPerCredit: x.newSomPerCredit,
        cbuRate: x.cbuRate,
        setBy: x.setBy,
        note: x.note,
        createdAt: x.createdAt.toISOString(),
      })),
      failures: failures.map(({ f, name }) => ({
        id: f.id,
        accountId: f.accountId,
        accountName: name,
        amountCredits: f.amountCredits,
        reason: f.reason,
        createdAt: f.createdAt.toISOString(),
      })),
    };
  }
}
