/**
 * The public offer ("Ommaviy oferta"): its version, and what the cabinet and the server say about it. A plan, an add-on or
 * credits can be bought only after the account's owner has accepted the current version.
 */
import { z } from "zod";

/** The date of the text (it changes when the text does, and everyone is asked again). */
export const OFFER_VERSION = "2026-10-30";

export const OfferStatus = z.object({
  version: z.string(),
  /** The signed-in account's owner accepted this version. */
  accepted: z.boolean(),
  acceptedAt: z.string().nullable(),
  /** Whether a purchase is refused without it (a deployment can switch the check off). */
  required: z.boolean(),
});
export type OfferStatus = z.infer<typeof OfferStatus>;

export const AcceptOfferInput = z.object({
  version: z.string().min(1).max(40),
  /** The language the text was shown in. */
  locale: z.enum(["uz", "ru"]),
});
export type AcceptOfferInput = z.infer<typeof AcceptOfferInput>;
