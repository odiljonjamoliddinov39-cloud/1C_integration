/**
 * The price of a credit in soum, kept in step with the CBU's USD rate (TZ §10): a daily check, a new price when the rate has
 * moved 5% from the rate the last price was set at, every change in credit_rate_history, and an admin can set a price by hand.
 */
import { RATE_CHANGE_SHARE, somPerCreditOf } from "@platform/shared";
import { desc } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { creditRateHistory } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";

export const CBU_USD_URL = "https://cbu.uz/uz/arkhiv-kursov-valyut/json/USD/";

/** The CBU's USD rate (soum per dollar); null when its answer cannot be read. */
export async function fetchCbuRate(fetcher: typeof fetch = fetch): Promise<number | null> {
  const response = await fetcher(CBU_USD_URL, { headers: { accept: "application/json" } });
  if (!response.ok) return null;
  const body = (await response.json()) as unknown;
  const first = Array.isArray(body) ? (body[0] as { Rate?: unknown } | undefined) : undefined;
  const rate = Number(String(first?.Rate ?? "").replace(",", "."));
  return Number.isFinite(rate) && rate > 1_000 && rate < 100_000 ? rate : null;
}

export class CreditRates {
  constructor(
    private readonly db: Db,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async latest() {
    const [row] = await this.db
      .select()
      .from(creditRateHistory)
      .orderBy(desc(creditRateHistory.createdAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * Today's check. A new price is written only when the CBU rate is 5% or more away from the rate of the last change.
   * Returns the new price, or null when nothing changed (or the CBU could not be read).
   */
  async refresh(): Promise<number | null> {
    const rate = await fetchCbuRate(this.fetcher).catch(() => null);
    if (rate === null) return null;
    const last = await this.latest();
    if (!last) return null;
    const moved = Math.abs(rate - last.cbuRate) / last.cbuRate;
    if (moved < RATE_CHANGE_SHARE) return null;
    const price = somPerCreditOf(rate);
    await this.db.insert(creditRateHistory).values({
      oldSomPerCredit: last.newSomPerCredit,
      newSomPerCredit: price,
      cbuRate: rate,
      setBy: "system",
      note: `The CBU rate moved ${(moved * 100).toFixed(1)}% (${last.cbuRate} → ${rate})`,
    });
    return price;
  }

  /** An admin sets the price by hand (a promotion, a correction); it stays until the CBU rate moves 5% from now. */
  async setManual(adminId: string, somPerCredit: number, reason: string): Promise<void> {
    const last = await this.latest();
    if (!last) throw new HttpError(500, "INTERNAL", "The credit price is not set");
    const rate = (await fetchCbuRate(this.fetcher).catch(() => null)) ?? last.cbuRate;
    await this.db.insert(creditRateHistory).values({
      oldSomPerCredit: last.newSomPerCredit,
      newSomPerCredit: somPerCredit,
      cbuRate: rate,
      setBy: adminId,
      note: reason,
    });
  }
}

/** Checks the rate a little after start-up and then every day. Returns the function that stops it. */
export function startRateJob(
  rates: CreditRates,
  log: { error: (obj: unknown, msg?: string) => void },
): () => void {
  const run = () => {
    rates.refresh().catch((error: unknown) => log.error(error, "The credit price check failed"));
  };
  const first = setTimeout(run, 60_000);
  const daily = setInterval(run, 24 * 3_600_000);
  first.unref();
  daily.unref();
  return () => {
    clearTimeout(first);
    clearInterval(daily);
  };
}
