/**
 * Buying more AI credits goes through an admin: the customer asks, the request waits in the dashboard, and an admin
 * approves it (the credits are added, with an invoice marked paid for the books) or rejects it. Also "Restart payments":
 * an admin clears a customer's unfinished payments so the customer can begin again.
 */
import {
  type AdminCreditRequest,
  type AdminCreditRequestsResponse,
  type AdminRestartPaymentsResult,
  type CreditRequestView,
  topupCredits,
} from "@platform/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { accounts, creditAccounts, creditRequests, invoices, users } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import type { Credits } from "./credits.js";
import type { Invoicing } from "./invoicing.js";

/** A customer may have this many requests waiting at once. */
export const MAX_PENDING_REQUESTS = 3;

type RequestRow = typeof creditRequests.$inferSelect;

export function requestView(row: RequestRow): CreditRequestView {
  return {
    id: row.id,
    credits: row.credits,
    somPerCredit: row.somPerCredit,
    totalSom: row.paidSum,
    status: row.status,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

/** The customer's own latest requests, newest first. */
export async function requestsOf(db: Db, accountId: string, limit = 10): Promise<CreditRequestView[]> {
  const rows = await db
    .select()
    .from(creditRequests)
    .where(eq(creditRequests.accountId, accountId))
    .orderBy(desc(creditRequests.createdAt))
    .limit(limit);
  return rows.map(requestView);
}

export class CreditRequests {
  constructor(
    private readonly db: Db,
    private readonly credits: Credits,
    private readonly invoicing: Invoicing,
  ) {}

  /** The customer asks to top up the extra balance by `sum` soum: the AI balance it gives is worked out at today's price. */
  async create(accountId: string, userId: string | null, sum: number): Promise<CreditRequestView> {
    const { somPerCredit } = await this.credits.price();
    const credits = topupCredits(sum, somPerCredit);
    await this.credits.assertCanBuy(accountId, credits);
    const [pending] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(creditRequests)
      .where(and(eq(creditRequests.accountId, accountId), eq(creditRequests.status, "pending")));
    if ((pending?.n ?? 0) >= MAX_PENDING_REQUESTS)
      throw new HttpError(
        409,
        "TOO_MANY_REQUESTS",
        "You already have requests waiting for approval: wait for an answer first",
      );
    const [row] = await this.db
      .insert(creditRequests)
      .values({ accountId, userId, credits, somPerCredit, paidSum: sum })
      .returning();
    if (!row) throw new HttpError(500, "INTERNAL", "The request was not saved");
    return requestView(row);
  }

  /** The customer takes back a request that is still waiting. */
  async cancel(accountId: string, id: string): Promise<CreditRequestView> {
    const [row] = await this.db
      .update(creditRequests)
      .set({ status: "cancelled", decidedAt: new Date() })
      .where(
        and(
          eq(creditRequests.id, id),
          eq(creditRequests.accountId, accountId),
          eq(creditRequests.status, "pending"),
        ),
      )
      .returning();
    if (!row) throw new HttpError(409, "NOT_PENDING", "This request is not waiting any more");
    return requestView(row);
  }

  async pendingCount(): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(creditRequests)
      .where(eq(creditRequests.status, "pending"));
    return row?.n ?? 0;
  }

  /** The dashboard's list: everything waiting (oldest first), then the latest decided. One account when `accountId` is given. */
  async adminList(accountId?: string): Promise<AdminCreditRequestsResponse> {
    const base = () =>
      this.db
        .select({
          r: creditRequests,
          name: accounts.name,
          email: users.email,
          balance: creditAccounts.extraCredits,
        })
        .from(creditRequests)
        .innerJoin(accounts, eq(accounts.id, creditRequests.accountId))
        .leftJoin(users, eq(users.id, creditRequests.userId))
        .leftJoin(creditAccounts, eq(creditAccounts.accountId, creditRequests.accountId));
    const scope = accountId ? eq(creditRequests.accountId, accountId) : undefined;
    const waiting = await base()
      .where(and(scope, eq(creditRequests.status, "pending")))
      .orderBy(asc(creditRequests.createdAt))
      .limit(200);
    const decided = await base()
      .where(and(scope, sql`${creditRequests.status} <> 'pending'`))
      .orderBy(desc(creditRequests.createdAt))
      .limit(accountId ? 20 : 50);
    const view = (x: (typeof waiting)[number]): AdminCreditRequest => ({
      ...requestView(x.r),
      accountId: x.r.accountId,
      accountName: x.name,
      userEmail: x.email,
      balanceCredits: Math.floor(x.balance ?? 0),
      decidedBy: x.r.decidedBy,
    });
    return {
      pendingCount: accountId ? waiting.length : await this.pendingCount(),
      requests: [...waiting, ...decided].map(view),
    };
  }

  /**
   * The admin approves: the credits are added at the price of the request, through an invoice marked paid (so the
   * revenue and the customer's invoice list are right). Approving twice does nothing the second time.
   */
  async approve(id: string, adminId: string, note: string | undefined, now = new Date()) {
    const [claimed] = await this.db
      .update(creditRequests)
      .set({ status: "approved", decidedBy: adminId, decidedAt: now, note: note ?? null })
      .where(and(eq(creditRequests.id, id), eq(creditRequests.status, "pending")))
      .returning();
    if (!claimed) await this.missing(id);
    const row = claimed as RequestRow;
    let invoiceId: string | null = null;
    try {
      await this.credits.assertCanBuy(row.accountId, row.credits);
      const quote = await this.invoicing.creditsQuote(
        row.accountId,
        row.credits,
        row.somPerCredit,
        row.paidSum,
      );
      const invoice = await this.invoicing.createInvoice(row.accountId, quote, "bank", undefined, now);
      invoiceId = invoice.id;
      await this.invoicing.applyInvoice(invoice.id, now, { provider: "bank", ref: `request:${row.id}` });
      await this.db.update(creditRequests).set({ invoiceId }).where(eq(creditRequests.id, id));
    } catch (e) {
      // Nothing was added: the request goes back to waiting and the half-made invoice is dropped.
      await this.db
        .update(creditRequests)
        .set({ status: "pending", decidedBy: null, decidedAt: null, note: null })
        .where(eq(creditRequests.id, id));
      if (invoiceId)
        await this.db
          .update(invoices)
          .set({ status: "cancelled" })
          .where(and(eq(invoices.id, invoiceId), eq(invoices.status, "pending")));
      throw e;
    }
    return { accountId: row.accountId, credits: row.credits };
  }

  async reject(id: string, adminId: string, note: string | undefined, now = new Date()) {
    const [row] = await this.db
      .update(creditRequests)
      .set({ status: "rejected", decidedBy: adminId, decidedAt: now, note: note ?? null })
      .where(and(eq(creditRequests.id, id), eq(creditRequests.status, "pending")))
      .returning();
    if (!row) await this.missing(id);
    const done = row as RequestRow;
    return { accountId: done.accountId, credits: done.credits };
  }

  /** Why a request could not be decided: it does not exist, or someone already decided it. */
  private async missing(id: string): Promise<never> {
    const [row] = await this.db.select().from(creditRequests).where(eq(creditRequests.id, id));
    if (!row) throw new HttpError(404, "NOT_FOUND", "No such request");
    throw new HttpError(409, "NOT_PENDING", `This request was already ${row.status}`);
  }

  /**
   * "Restart payments": the customer's unpaid invoices and waiting requests are cancelled, so a purchase can begin again
   * from nothing. Paid invoices, the balance and its history stay as they are.
   */
  async restartPayments(
    accountId: string,
    adminId: string,
    now = new Date(),
  ): Promise<AdminRestartPaymentsResult> {
    const account = await this.db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
    if (!account) throw new HttpError(404, "NOT_FOUND", "No such account");
    const cancelledInvoices = await this.invoicing.cancelPending(accountId);
    const requests = await this.db
      .update(creditRequests)
      .set({
        status: "cancelled",
        decidedBy: adminId,
        decidedAt: now,
        note: "Payments restarted by an admin",
      })
      .where(and(eq(creditRequests.accountId, accountId), eq(creditRequests.status, "pending")))
      .returning({ id: creditRequests.id });
    return { cancelledInvoices, cancelledRequests: requests.length };
  }
}
