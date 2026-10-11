/**
 * Payme Merchant API (JSON-RPC over HTTPS, called by Payme). Written from Payme's published
 * protocol as we know it: CheckPerformTransaction, CreateTransaction, PerformTransaction,
 * CancelTransaction, CheckTransaction, GetStatement; Basic auth "Paycom:<key>"; amounts in tiyin
 * (1 sum = 100 tiyin); the account carries our invoice number. The method names, error codes and
 * the checkout link MUST be checked against Payme's current documentation and passed in their
 * sandbox before going live (docs/billing.md).
 */
import { timingSafeEqual } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { invoices, payments } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import type { Invoicing } from "./invoicing.js";

/** A pending transaction nobody finished is cancelled after 12 hours. */
export const PAYME_TIMEOUT_MS = 12 * 60 * 60 * 1000;

export function paymeCheckoutUrl(
  config: Pick<Config, "PAYME_MERCHANT_ID" | "PAYME_TEST" | "SITE_URL">,
  invoice: { number: number | null; totalSum: number },
): string {
  const params = [
    `m=${config.PAYME_MERCHANT_ID ?? ""}`,
    `ac.invoice_id=${invoice.number ?? 0}`,
    `a=${invoice.totalSum * 100}`,
    ...(config.SITE_URL ? [`c=${config.SITE_URL}/cabinet`] : []),
  ].join(";");
  const host = config.PAYME_TEST ? "https://test.paycom.uz" : "https://checkout.paycom.uz";
  return `${host}/${Buffer.from(params).toString("base64")}`;
}

interface RpcRequest {
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
}

interface RpcError {
  code: number;
  message: { ru: string; uz: string; en: string };
  data?: string;
}

const msg = (en: string, ru = en, uz = en) => ({ en, ru, uz });
const ERR = {
  privilege: {
    code: -32504,
    message: msg("Insufficient privileges", "Недостаточно привилегий", "Huquqlar yetarli emas"),
  },
  method: { code: -32601, message: msg("Method not found", "Метод не найден", "Metod topilmadi") },
  request: { code: -32600, message: msg("Invalid request", "Неверный запрос", "Notoʻgʻri soʻrov") },
  amount: { code: -31001, message: msg("Wrong amount", "Неверная сумма", "Notoʻgʻri summa") },
  noTransaction: {
    code: -31003,
    message: msg("Transaction not found", "Транзакция не найдена", "Tranzaksiya topilmadi"),
  },
  cannotCancel: {
    code: -31007,
    message: msg(
      "The order is completed and cannot be cancelled",
      "Заказ выполнен. Невозможно отменить",
      "Buyurtma bajarilgan, bekor qilib boʻlmaydi",
    ),
  },
  cannotPerform: {
    code: -31008,
    message: msg(
      "Unable to perform this operation",
      "Невозможно выполнить операцию",
      "Operatsiyani bajarib boʻlmaydi",
    ),
  },
  noInvoice: {
    code: -31050,
    message: msg("Invoice not found", "Счёт не найден", "Hisob topilmadi"),
    data: "invoice_id",
  },
  invoiceState: {
    code: -31051,
    message: msg("The invoice cannot be paid", "Счёт нельзя оплатить", "Hisobni toʻlab boʻlmaydi"),
    data: "invoice_id",
  },
  busy: {
    code: -31099,
    message: msg(
      "The invoice has another transaction in progress",
      "По счёту уже есть транзакция",
      "Hisob boʻyicha boshqa tranzaksiya bor",
    ),
    data: "invoice_id",
  },
} satisfies Record<string, RpcError>;

class RpcFailure extends Error {
  constructor(readonly error: RpcError) {
    super(error.message.en);
  }
}

/** Payme's transaction states. */
const CREATED = 1;
const PERFORMED = 2;
const CANCELLED = -1;
const CANCELLED_AFTER = -2;

interface Raw extends Record<string, unknown> {
  account: string;
  amount: number;
  time: number;
  create_time: number;
  perform_time: number;
  cancel_time: number;
  reason: number | null;
  /** The number we gave back as "transaction". */
  transaction: string;
}

export class PaymeMerchant {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly invoicing: Invoicing,
  ) {}

  enabled(): boolean {
    return Boolean(this.config.PAYME_MERCHANT_ID && this.config.PAYME_KEY);
  }

  /** Basic "Paycom:<key>". */
  authorized(header: string | undefined): boolean {
    const key = this.config.PAYME_KEY;
    if (!key || !header?.startsWith("Basic ")) return false;
    const given = Buffer.from(header.slice(6), "base64");
    const wanted = Buffer.from(`Paycom:${key}`);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  }

  /** One JSON-RPC call. Errors are answered with HTTP 200 and an "error" member, as Payme expects. */
  async handle(
    authHeader: string | undefined,
    body: unknown,
    now = Date.now(),
  ): Promise<Record<string, unknown>> {
    const request = (body ?? {}) as RpcRequest;
    const id = request.id ?? null;
    try {
      if (!this.enabled() || !this.authorized(authHeader)) throw new RpcFailure(ERR.privilege);
      if (
        typeof request.method !== "string" ||
        typeof request.params !== "object" ||
        request.params === null
      ) {
        throw new RpcFailure(ERR.request);
      }
      const p = request.params;
      switch (request.method) {
        case "CheckPerformTransaction":
          return { id, result: await this.check(p) };
        case "CreateTransaction":
          return { id, result: await this.create(p, now) };
        case "PerformTransaction":
          return { id, result: await this.perform(p, now) };
        case "CancelTransaction":
          return { id, result: await this.cancel(p, now) };
        case "CheckTransaction":
          return { id, result: await this.checkTransaction(p) };
        case "GetStatement":
          return { id, result: await this.statement(p) };
        default:
          throw new RpcFailure(ERR.method);
      }
    } catch (e) {
      if (e instanceof RpcFailure) return { id, error: e.error };
      throw e;
    }
  }

  /** The invoice an account points to, and whether the amount is exactly its total. */
  private async payable(params: Record<string, unknown>) {
    const account = (params.account ?? {}) as Record<string, unknown>;
    const number = Number(account.invoice_id);
    if (!Number.isInteger(number)) throw new RpcFailure(ERR.noInvoice);
    const invoice = await this.db.query.invoices.findFirst({ where: eq(invoices.number, number) });
    if (!invoice) throw new RpcFailure(ERR.noInvoice);
    // A late payment of an expired invoice is accepted; a paid or cancelled one is not payable.
    if (invoice.status === "paid" || invoice.status === "cancelled") throw new RpcFailure(ERR.invoiceState);
    if (Number(params.amount) !== invoice.totalSum * 100) throw new RpcFailure(ERR.amount);
    return invoice;
  }

  private async check(params: Record<string, unknown>) {
    await this.payable(params);
    return { allow: true };
  }

  private async create(params: Record<string, unknown>, now: number) {
    const paymeId = String(params.id ?? "");
    const existing = await this.db.query.payments.findFirst({ where: eq(payments.providerTxnId, paymeId) });
    if (existing) {
      const raw = existing.raw as Raw;
      if (Number(existing.state) === CREATED && now - raw.create_time > PAYME_TIMEOUT_MS) {
        await this.setState(existing.id, CANCELLED, raw, { cancel_time: now, reason: 4 });
        throw new RpcFailure(ERR.cannotPerform);
      }
      if (Number(existing.state) !== CREATED) throw new RpcFailure(ERR.cannotPerform);
      return { create_time: raw.create_time, transaction: raw.transaction, state: CREATED };
    }
    const invoice = await this.payable(params);
    // One open transaction per invoice.
    const open = await this.db.query.payments.findMany({ where: eq(payments.invoiceId, invoice.id) });
    for (const other of open) {
      const raw = other.raw as Raw;
      if (Number(other.state) === CREATED && now - raw.create_time <= PAYME_TIMEOUT_MS) {
        throw new RpcFailure(ERR.busy);
      }
    }
    const raw: Raw = {
      account: String(invoice.number),
      amount: Number(params.amount),
      time: Number(params.time),
      create_time: now,
      perform_time: 0,
      cancel_time: 0,
      reason: null,
      transaction: invoice.id,
    };
    await this.db.insert(payments).values({
      invoiceId: invoice.id,
      provider: "payme",
      providerTxnId: paymeId,
      amountSum: invoice.totalSum,
      state: String(CREATED),
      raw,
    });
    return { create_time: now, transaction: raw.transaction, state: CREATED };
  }

  private async find(params: Record<string, unknown>) {
    const row = await this.db.query.payments.findFirst({
      where: and(eq(payments.providerTxnId, String(params.id ?? "")), eq(payments.provider, "payme")),
    });
    if (!row) throw new RpcFailure(ERR.noTransaction);
    return row;
  }

  private async setState(id: string, state: number, raw: Raw, patch: Partial<Raw>) {
    await this.db
      .update(payments)
      .set({ state: String(state), raw: { ...raw, ...patch } })
      .where(eq(payments.id, id));
  }

  private async perform(params: Record<string, unknown>, now: number) {
    const row = await this.find(params);
    const raw = row.raw as Raw;
    const state = Number(row.state);
    if (state === PERFORMED) return { transaction: raw.transaction, perform_time: raw.perform_time, state };
    if (state !== CREATED) throw new RpcFailure(ERR.cannotPerform);
    if (now - raw.create_time > PAYME_TIMEOUT_MS) {
      await this.setState(row.id, CANCELLED, raw, { cancel_time: now, reason: 4 });
      throw new RpcFailure(ERR.cannotPerform);
    }
    try {
      await this.invoicing.applyInvoice(row.invoiceId, new Date(now), {
        provider: "payme",
        ref: row.providerTxnId,
      });
    } catch (e) {
      if (e instanceof HttpError) throw new RpcFailure(ERR.cannotPerform);
      throw e;
    }
    await this.setState(row.id, PERFORMED, raw, { perform_time: now });
    return { transaction: raw.transaction, perform_time: now, state: PERFORMED };
  }

  private async cancel(params: Record<string, unknown>, now: number) {
    const row = await this.find(params);
    const raw = row.raw as Raw;
    const state = Number(row.state);
    const reason = Number(params.reason ?? 0);
    if (state === CANCELLED || state === CANCELLED_AFTER) {
      return { transaction: raw.transaction, cancel_time: raw.cancel_time, state };
    }
    // Once the plan was extended it is not taken back automatically: refunds are made by hand.
    if (state === PERFORMED) throw new RpcFailure(ERR.cannotCancel);
    await this.setState(row.id, CANCELLED, raw, { cancel_time: now, reason });
    return { transaction: raw.transaction, cancel_time: now, state: CANCELLED };
  }

  private async checkTransaction(params: Record<string, unknown>) {
    const row = await this.find(params);
    const raw = row.raw as Raw;
    return {
      create_time: raw.create_time,
      perform_time: raw.perform_time,
      cancel_time: raw.cancel_time,
      transaction: raw.transaction,
      state: Number(row.state),
      reason: raw.reason,
    };
  }

  private async statement(params: Record<string, unknown>) {
    const from = Number(params.from);
    const to = Number(params.to);
    const rows = await this.db.query.payments.findMany({ where: eq(payments.provider, "payme") });
    return {
      transactions: rows
        .map((row) => ({ row, raw: row.raw as Raw }))
        .filter(({ raw }) => raw.time >= from && raw.time <= to)
        .map(({ row, raw }) => ({
          id: row.providerTxnId,
          time: raw.time,
          amount: raw.amount,
          account: { invoice_id: raw.account },
          create_time: raw.create_time,
          perform_time: raw.perform_time,
          cancel_time: raw.cancel_time,
          transaction: raw.transaction,
          state: Number(row.state),
          reason: raw.reason,
        })),
    };
  }
}
