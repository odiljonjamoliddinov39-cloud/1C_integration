import { OFFER_VERSION, type OfferStatus } from "@platform/shared";
import { and, eq } from "drizzle-orm";

import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { offerAcceptances } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";

/** The public offer: the owner accepts its current version once; buying is refused until then. */
export class Offers {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  get required(): boolean {
    return this.config.OFFER_REQUIRED === "on";
  }

  async status(accountId: string): Promise<OfferStatus> {
    const [row] = await this.db
      .select()
      .from(offerAcceptances)
      .where(and(eq(offerAcceptances.accountId, accountId), eq(offerAcceptances.version, OFFER_VERSION)));
    return {
      version: OFFER_VERSION,
      accepted: Boolean(row),
      acceptedAt: row?.acceptedAt.toISOString() ?? null,
      required: this.required,
    };
  }

  /** Writes the acceptance of the current version (once: a second one keeps the first). */
  async accept(
    accountId: string,
    userId: string,
    input: { version: string; locale: "uz" | "ru" },
    meta: { ip?: string | undefined; userAgent?: string | undefined },
  ): Promise<OfferStatus> {
    if (input.version !== OFFER_VERSION) {
      throw new HttpError(409, "OFFER_CHANGED", "The offer was updated: read the new text and accept it");
    }
    await this.db
      .insert(offerAcceptances)
      .values({
        accountId,
        userId,
        version: input.version,
        locale: input.locale,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
      })
      .onConflictDoNothing();
    return this.status(accountId);
  }

  /** Before a purchase. */
  async require(accountId: string): Promise<void> {
    if (!this.required) return;
    if (!(await this.status(accountId)).accepted) {
      throw new HttpError(409, "OFFER_NOT_ACCEPTED", "Accept the public offer before you buy");
    }
  }
}
