/**
 * New leads go to the sales managers in turn (docs/crm.md): the first lead to the first manager, the next to the second, and so on
 * round again, so the work is shared equally. Only active managers (role manager, not disabled) are in the turn, oldest first. With
 * the setting off, or no manager, a lead has no owner as before. The place in the turn is kept in `app_settings` ("crm"), under a
 * row lock, so two leads that come in at the same moment are not given to the same manager out of turn.
 */
import { and, asc, eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { admins, appSettings } from "../db/schema.js";

const KEY = "crm";

interface Stored {
  /** Off only when set to false: a new installation shares new leads out. */
  autoAssign?: boolean;
  /** Where the next lead's turn starts in the list of managers. */
  cursor?: number;
}

export class AutoAssign {
  constructor(private readonly db: Db) {}

  /** Is the sharing on, and how many managers are in it. */
  async state(): Promise<{ autoAssign: boolean; managers: number }> {
    const row = await this.db.query.appSettings.findFirst({ where: eq(appSettings.key, KEY) });
    const stored = (row?.value ?? {}) as Stored;
    const managers = await this.db.query.admins.findMany({
      where: and(eq(admins.role, "manager"), eq(admins.disabled, false)),
      columns: { id: true },
    });
    return { autoAssign: stored.autoAssign !== false, managers: managers.length };
  }

  async setEnabled(on: boolean, by: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(appSettings).values({ key: KEY, value: {} }).onConflictDoNothing();
      const [row] = await tx.select().from(appSettings).where(eq(appSettings.key, KEY)).for("update");
      const value = { ...((row?.value ?? {}) as Stored), autoAssign: on };
      await tx
        .update(appSettings)
        .set({ value, updatedAt: new Date(), updatedBy: by })
        .where(eq(appSettings.key, KEY));
    });
  }

  /** The owners of the next `count` new leads, in turn (null for each when the sharing is off or there is no manager). */
  async next(count: number): Promise<(string | null)[]> {
    if (count <= 0) return [];
    return this.db.transaction(async (tx) => {
      await tx.insert(appSettings).values({ key: KEY, value: {} }).onConflictDoNothing();
      const [row] = await tx.select().from(appSettings).where(eq(appSettings.key, KEY)).for("update");
      const stored = (row?.value ?? {}) as Stored;
      const none = () => Array.from({ length: count }, () => null);
      if (stored.autoAssign === false) return none();
      const managers = await tx
        .select({ id: admins.id })
        .from(admins)
        .where(and(eq(admins.role, "manager"), eq(admins.disabled, false)))
        .orderBy(asc(admins.createdAt), asc(admins.id));
      if (managers.length === 0) return none();
      const start = (Number.isInteger(stored.cursor) ? (stored.cursor as number) : 0) % managers.length;
      const owners = Array.from(
        { length: count },
        (_, i) => managers[(start + i) % managers.length]?.id ?? null,
      );
      await tx
        .update(appSettings)
        .set({ value: { ...stored, cursor: (start + count) % managers.length }, updatedAt: new Date() })
        .where(eq(appSettings.key, KEY));
      return owners;
    });
  }
}
