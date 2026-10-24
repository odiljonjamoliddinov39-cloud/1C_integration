/**
 * Click SHOP API (Click calls us over HTTPS with application/x-www-form-urlencoded and expects JSON), written from Click's
 * "SHOP API" pages: two requests, Prepare (action 0) and Complete (action 1), signed with MD5 over the request's own values
 * and the service's secret key; the order is our invoice (merchant_trans_id = the invoice number), the amount is in sum.
 *
 *   Prepare:  md5(click_trans_id + service_id + SECRET + merchant_trans_id + amount + action + sign_time)
 *   Complete: md5(click_trans_id + service_id + SECRET + merchant_trans_id + merchant_prepare_id + amount + action + sign_time)
 *
 * The card is entered on Click's own page or window (the link or checkout.js): nothing of the card reaches us, only the
 * numbers of the payment and its amount. Errors are answered on a 200 with `error` and `error_note`, as Click's table has them.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { invoices, payments } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import type { Invoicing } from "./invoicing.js";

/** Click's error codes of the provider's side. */
const ERR = {
  ok: { error: 0, error_note: "Success" },
  sign: { error: -1, error_note: "SIGN CHECK FAILED!" },
  amount: { error: -2, error_note: "Incorrect parameter amount" },
  action: { error: -3, error_note: "Action not found" },
  paid: { error: -4, error_note: "Already paid" },
  order: { error: -5, error_note: "User does not exist" },
  transaction: { error: -6, error_note: "Transaction does not exist" },
  update: { error: -7, error_note: "Failed to update user" },
  request: { error: -8, error_note: "Error in request from click" },
  cancelled: { error: -9, error_note: "Transaction cancelled" },
} as const;

type Answer = Record<string, unknown>;
type Body = Record<string, unknown>;

/** A payment's states here. */
const PREPARED = 1;
const COMPLETED = 2;
const CANCELLED = -1;

interface Raw extends Record<string, unknown> {
  click_trans_id: string;
  click_paydoc_id: string;
  merchant_trans_id: string;
  amount: number;
  prepare_id: number;
  confirm_id: number;
  sign_time: string;
}

export const clickEnabled = (
  config: Pick<Config, "CLICK_SERVICE_ID" | "CLICK_MERCHANT_ID" | "CLICK_SECRET_KEY">,
): boolean => Boolean(config.CLICK_SERVICE_ID && config.CLICK_MERCHANT_ID && config.CLICK_SECRET_KEY);

/** The amount as Click's link wants it: sum with two decimals ("N.NN"). */
const money = (sum: number) => sum.toFixed(2);

/** What the page needs to open Click's payment: the link, and the values of its in-page window (checkout.js). */
export function clickCheckout(
  config: Pick<Config, "CLICK_SERVICE_ID" | "CLICK_MERCHANT_ID" | "CLICK_MERCHANT_USER_ID" | "SITE_URL">,
  invoice: { number: number | null; totalSum: number },
) {
  const values = {
    serviceId: config.CLICK_SERVICE_ID ?? "",
    merchantId: config.CLICK_MERCHANT_ID ?? "",
    ...(config.CLICK_MERCHANT_USER_ID ? { merchantUserId: config.CLICK_MERCHANT_USER_ID } : {}),
    amount: money(invoice.totalSum),
    transactionParam: String(invoice.number ?? 0),
  };
  const query = new URLSearchParams({
    service_id: values.serviceId,
    merchant_id: values.merchantId,
    ...(values.merchantUserId ? { merchant_user_id: values.merchantUserId } : {}),
    amount: values.amount,
    transaction_param: values.transactionParam,
    ...(config.SITE_URL ? { return_url: `${config.SITE_URL}/cabinet` } : {}),
  });
  return { url: `https://my.click.uz/services/pay?${query.toString()}`, values };
}

const text = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

export class ClickMerchant {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly invoicing: Invoicing,
  ) {}

  enabled(): boolean {
    return clickEnabled(this.config);
  }

  /** The signature of a request, from the values exactly as Click sent them. */
  private signature(body: Body, withPrepareId: boolean): string {
    return createHash("md5")
      .update(
        text(body.click_trans_id) +
          text(body.service_id) +
          (this.config.CLICK_SECRET_KEY ?? "") +
          text(body.merchant_trans_id) +
          (withPrepareId ? text(body.merchant_prepare_id) : "") +
          text(body.amount) +
          text(body.action) +
          text(body.sign_time),
      )
      .digest("hex");
  }

  private signed(body: Body, withPrepareId: boolean): boolean {
    const given = Buffer.from(text(body.sign_string).toLowerCase());
    const wanted = Buffer.from(this.signature(body, withPrepareId));
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  }

  /** Common checks of both requests: the signature, the service, the action and the fields; null when all is well. */
  private refuse(body: Body, action: 0 | 1): Answer | null {
    if (!this.enabled()) return ERR.request;
    if (!this.signed(body, action === 1)) return ERR.sign;
    if (text(body.service_id) !== this.config.CLICK_SERVICE_ID) return ERR.request;
    if (text(body.action) !== String(action)) return ERR.action;
    const needed = [
      "click_trans_id",
      "merchant_trans_id",
      "amount",
      "sign_time",
      ...(action === 1 ? ["merchant_prepare_id"] : []),
    ];
    if (needed.some((key) => text(body[key]) === "")) return ERR.request;
    return null;
  }

  private async invoiceOf(body: Body) {
    const number = text(body.merchant_trans_id);
    if (!/^\d{1,9}$/.test(number)) return null;
    return (await this.db.query.invoices.findFirst({ where: eq(invoices.number, Number(number)) })) ?? null;
  }

  /** Prepare: the order exists, is not paid, and the amount is its total; the payment is recorded and "reserved". */
  async prepare(body: Body): Promise<Answer> {
    const refused = this.refuse(body, 0);
    const reply = (extra: Answer) => ({
      click_trans_id: Number(text(body.click_trans_id)) || text(body.click_trans_id),
      merchant_trans_id: text(body.merchant_trans_id),
      ...extra,
    });
    if (refused) return reply(refused);
    // A negative status from Click itself: the payment is cancelled on our side.
    if (Number(text(body.error)) < 0) return reply(ERR.cancelled);
    const invoice = await this.invoiceOf(body);
    if (!invoice || invoice.status === "cancelled") return reply(ERR.order);
    if (invoice.status === "paid") return reply(ERR.paid);
    if (Math.abs(Number(text(body.amount)) - invoice.totalSum) > 0.004) return reply(ERR.amount);

    const key = `click:${text(body.click_trans_id)}`;
    const existing = await this.db.query.payments.findFirst({ where: eq(payments.providerTxnId, key) });
    if (existing) {
      const raw = existing.raw as Raw;
      const state = Number(existing.state);
      if (state === COMPLETED) return reply(ERR.paid);
      if (state === CANCELLED) return reply(ERR.cancelled);
      return reply({ ...ERR.ok, merchant_prepare_id: raw.prepare_id });
    }
    // The number of the payment in our billing: the invoice number and the attempt (a customer may try again).
    const before = (
      await this.db.query.payments.findMany({
        where: and(eq(payments.invoiceId, invoice.id), eq(payments.provider, "click")),
      })
    ).length;
    const prepareId = (invoice.number ?? 0) * 1000 + Math.min(before + 1, 999);
    const raw: Raw = {
      click_trans_id: text(body.click_trans_id),
      click_paydoc_id: text(body.click_paydoc_id),
      merchant_trans_id: text(body.merchant_trans_id),
      amount: Number(text(body.amount)),
      prepare_id: prepareId,
      confirm_id: 0,
      sign_time: text(body.sign_time),
    };
    await this.db.insert(payments).values({
      invoiceId: invoice.id,
      provider: "click",
      providerTxnId: key,
      amountSum: invoice.totalSum,
      state: String(PREPARED),
      raw,
    });
    return reply({ ...ERR.ok, merchant_prepare_id: prepareId });
  }

  /** Complete: the money was taken; the invoice is paid and the plan is applied once. */
  async complete(body: Body, now = new Date()): Promise<Answer> {
    const refused = this.refuse(body, 1);
    const reply = (extra: Answer) => ({
      click_trans_id: Number(text(body.click_trans_id)) || text(body.click_trans_id),
      merchant_trans_id: text(body.merchant_trans_id),
      ...extra,
    });
    if (refused) return reply(refused);
    const row = await this.db.query.payments.findFirst({
      where: eq(payments.providerTxnId, `click:${text(body.click_trans_id)}`),
    });
    const raw = row?.raw as Raw | undefined;
    if (!row || !raw || String(raw.prepare_id) !== text(body.merchant_prepare_id))
      return reply(ERR.transaction);
    if (raw.merchant_trans_id !== text(body.merchant_trans_id)) return reply(ERR.order);
    const state = Number(row.state);
    // Click reports an error of its own (the card was refused): the prepared payment is cancelled.
    if (Number(text(body.error)) < 0) {
      if (state === PREPARED) await this.setState(row.id, CANCELLED, raw, {});
      return reply(state === COMPLETED ? ERR.paid : ERR.cancelled);
    }
    if (state === COMPLETED) return reply(ERR.paid);
    if (state === CANCELLED) return reply(ERR.cancelled);
    if (Math.abs(Number(text(body.amount)) - row.amountSum) > 0.004) return reply(ERR.amount);
    try {
      const done = await this.invoicing.applyInvoice(row.invoiceId, now, {
        provider: "click",
        ref: row.providerTxnId,
      });
      // The invoice was paid another way meanwhile: the customer has paid twice; it is for a person to refund (Click's
      // reversal), and the transaction is closed so that it is not applied again.
      if (!done.applied) {
        const invoice = await this.db.query.invoices.findFirst({ where: eq(invoices.id, row.invoiceId) });
        if (invoice)
          await this.invoicing.event(invoice.accountId, "duplicate_payment", {
            provider: "click",
            payment: row.providerTxnId,
            amount: row.amountSum,
          });
        await this.setState(row.id, CANCELLED, raw, {});
        return reply(ERR.paid);
      }
    } catch (e) {
      if (e instanceof HttpError) return reply(ERR.update);
      throw e;
    }
    await this.setState(row.id, COMPLETED, raw, { confirm_id: raw.prepare_id });
    return reply({ ...ERR.ok, merchant_confirm_id: raw.prepare_id });
  }

  private async setState(id: string, state: number, raw: Raw, patch: Partial<Raw>) {
    await this.db
      .update(payments)
      .set({ state: String(state), raw: { ...raw, ...patch } })
      .where(eq(payments.id, id));
  }
}
