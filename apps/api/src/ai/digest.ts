/**
 * The metadata digest: a compact description of a company's 1C structure (objects, their
 * attributes, the registers it uses), built by the desktop once per configuration version and kept
 * here. It goes into the prompt after the tools, so the model rarely needs to ask 1C what exists.
 */
import { and, desc, eq } from "drizzle-orm";

import type { DigestInput, DigestKey } from "@platform/shared";

import type { Db } from "../db/client.js";
import { metadataDigests } from "../db/schema.js";

/** The latest digest of the company. */
export async function latestDigest(db: Db, accountId: string, company: string) {
  const [row] = await db
    .select()
    .from(metadataDigests)
    .where(and(eq(metadataDigests.accountId, accountId), eq(metadataDigests.company, company)))
    .orderBy(desc(metadataDigests.updatedAt))
    .limit(1);
  return row ?? null;
}

export async function findDigest(db: Db, accountId: string, key: DigestKey) {
  const [row] = await db
    .select()
    .from(metadataDigests)
    .where(
      and(
        eq(metadataDigests.accountId, accountId),
        eq(metadataDigests.company, key.company),
        eq(metadataDigests.configName, key.configName),
        eq(metadataDigests.configVersion, key.configVersion),
      ),
    );
  return row ?? null;
}

export async function saveDigest(db: Db, accountId: string, input: DigestInput): Promise<void> {
  await db
    .insert(metadataDigests)
    .values({ accountId, ...input })
    .onConflictDoUpdate({
      target: [
        metadataDigests.accountId,
        metadataDigests.company,
        metadataDigests.configName,
        metadataDigests.configVersion,
      ],
      set: { digest: input.digest, tokenCount: input.tokenCount, updatedAt: new Date() },
    });
}
