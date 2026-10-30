/**
 * AI credits (TZ "AI Buxgalter kredit tizimi"): one balance per account that every AI call is paid from at its real cost.
 * The monthly credits of the plan, the trial's credits, purchases and admin bonuses go in; AI use goes out; an unused
 * balance carries over, up to a cap. All changes are rows of credit_transactions, so the balance can always be re-added up.
 */
import {
  type AutoRechargeInput,
  type AutoRechargeSettings,
  type CreditsSummary,
  type CreditsView,
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
import { and, desc, eq, sql } from "drizzle-orm";

import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import {
  accounts,
  creditAccounts,
  creditRateHistory,
  creditRechargeFailures,
  creditTransactions,
  usageCounters,
} from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import type { Billing } from "./entitlements.js";
import type { Invoicing } from "./invoicing.js";

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

/** Writes one entry and moves the balance; `balanceAfter` is what the balance is then. */
async function post(tx: Tx, accountId: string, balance: number, entry: Entry): Promise<number> {
  const after = round4(balance + entry.credits);
  await tx.insert(creditTransactions).values({
    accountId,
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
    .set({ balanceCredits: after, updatedAt: new Date() })
    .where(eq(creditAccounts.accountId, accountId));
  return after;
}

/** Credits bought (an invoice paid): added whole, even over the cap, as they are already paid for. */
export async function grantPurchase(
  tx: Tx,
  accountId: string,
  credits: number,
  note: string,
): Promise<number> {
  const row = await lockRow(tx, accountId);
  return post(tx, accountId, row.balanceCredits, { type: "purchase", credits, note });
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
      const monthly = r.effectivePlan.monthlyCredits;
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

  async summary(accountId: string): Promise<CreditsSummary> {
    await this.ensureGrants(accountId);
    const r = await this.billing.get(accountId);
    const [row] = await this.db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
    const balance = row?.balanceCredits ?? 0;
    const monthly = r.state === "trial" ? TRIAL_CREDITS : r.effectivePlan.monthlyCredits;
    return {
      balanceCredits: Math.floor(balance),
      somPerCredit: (await this.price()).somPerCredit,
      monthlyCredits: monthly,
      low: balance < lowLevel(monthly),
    };
  }

  async view(accountId: string, historyLimit = 60): Promise<CreditsView> {
    await this.ensureGrants(accountId);
    const r = await this.billing.get(accountId);
    const [row] = await this.db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
    const balance = row?.balanceCredits ?? 0;
    const cap = row?.rolloverCapCredits ?? ROLLOVER_CAP_CREDITS;
    const { somPerCredit } = await this.price();
    const monthly = r.state === "trial" ? TRIAL_CREDITS : r.effectivePlan.monthlyCredits;
    const history = await this.db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.accountId, accountId))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(historyLimit);
    return {
      balanceCredits: Math.floor(balance),
      balanceSom: Math.round(balance * somPerCredit),
      somPerCredit,
      monthlyCredits: monthly,
      rolloverCapCredits: cap,
      low: balance < lowLevel(monthly),
      atCap: balance >= cap,
      canPurchase: r.effectivePlan.code !== "free",
      minPurchaseCredits: MIN_PURCHASE_CREDITS,
      autoRecharge: this.settings(row),
      history: history.map((h) => ({
        id: h.id,
        type: h.type,
        amountCredits: h.amountCredits,
        balanceAfter: h.balanceAfter,
        note: h.note,
        createdAt: h.createdAt.toISOString(),
      })),
    };
  }

  // --- spending -----------------------------------------------------------------------------------

  /**
   * Before an AI call: the balance must be over zero. At zero an auto-recharge is tried first; failing that the call is
   * refused with a plain message. Returns a warning (once) when the balance is low. An answer already being written is never
   * cut: this runs before a step, and one step may take the balance under zero.
   */
  async ensureCanSpend(accountId: string): Promise<{ code: string; message: string } | null> {
    await this.ensureGrants(accountId);
    let [row] = await this.db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
    if ((row?.balanceCredits ?? 0) <= 0) {
      if (await this.autoRecharge(accountId)) {
        [row] = await this.db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
      }
    }
    const balance = row?.balanceCredits ?? 0;
    if (balance <= 0) {
      const r = await this.billing.get(accountId);
      throw new HttpError(
        429,
        "AI_BUDGET_EXCEEDED",
        r.effectivePlan.code === "free"
          ? "Your AI credits are used up. They are added again next month, or choose a paid plan to continue."
          : "Your AI credits are used up. Top up your credits to continue.",
      );
    }
    const monthly = (await this.billing.get(accountId)).effectivePlan.monthlyCredits;
    if (balance < lowLevel(monthly)) {
      const warned = await this.markLow(accountId, balance);
      if (warned)
        return {
          code: "AI_CREDITS_LOW",
          message: `Your AI credits are running low: ${Math.floor(balance)} credits left.`,
        };
    }
    return null;
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

  /** After an AI call: its real cost leaves the balance, once, as a transaction tied to the call's usage row. */
  async spend(accountId: string, costUsd: number, usageId: string | null): Promise<void> {
    const credits = creditsOfUsd(costUsd);
    if (credits <= 0) return;
    const balance = await this.db.transaction(async (tx) => {
      const row = await lockRow(tx, accountId);
      return post(tx, accountId, row.balanceCredits, {
        type: "ai_usage",
        credits: -credits,
        relatedUsageId: usageId,
        note: `$${costUsd.toFixed(4)}`,
      });
    });
    const [row] = await this.db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
    if (row?.autoEnabled && balance <= row.autoThreshold) void this.autoRecharge(accountId);
  }

  // --- adding -------------------------------------------------------------------------------------

  /** An admin adds or takes credits (a bonus, a correction); a reason is required and goes to the history. */
  async adjust(
    accountId: string,
    credits: number,
    kind: "bonus" | "admin_adjustment",
    reason: string,
    adminId: string,
  ): Promise<number> {
    const account = await this.db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
    if (!account) throw new HttpError(404, "NOT_FOUND", "No such account");
    await this.ensureGrants(accountId);
    const r = await this.billing.get(accountId);
    const level = lowLevel(r.state === "trial" ? TRIAL_CREDITS : r.effectivePlan.monthlyCredits);
    const balance = await this.db.transaction(async (tx) => {
      const row = await lockRow(tx, accountId);
      if (row.balanceCredits + credits < 0)
        throw new HttpError(409, "BELOW_ZERO", "The balance cannot go below zero");
      const after = await post(tx, accountId, row.balanceCredits, {
        type: kind,
        credits,
        note: reason,
        meta: { adminId },
      });
      if (after >= level) {
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

  /** A purchase: an invoice for `credits` at today's price, to be paid by Payme, Click or bank transfer. */
  async purchase(accountId: string, credits: number, provider: "payme" | "click" | "bank") {
    const r = await this.billing.get(accountId);
    if (r.effectivePlan.code === "free")
      throw new HttpError(
        409,
        "CREDITS_NOT_AVAILABLE",
        "Credits are bought on a paid plan: choose a plan first",
      );
    const balance = await this.balance(accountId);
    const [row] = await this.db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
    const cap = row?.rolloverCapCredits ?? ROLLOVER_CAP_CREDITS;
    if (balance + credits > cap)
      throw new HttpError(
        409,
        "CREDIT_CAP",
        `The balance can hold at most ${cap} credits: you can add up to ${Math.max(0, Math.floor(cap - balance))} now`,
      );
    const { somPerCredit } = await this.price();
    return this.invoicing.creditsCheckout(accountId, credits, somPerCredit, provider);
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
      const room = Math.floor(row.rolloverCapCredits - row.balanceCredits);
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
      const quote = await this.invoicing.creditsQuote(accountId, amount, somPerCredit);
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
      somPerCredit: (await this.price()).somPerCredit,
      rolloverCapCredits: row?.rolloverCapCredits ?? ROLLOVER_CAP_CREDITS,
      history: history.map((h) => ({
        id: h.id,
        type: h.type,
        amountCredits: h.amountCredits,
        balanceAfter: h.balanceAfter,
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
        (select coalesce(sum(balance_credits), 0)::float8 from credit_accounts) as balance
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
    return {
      somPerCredit: price.somPerCredit,
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
