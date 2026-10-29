/**
 * What an account may do under its plan, and the counters that say how much it has done. Routes stay
 * thin; every refusal carries a code the desktop app turns into an "Upgrade" dialog.
 */
import {
  type CatalogResponse,
  type CompanyInput,
  type CompanyView,
  type EntitlementsResponse,
  type InviteUserInput,
  type PlanView,
  TRIAL_DAYS,
  yearPriceOf,
} from "@platform/shared";
import { hash } from "@node-rs/argon2";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";

import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { addons, aiQuestionCharges, companies, plans, usageCounters, users } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import type { Billing } from "./entitlements.js";

type Field = "imports" | "audits" | "ai_questions";

const limitError = (code: string, message: string) => new HttpError(402, code, message);

export function planView(p: typeof plans.$inferSelect): PlanView {
  return {
    code: p.code,
    name: p.name || p.code,
    priceMonthSum: p.priceUzs,
    priceYearSum: yearPriceOf(p.priceUzs, p.priceYearSum),
    companies: p.maxCompanies,
    users: p.seats,
    importsPerMonth: p.importsPerMonth,
    auditsPerMonth: p.auditsPerMonth,
    aiQuestionsPerMonth: p.aiQuestionsPerMonth,
    features: {
      excelExport: p.features.excelExport ?? false,
      prioritySupport: p.features.prioritySupport ?? false,
      support: p.features.support ?? "docs",
      telegram: p.features.telegram ?? false,
    },
    isPublic: p.isPublic,
    sortOrder: p.sortOrder,
  };
}

export class BillingService {
  constructor(
    readonly db: Db,
    readonly config: Config,
    readonly billing: Billing,
    /** The payment systems switched on (see config), for the pricing page. */
    readonly providers: string[] = ["bank"],
  ) {}

  /** The plan catalog for the pricing page: public plans and add-ons, no account needed. */
  async catalog(): Promise<CatalogResponse> {
    const planRows = await this.db
      .select()
      .from(plans)
      .where(eq(plans.isPublic, true))
      .orderBy(asc(plans.sortOrder));
    const addonRows = await this.db
      .select()
      .from(addons)
      .where(eq(addons.isPublic, true))
      .orderBy(asc(addons.priceSum));
    return {
      plans: planRows.map(planView),
      addons: addonRows.map((a) => ({
        code: a.code,
        name: a.name,
        priceSum: a.priceSum,
        kind: a.kind,
        allowedPlans: a.allowedPlans,
        grants: a.grants,
      })),
      vatPercent: this.config.VAT_PERCENT,
      trialDays: TRIAL_DAYS,
      providers: this.providers,
    };
  }

  /** Current limits and use. Also settles which companies are read-only under today's limit. */
  async entitlements(accountId: string): Promise<EntitlementsResponse> {
    const resolved = await this.billing.get(accountId);
    await this.syncReadOnly(accountId, resolved.entitlements.companies);
    const usage = await this.billing.usage(accountId);
    const readOnly = await this.db
      .select({ inn: companies.inn })
      .from(companies)
      .where(and(eq(companies.accountId, accountId), eq(companies.readOnly, true)));
    const { subscription, state } = resolved;
    const pending = subscription.pendingPlanId
      ? await this.db.query.plans.findFirst({ where: eq(plans.id, subscription.pendingPlanId) })
      : undefined;
    return {
      entitlements: resolved.entitlements,
      usage,
      readOnlyCompanies: readOnly.map((c) => c.inn),
      canStartTrial: state === "free" && !subscription.trialUsed,
      pendingPlan: pending?.code ?? null,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      cabinetUrl: this.config.SITE_URL ? `${this.config.SITE_URL}/cabinet` : null,
    };
  }

  private enforced(): boolean {
    return this.config.PLAN_LIMITS === "on";
  }

  // --- companies --------------------------------------------------------------------------------

  /**
   * The newest companies stay active up to the limit (the ones the owner prefers first); the rest
   * are read-only: their data stays visible, imports and the assistant are off.
   */
  async syncReadOnly(accountId: string, limit: number): Promise<void> {
    if (!this.enforced()) return;
    const rows = await this.db
      .select({ id: companies.id, readOnly: companies.readOnly })
      .from(companies)
      .where(eq(companies.accountId, accountId))
      .orderBy(desc(companies.preferred), desc(companies.connectedAt));
    for (const [index, row] of rows.entries()) {
      const shouldBeReadOnly = index >= limit;
      if (row.readOnly !== shouldBeReadOnly) {
        await this.db.update(companies).set({ readOnly: shouldBeReadOnly }).where(eq(companies.id, row.id));
      }
    }
  }

  async listCompanies(accountId: string): Promise<CompanyView[]> {
    const { entitlements } = await this.billing.get(accountId);
    await this.syncReadOnly(accountId, entitlements.companies);
    const rows = await this.db.query.companies.findMany({
      where: eq(companies.accountId, accountId),
      orderBy: asc(companies.connectedAt),
    });
    return rows.map(companyView);
  }

  /** Connects a 1C base (INN and name only). Registering the same INN again just renames it. */
  async registerCompany(accountId: string, input: CompanyInput): Promise<CompanyView> {
    const { entitlements } = await this.billing.get(accountId);
    const existing = await this.db.query.companies.findFirst({
      where: and(eq(companies.accountId, accountId), eq(companies.inn, input.inn)),
    });
    if (existing) {
      const [row] = await this.db
        .update(companies)
        .set({ name: input.name })
        .where(eq(companies.id, existing.id))
        .returning();
      return companyView(row ?? existing);
    }
    const [{ n } = { n: 0 }] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(companies)
      .where(eq(companies.accountId, accountId));
    if (this.enforced() && n >= entitlements.companies) {
      throw limitError(
        "COMPANY_LIMIT",
        `Plan allows ${entitlements.companies} ${entitlements.companies === 1 ? "company" : "companies"}. Upgrade to connect more.`,
      );
    }
    const [row] = await this.db
      .insert(companies)
      .values({ accountId, ...input })
      .returning();
    if (!row) throw new HttpError(500, "INTERNAL", "Company was not saved");
    return companyView(row);
  }

  /** The owner picks which companies stay active when the plan has room for fewer. */
  async chooseActive(accountId: string, inns: string[]): Promise<CompanyView[]> {
    const { entitlements } = await this.billing.get(accountId);
    if (inns.length > entitlements.companies) {
      throw limitError("COMPANY_LIMIT", `Plan allows ${entitlements.companies} active companies`);
    }
    await this.db.update(companies).set({ preferred: false }).where(eq(companies.accountId, accountId));
    for (const inn of inns) {
      await this.db
        .update(companies)
        .set({ preferred: true })
        .where(and(eq(companies.accountId, accountId), eq(companies.inn, inn)));
    }
    return this.listCompanies(accountId);
  }

  async assertWritable(accountId: string, inn: string | undefined): Promise<void> {
    if (!inn) return;
    const company = await this.db.query.companies.findFirst({
      where: and(eq(companies.accountId, accountId), eq(companies.inn, inn)),
    });
    if (company?.readOnly)
      throw limitError("COMPANY_READ_ONLY", "This company is over the plan's limit: it is read-only");
  }

  // --- users ------------------------------------------------------------------------------------

  /** The owner adds a colleague; refused when the plan has no free seat. */
  async inviteUser(accountId: string, input: InviteUserInput): Promise<{ id: string; email: string }> {
    const { entitlements } = await this.billing.get(accountId);
    const [{ n } = { n: 0 }] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.accountId, accountId));
    if (this.enforced() && n >= entitlements.users) {
      throw limitError(
        "USER_LIMIT",
        `Plan allows ${entitlements.users} user${entitlements.users === 1 ? "" : "s"}. Upgrade or add an extra user.`,
      );
    }
    const taken = await this.db.query.users.findFirst({ where: eq(users.email, input.email) });
    if (taken) throw new HttpError(409, "EMAIL_TAKEN", "An account with this email already exists");
    const [row] = await this.db
      .insert(users)
      .values({
        accountId,
        email: input.email,
        name: input.name,
        passwordHash: await hash(input.password),
        role: "member",
      })
      .returning({ id: users.id, email: users.email });
    if (!row) throw new HttpError(500, "INTERNAL", "User was not saved");
    return row;
  }

  async removeUser(accountId: string, userId: string, byUserId: string): Promise<void> {
    if (userId === byUserId) throw new HttpError(400, "BAD_REQUEST", "You cannot remove yourself");
    const [row] = await this.db
      .delete(users)
      .where(and(eq(users.id, userId), eq(users.accountId, accountId), ne(users.role, "owner")))
      .returning({ id: users.id });
    if (!row) throw new HttpError(404, "NOT_FOUND", "No such user");
  }

  // --- counters ---------------------------------------------------------------------------------

  /**
   * Adds to a counter of the current period, unless that goes over `limit` (null: no limit). The
   * check and the add are one statement, so two requests at once cannot both take the last unit.
   */
  private async bump(
    accountId: string,
    field: Field,
    by: number,
    limit: number | null,
  ): Promise<number | null> {
    const { counterStart } = await this.billing.get(accountId);
    if (limit !== null && by > limit) return null;
    const column = sql.raw(`usage_counters.${field}`);
    const rows = await this.db.execute<{ value: number }>(sql`
      insert into usage_counters (account_id, period_start, ${sql.raw(field)})
      values (${accountId}, ${counterStart.toISOString()}::timestamptz, ${by})
      on conflict (account_id, period_start) do update
        set ${sql.raw(field)} = ${column} + ${by}
        where ${limit}::int is null or ${column} + ${by} <= ${limit}::int
      returning ${sql.raw(field)} as value`);
    return rows[0]?.value ?? null;
  }

  /** A document the app wrote to 1C. Paused for the month when a Free account is out of imports. */
  async countImport(accountId: string, count: number, inn?: string): Promise<EntitlementsResponse> {
    await this.assertWritable(accountId, inn);
    const { entitlements } = await this.billing.get(accountId);
    const limit = this.enforced() ? entitlements.importsPerMonth : null;
    const value = await this.bump(accountId, "imports", count, limit);
    if (value === null) {
      throw limitError(
        "IMPORT_LIMIT",
        `Free plan allows ${entitlements.importsPerMonth} imported documents a month. Import resumes next month, or upgrade.`,
      );
    }
    return this.entitlements(accountId);
  }

  async countAudit(accountId: string, inn?: string): Promise<EntitlementsResponse> {
    await this.assertWritable(accountId, inn);
    const { entitlements } = await this.billing.get(accountId);
    const limit = this.enforced() ? entitlements.auditsPerMonth : null;
    const value = await this.bump(accountId, "audits", 1, limit);
    if (value === null) {
      throw limitError(
        "AUDIT_LIMIT",
        `Plan allows ${entitlements.auditsPerMonth} audit report${entitlements.auditsPerMonth === 1 ? "" : "s"} a month. Upgrade for unlimited audits.`,
      );
    }
    return this.entitlements(accountId);
  }

  /**
   * A new question reaches the model: it is counted (template and cache answers never get here).
   * Refused at 100%; the answer that is already being written is never cut, because only the first
   * step of a question comes through here. Returns the warning to show at 80%, once per period.
   */
  async takeAiQuestion(
    accountId: string,
    questionKey?: string,
  ): Promise<{ code: string; message: string } | null> {
    const { entitlements, counterStart } = await this.billing.get(accountId);
    const limit = entitlements.aiQuestionsPerMonth;
    const value = await this.bump(accountId, "ai_questions", 1, this.enforced() ? limit : null);
    if (value === null) {
      const paid = entitlements.plan !== "free";
      throw limitError(
        "AI_QUESTIONS_LIMIT",
        paid
          ? `You used all ${limit} AI questions of this period. Add 100 more or upgrade your plan.`
          : `You used all ${limit} free AI questions this month. Upgrade to continue.`,
      );
    }
    // The question's cost is followed from here, so a heavy job is charged more than one (chargeAiCost).
    if (questionKey) await this.db.insert(aiQuestionCharges).values({ accountId, questionKey });
    if (!this.enforced() || limit <= 0 || value < Math.ceil(limit * 0.8)) return null;
    const warned = await this.db
      .update(usageCounters)
      .set({ aiWarnedAt: new Date() })
      .where(
        and(
          eq(usageCounters.accountId, accountId),
          eq(usageCounters.periodStart, counterStart),
          sql`${usageCounters.aiWarnedAt} is null`,
        ),
      )
      .returning({ id: usageCounters.id });
    if (warned.length === 0) return null;
    return {
      code: "AI_QUESTIONS_WARNING",
      message: `You have used ${value} of ${limit} AI questions this period.`,
    };
  }

  /**
   * The AI could not answer the first step of a question (the provider refused, was busy or broke):
   * the customer is not charged for it. Gives back what takeAiQuestion took, and the charge row.
   */
  async refundAiQuestion(accountId: string, questionKey: string): Promise<void> {
    if (!this.enforced()) return;
    const since = new Date(Date.now() - 12 * 3_600_000);
    const [row] = await this.db
      .select()
      .from(aiQuestionCharges)
      .where(
        and(
          eq(aiQuestionCharges.accountId, accountId),
          eq(aiQuestionCharges.questionKey, questionKey),
          sql`${aiQuestionCharges.createdAt} > ${since.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(desc(aiQuestionCharges.createdAt))
      .limit(1);
    // A question that already got an answer for some steps (cost was charged) is not refunded.
    if (!row || row.costUsd > 0) return;
    const { counterStart } = await this.billing.get(accountId);
    await this.db.delete(aiQuestionCharges).where(eq(aiQuestionCharges.id, row.id));
    await this.db.execute(sql`
      update usage_counters set ai_questions = greatest(0, ai_questions - ${row.units})
      where account_id = ${accountId} and period_start = ${counterStart.toISOString()}::timestamptz`);
  }

  /**
   * A step of a question has cost this much. A question is worth 1, and one more for every further
   * AI_QUESTION_UNIT_USD it costs, so a big import counts as several. Charged as the cost builds up;
   * the answer in progress is never cut: if this takes the account over its limit, the next question
   * is the one that is refused.
   */
  async chargeAiCost(accountId: string, questionKey: string, costUsd: number): Promise<void> {
    const unit = this.config.AI_QUESTION_UNIT_USD;
    if (!this.enforced() || unit <= 0 || costUsd <= 0) return;
    const since = new Date(Date.now() - 12 * 3_600_000);
    const [row] = await this.db
      .select()
      .from(aiQuestionCharges)
      .where(
        and(
          eq(aiQuestionCharges.accountId, accountId),
          eq(aiQuestionCharges.questionKey, questionKey),
          sql`${aiQuestionCharges.createdAt} > ${since.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(desc(aiQuestionCharges.createdAt))
      .limit(1);
    if (!row) return;
    const cost = row.costUsd + costUsd;
    const units = Math.max(1, Math.ceil(cost / unit - 1e-9));
    await this.db
      .update(aiQuestionCharges)
      .set({ costUsd: cost, units: Math.max(units, row.units) })
      .where(eq(aiQuestionCharges.id, row.id));
    if (units > row.units) await this.bump(accountId, "ai_questions", units - row.units, null);
  }

  /** Throws when the plan has no Excel export (the desktop also greys the button out). */
  async assertFeature(accountId: string, feature: "excelExport"): Promise<void> {
    const { entitlements } = await this.billing.get(accountId);
    if (this.enforced() && !entitlements.features[feature]) {
      throw limitError("FEATURE_UNAVAILABLE", "Excel export is available on Start and above");
    }
  }
}

function companyView(c: typeof companies.$inferSelect): CompanyView {
  return {
    id: c.id,
    inn: c.inn,
    name: c.name,
    readOnly: c.readOnly,
    connectedAt: c.connectedAt.toISOString(),
  };
}
