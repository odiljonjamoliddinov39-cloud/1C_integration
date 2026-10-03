/**
 * The normalized item every source produces (TD §6): Didox, Soliq, bank files all map to this
 * before matching, mapping and review. Used from phase 1 on.
 */
import { z } from "zod";

import { Inn } from "./platform-api.js";

export const SOURCE_IDS = ["didox", "soliq-service", "soliq-file", "bank-file", "bank-api"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export const SourceItemLine = z.object({
  item: z.string(),
  ikpu: z.string().optional(),
  unit: z.string().optional(),
  quantity: z.number(),
  price: z.number(),
  vatRate: z.number(),
  vatSum: z.number(),
  total: z.number(),
});

export const SourceItem = z.object({
  source: z.enum(SOURCE_IDS),
  type: z.enum(["invoice_in", "invoice_out", "bank_in", "bank_out"]),
  externalId: z.string(),
  date: z.string(),
  number: z.string(),
  counterparty: z.object({ inn: Inn.or(z.literal("")), name: z.string() }),
  contract: z.object({ number: z.string(), date: z.string().optional() }).optional(),
  lines: z.array(SourceItemLine),
  /** Original payload, kept for the audit trail. */
  raw: z.unknown(),
});
export type SourceItem = z.infer<typeof SourceItem>;
