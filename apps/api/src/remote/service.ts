/**
 * The mailbox between a phone and the office PC (docs/remote-control.md). Every rule of section 4 lives here: a command is created
 * `queued`, goes `delivered` when it is sent to the PC, `running` when the PC acknowledges it, and ends `done` or `failed`; a
 * queued one past its time to live is `expired`; the user may cancel one that has not been delivered. A dropped link never runs a
 * command twice: a command the PC has not acknowledged goes back to the queue, a Read command that was running goes back too (it
 * changes nothing), and a Prepare or Apply command that was running is `failed: interrupted` and the user decides.
 *
 * Content (payloads, results) is sealed at rest. The server's audit row has none.
 */
import { createHash, randomBytes } from "node:crypto";

import {
  type BlobRef,
  type CommandView,
  type CreateCommandInput,
  OPEN_STATES,
  REMOTE_LIMITS,
  RESULTS,
  type RemoteCeiling,
  type RemoteClass,
  type RemoteCommandType,
  type RemoteState,
  TTL_HOURS,
  type WsCommand,
  type WsResult,
  classAllowed,
  classOf,
  parsePayload,
} from "@platform/shared";
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";

import type { Billing } from "../billing/entitlements.js";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import {
  remoteAudit,
  remoteBlobs,
  remoteCommands,
  remoteDevices,
  telegramLinks,
  telegramPairings,
} from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import type { Seal } from "./seal.js";

export type DeviceRow = typeof remoteDevices.$inferSelect;
export type LinkRow = typeof telegramLinks.$inferSelect;
export type CommandRow = typeof remoteCommands.$inferSelect;

const HOUR = 3_600_000;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** What the service asks of the live connections to the PCs (hub.ts); a test hands in its own. */
export interface DeviceChannel {
  /** Send what is queued for the device, if it is connected. */
  dispatch(deviceId: string): Promise<void>;
  /** Tell the PC its link was revoked or it was disabled, and close the channel. */
  revoke(deviceId: string, reason: "link_revoked" | "device_disabled"): void;
  online(deviceId: string): boolean;
}

/** What the phone side is told, with no content: the bot turns these into its short messages. */
export type RemoteEvent =
  | { kind: "finished"; command: CommandRow; link: LinkRow }
  | { kind: "expired"; command: CommandRow; link: LinkRow }
  | { kind: "interrupted"; command: CommandRow; link: LinkRow };

export class RemoteService {
  private channel: DeviceChannel | null = null;
  /** Set by the bot: where the events of commands go. */
  onEvent: ((event: RemoteEvent) => void) | null = null;

  constructor(
    readonly db: Db,
    readonly seal: Seal,
    private readonly billing: Billing,
    readonly config: Config,
    private readonly now: () => Date = () => new Date(),
  ) {}

  attach(channel: DeviceChannel): void {
    this.channel = channel;
  }

  online(deviceId: string): boolean {
    return this.channel?.online(deviceId) ?? false;
  }

  // ---- audit ----

  async audit(row: {
    accountId: string;
    deviceId?: string | null;
    linkId?: string | null;
    telegramUserId?: string | null;
    commandId?: string | null;
    type: string;
    class?: string | null;
    event: string;
    detail?: string | null;
  }): Promise<void> {
    await this.db.insert(remoteAudit).values({
      accountId: row.accountId,
      deviceId: row.deviceId ?? null,
      linkId: row.linkId ?? null,
      telegramUserId: row.telegramUserId ?? null,
      commandId: row.commandId ?? null,
      type: row.type,
      class: row.class ?? null,
      event: row.event,
      detail: row.detail ?? null,
    });
  }

  // ---- devices ----

  /** A PC joins the remote channel. The token is shown once; only its hash is kept. */
  async registerDevice(accountId: string, input: { name: string; app_version: string }) {
    await this.requireFeature(accountId);
    const token = randomBytes(32).toString("base64url");
    const [device] = await this.db
      .insert(remoteDevices)
      .values({ accountId, name: input.name, appVersion: input.app_version, tokenHash: sha256(token) })
      .returning();
    if (!device) throw new HttpError(500, "DEVICE_NOT_CREATED", "The device could not be saved");
    await this.audit({ accountId, deviceId: device.id, type: "device", event: "registered" });
    return { device_id: device.id, token };
  }

  /** The device a token belongs to; null for an unknown token. A disabled device is returned (its state is the caller's to judge). */
  async deviceByToken(token: string): Promise<DeviceRow | null> {
    const [row] = await this.db
      .select()
      .from(remoteDevices)
      .where(eq(remoteDevices.tokenHash, sha256(token)));
    return row ?? null;
  }

  async device(accountId: string, deviceId: string): Promise<DeviceRow> {
    const [row] = await this.db
      .select()
      .from(remoteDevices)
      .where(and(eq(remoteDevices.id, deviceId), eq(remoteDevices.accountId, accountId)));
    if (!row) throw new HttpError(404, "DEVICE_NOT_FOUND", "No such device");
    return row;
  }

  async devices(accountId: string) {
    const rows = await this.db.select().from(remoteDevices).where(eq(remoteDevices.accountId, accountId));
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      enabled: d.enabled,
      online: this.online(d.id),
      last_seen_at: d.lastSeenAt?.toISOString() ?? null,
      app_version: d.appVersion,
    }));
  }

  /** The kill switch: a disabled device is closed and the server refuses every command for it. */
  async setEnabled(accountId: string, deviceId: string, enabled: boolean): Promise<void> {
    await this.device(accountId, deviceId);
    await this.db.update(remoteDevices).set({ enabled }).where(eq(remoteDevices.id, deviceId));
    await this.audit({ accountId, deviceId, type: "device", event: enabled ? "enabled" : "disabled" });
    if (!enabled) {
      await this.cancelOpen({ deviceId }, "device_disabled");
      this.channel?.revoke(deviceId, "device_disabled");
    }
  }

  /** The PC says hello: its version and its companies are kept for the phone to choose among. */
  async hello(deviceId: string, hello: { app_version: string; companies: { inn: string; name: string }[] }) {
    await this.db
      .update(remoteDevices)
      .set({ appVersion: hello.app_version, companies: hello.companies, lastSeenAt: this.now() })
      .where(eq(remoteDevices.id, deviceId));
  }

  async touch(deviceId: string): Promise<void> {
    await this.db.update(remoteDevices).set({ lastSeenAt: this.now() }).where(eq(remoteDevices.id, deviceId));
  }

  // ---- pairing and links ----

  /** A one-time code for a phone, valid for 10 minutes; only its hash is kept. */
  async createPairing(device: DeviceRow, ceiling: RemoteCeiling = "prepare") {
    if (!device.enabled)
      throw new HttpError(403, "DEVICE_DISABLED", "Remote control is switched off for this PC");
    await this.requireFeature(device.accountId);
    const code = pairingCode();
    const expires = new Date(this.now().getTime() + REMOTE_LIMITS.pairingMinutes * 60_000);
    await this.db.insert(telegramPairings).values({
      codeHash: sha256(code),
      accountId: device.accountId,
      deviceId: device.id,
      ceiling,
      expiresAt: expires,
    });
    await this.audit({
      accountId: device.accountId,
      deviceId: device.id,
      type: "pairing",
      event: "code_created",
    });
    return { code, expires_at: expires.toISOString() };
  }

  /** The bot gets the code with the user's Telegram id. A code works once; a used, expired or unknown one is refused. */
  async redeemPairing(
    code: string,
    user: { id: string; username: string | null; language: "uz" | "ru" | "en" },
  ): Promise<{ link: LinkRow; device: DeviceRow } | null> {
    const now = this.now();
    const [pairing] = await this.db
      .update(telegramPairings)
      .set({ usedAt: now })
      .where(
        and(
          eq(telegramPairings.codeHash, sha256(code.trim().toUpperCase())),
          isNull(telegramPairings.usedAt),
          gt(telegramPairings.expiresAt, now),
        ),
      )
      .returning();
    if (!pairing) return null;
    const device = await this.db.query.remoteDevices.findFirst({
      where: eq(remoteDevices.id, pairing.deviceId),
    });
    if (!device || !device.enabled) return null;
    // One live link per phone and PC: pairing again replaces its ceiling and language.
    const [held] = await this.db
      .select()
      .from(telegramLinks)
      .where(
        and(
          eq(telegramLinks.deviceId, device.id),
          eq(telegramLinks.telegramUserId, user.id),
          isNull(telegramLinks.revokedAt),
        ),
      );
    const only = device.companies.length === 1 ? (device.companies[0]?.inn ?? null) : null;
    const [link] = held
      ? await this.db
          .update(telegramLinks)
          .set({ ceiling: pairing.ceiling, username: user.username, language: user.language })
          .where(eq(telegramLinks.id, held.id))
          .returning()
      : await this.db
          .insert(telegramLinks)
          .values({
            accountId: pairing.accountId,
            deviceId: device.id,
            telegramUserId: user.id,
            username: user.username,
            ceiling: pairing.ceiling,
            language: user.language,
            activeCompanyInn: only,
          })
          .returning();
    if (!link) return null;
    await this.audit({
      accountId: link.accountId,
      deviceId: device.id,
      linkId: link.id,
      telegramUserId: user.id,
      type: "pairing",
      event: "paired",
    });
    return { link, device };
  }

  async linksOfAccount(accountId: string, deviceId?: string) {
    const rows = await this.db
      .select()
      .from(telegramLinks)
      .where(
        and(
          eq(telegramLinks.accountId, accountId),
          isNull(telegramLinks.revokedAt),
          deviceId ? eq(telegramLinks.deviceId, deviceId) : undefined,
        ),
      );
    return rows.map((l) => ({
      id: l.id,
      username: l.username,
      ceiling: l.ceiling,
      created_at: l.createdAt.toISOString(),
    }));
  }

  /** The live links of a Telegram user (a phone can be paired with more than one PC). */
  async linksOfTelegramUser(telegramUserId: string): Promise<LinkRow[]> {
    return this.db
      .select()
      .from(telegramLinks)
      .where(and(eq(telegramLinks.telegramUserId, telegramUserId), isNull(telegramLinks.revokedAt)));
  }

  async link(linkId: string): Promise<LinkRow | null> {
    const [row] = await this.db.select().from(telegramLinks).where(eq(telegramLinks.id, linkId));
    return row ?? null;
  }

  /** A link is revoked from the desktop (by its id) or from the bot (/unlink): its open commands are cancelled and the PC is told. */
  async revokeLink(link: LinkRow, by: "desktop" | "telegram"): Promise<void> {
    if (link.revokedAt) return;
    await this.db.update(telegramLinks).set({ revokedAt: this.now() }).where(eq(telegramLinks.id, link.id));
    await this.cancelOpen({ linkId: link.id }, "link_revoked");
    await this.audit({
      accountId: link.accountId,
      deviceId: link.deviceId,
      linkId: link.id,
      telegramUserId: link.telegramUserId,
      type: "link",
      event: "unlinked",
      detail: by,
    });
    this.channel?.revoke(link.deviceId, "link_revoked");
  }

  async setActiveCompany(link: LinkRow, inn: string): Promise<void> {
    await this.db.update(telegramLinks).set({ activeCompanyInn: inn }).where(eq(telegramLinks.id, link.id));
  }

  // ---- the plan ----

  /** The account's plan has the remote channel (a plan's `telegram` feature). */
  async requireFeature(accountId: string): Promise<{ readOnly: boolean }> {
    const resolved = await this.billing.get(accountId, this.now());
    if (!resolved.plan.features.telegram)
      throw new HttpError(402, "FEATURE_NOT_IN_PLAN", "Telegram remote control is not part of this plan");
    // A license that has run out (the account has fallen back to Free) allows Read commands and refuses the others.
    return { readOnly: resolved.state === "free" };
  }

  // ---- commands ----

  /** A request from a phone. The same request id sent twice is one command. */
  async create(link: LinkRow, input: CreateCommandInput): Promise<CommandView> {
    const now = this.now();
    if (link.revokedAt) throw new HttpError(403, "LINK_REVOKED", "This phone is no longer connected");
    const device = await this.db.query.remoteDevices.findFirst({
      where: eq(remoteDevices.id, link.deviceId),
    });
    if (!device || !device.enabled)
      throw new HttpError(403, "DEVICE_DISABLED", "Remote control is switched off for this PC");

    // The same request again: its command, not a second one (checked first, so a double tap is never refused by a limit).
    const [again] = await this.db
      .select()
      .from(remoteCommands)
      .where(eq(remoteCommands.id, input.request_id));
    if (again) {
      if (again.linkId !== link.id)
        throw new HttpError(409, "REQUEST_ID_TAKEN", "This request id belongs to another request");
      return this.view(again);
    }

    const payload = parsePayload(input);
    if (!payload.ok) throw new HttpError(400, "VALIDATION", payload.message);
    const klass = classOf(input.type, link.ceiling);
    if (!classAllowed(link.ceiling, klass))
      throw new HttpError(
        403,
        "CEILING",
        `This phone may only ${link.ceiling}: ${input.type} is a ${klass} command`,
      );
    const plan = await this.requireFeature(link.accountId);
    if (plan.readOnly && klass !== "read")
      throw new HttpError(402, "READ_ONLY", "The license is read-only: only Read commands are accepted");
    if (device.companies.length > 0 && !device.companies.some((c) => c.inn === input.company_inn))
      throw new HttpError(404, "COMPANY_NOT_FOUND", "This PC has no such company");

    const [recent] = await this.db
      .select({ n: count() })
      .from(remoteCommands)
      .where(
        and(
          eq(remoteCommands.linkId, link.id),
          gt(remoteCommands.createdAt, new Date(now.getTime() - 60_000)),
        ),
      );
    if ((recent?.n ?? 0) >= REMOTE_LIMITS.commandsPerMinute)
      throw new HttpError(
        429,
        "RATE_LIMIT",
        `At most ${REMOTE_LIMITS.commandsPerMinute} commands a minute: wait a little`,
      );
    const [open] = await this.db
      .select({ n: count() })
      .from(remoteCommands)
      .where(and(eq(remoteCommands.deviceId, device.id), inArray(remoteCommands.state, OPEN_STATES)));
    if ((open?.n ?? 0) >= REMOTE_LIMITS.openPerDevice)
      throw new HttpError(
        429,
        "TOO_MANY_OPEN",
        `At most ${REMOTE_LIMITS.openPerDevice} requests wait for this PC: cancel some`,
      );

    // A file the command attaches must be one this PC may download, not yet taken by another command.
    let blobId: string | null = null;
    if (input.type === "chat.attach") {
      blobId = (payload.payload as { blob_id: string }).blob_id;
      const [blob] = await this.db.select().from(remoteBlobs).where(eq(remoteBlobs.id, blobId));
      if (
        !blob ||
        blob.deviceId !== device.id ||
        blob.direction !== "in" ||
        blob.expiresAt <= now ||
        blob.commandId
      )
        throw new HttpError(404, "BLOB_NOT_FOUND", "The file was not found, or it has expired");
    }

    const expires = new Date(now.getTime() + TTL_HOURS[klass] * HOUR);
    const [row] = await this.db
      .insert(remoteCommands)
      .values({
        id: input.request_id,
        deviceId: device.id,
        linkId: link.id,
        companyInn: input.company_inn,
        type: input.type,
        class: klass,
        payload: this.seal.sealJson(payload.payload),
        proposalHash: input.proposal_hash ?? null,
        createdAt: now,
        expiresAt: expires,
      })
      .onConflictDoNothing({ target: remoteCommands.id })
      .returning();
    if (!row) {
      // Two taps in the same instant: the other one won.
      const [won] = await this.db
        .select()
        .from(remoteCommands)
        .where(eq(remoteCommands.id, input.request_id));
      if (won && won.linkId === link.id) return this.view(won);
      throw new HttpError(409, "REQUEST_ID_TAKEN", "This request id belongs to another request");
    }
    if (blobId)
      await this.db.update(remoteBlobs).set({ commandId: row.id }).where(eq(remoteBlobs.id, blobId));
    await this.audit({
      accountId: link.accountId,
      deviceId: device.id,
      linkId: link.id,
      telegramUserId: link.telegramUserId,
      commandId: row.id,
      type: row.type,
      class: row.class,
      event: "created",
    });
    void this.channel?.dispatch(device.id);
    return this.view(row);
  }

  /** The command as the phone sees it. */
  async view(row: CommandRow): Promise<CommandView> {
    const blobs = await this.blobsOf(row.id, "out");
    const result = row.state === "done" ? this.seal.openJson(row.result) : undefined;
    const error =
      row.state === "failed" ? this.seal.openJson<{ code: string; message: string }>(row.error) : null;
    return {
      id: row.id,
      type: row.type as RemoteCommandType,
      class: row.class,
      company_inn: row.companyInn,
      state: row.state,
      created_at: row.createdAt.toISOString(),
      expires_at: row.expiresAt.toISOString(),
      finished_at: row.finishedAt?.toISOString() ?? null,
      ...(result !== undefined ? { result } : {}),
      blobs,
      error: error ?? null,
      progress: row.progress,
    };
  }

  async blobsOf(commandId: string, direction: "in" | "out"): Promise<BlobRef[]> {
    const rows = await this.db
      .select()
      .from(remoteBlobs)
      .where(and(eq(remoteBlobs.commandId, commandId), eq(remoteBlobs.direction, direction)));
    return rows.map((b) => ({ id: b.id, name: b.name, size: b.size, sha256: b.sha256 }));
  }

  /** A command of the phone's own links (by id), or null. */
  async commandOf(linkIds: string[], id: string): Promise<CommandRow | null> {
    if (linkIds.length === 0) return null;
    const [row] = await this.db
      .select()
      .from(remoteCommands)
      .where(and(eq(remoteCommands.id, id), inArray(remoteCommands.linkId, linkIds)));
    return row ?? null;
  }

  async openOf(linkIds: string[]): Promise<CommandView[]> {
    if (linkIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(remoteCommands)
      .where(and(inArray(remoteCommands.linkId, linkIds), inArray(remoteCommands.state, OPEN_STATES)))
      .orderBy(asc(remoteCommands.createdAt));
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async recentOf(linkIds: string[], limit = 30): Promise<CommandView[]> {
    if (linkIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(remoteCommands)
      .where(inArray(remoteCommands.linkId, linkIds))
      .orderBy(desc(remoteCommands.createdAt))
      .limit(limit);
    return Promise.all(rows.map((r) => this.view(r)));
  }

  /** Cancel a request that has not been delivered; one the PC has taken is 409. */
  async cancel(link: LinkRow, id: string): Promise<CommandView> {
    const [row] = await this.db
      .update(remoteCommands)
      .set({ state: "cancelled", finishedAt: this.now() })
      .where(
        and(
          eq(remoteCommands.id, id),
          eq(remoteCommands.linkId, link.id),
          eq(remoteCommands.state, "queued"),
        ),
      )
      .returning();
    if (!row) {
      const held = await this.commandOf([link.id], id);
      if (!held) throw new HttpError(404, "COMMAND_NOT_FOUND", "No such request");
      throw new HttpError(
        409,
        "NOT_CANCELLABLE",
        `The request is ${held.state}: it can no longer be cancelled`,
      );
    }
    await this.audit({
      accountId: link.accountId,
      deviceId: row.deviceId,
      linkId: link.id,
      telegramUserId: link.telegramUserId,
      commandId: row.id,
      type: row.type,
      class: row.class,
      event: "cancelled",
    });
    return this.view(row);
  }

  /** Cancels what is still open for a device or a link (a revoked link, a disabled device). */
  private async cancelOpen(where: { deviceId?: string; linkId?: string }, reason: string): Promise<void> {
    const rows = await this.db
      .update(remoteCommands)
      .set({ state: "cancelled", finishedAt: this.now() })
      .where(
        and(
          where.deviceId ? eq(remoteCommands.deviceId, where.deviceId) : undefined,
          where.linkId ? eq(remoteCommands.linkId, where.linkId) : undefined,
          eq(remoteCommands.state, "queued"),
        ),
      )
      .returning();
    for (const row of rows) {
      const link = await this.link(row.linkId);
      await this.audit({
        accountId: link?.accountId ?? "00000000-0000-0000-0000-000000000000",
        deviceId: row.deviceId,
        linkId: row.linkId,
        commandId: row.id,
        type: row.type,
        class: row.class,
        event: "cancelled",
        detail: reason,
      });
    }
  }

  // ---- the PC's side ----

  /**
   * Takes the commands queued for a device, oldest first, and marks each `delivered` in the same statement, so two dispatches never
   * send the same one twice.
   */
  async claimQueued(device: DeviceRow): Promise<WsCommand[]> {
    const now = this.now();
    const out: WsCommand[] = [];
    for (;;) {
      const queued = await this.db
        .select()
        .from(remoteCommands)
        .where(
          and(
            eq(remoteCommands.deviceId, device.id),
            eq(remoteCommands.state, "queued"),
            gt(remoteCommands.expiresAt, now),
          ),
        )
        .orderBy(asc(remoteCommands.createdAt))
        .limit(50);
      let claimedAny = false;
      for (const row of queued) {
        const [claimed] = await this.db
          .update(remoteCommands)
          .set({ state: "delivered", deliveredAt: now })
          .where(and(eq(remoteCommands.id, row.id), eq(remoteCommands.state, "queued")))
          .returning();
        if (!claimed) continue;
        claimedAny = true;
        const link = await this.link(claimed.linkId);
        if (!link || link.revokedAt) {
          await this.db
            .update(remoteCommands)
            .set({ state: "cancelled", finishedAt: now })
            .where(eq(remoteCommands.id, claimed.id));
          continue;
        }
        out.push({
          type: "command",
          id: claimed.id,
          command_type: claimed.type as RemoteCommandType,
          class: claimed.class,
          company_inn: claimed.companyInn,
          payload: this.seal.openJson(claimed.payload),
          expires_at: claimed.expiresAt.toISOString(),
          ...(claimed.proposalHash ? { proposal_hash: claimed.proposalHash } : {}),
          ceiling: link.ceiling,
          telegram_user: link.username ? `@${link.username}` : link.telegramUserId,
        });
        await this.audit({
          accountId: link.accountId,
          deviceId: device.id,
          linkId: link.id,
          commandId: claimed.id,
          type: claimed.type,
          class: claimed.class,
          event: "delivered",
        });
      }
      if (!claimedAny || queued.length < 50) break;
    }
    return out;
  }

  /** Commands claimed for a link that dropped before they were sent: delivered → queued. */
  async release(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(remoteCommands)
      .set({ state: "queued", deliveredAt: null })
      .where(and(inArray(remoteCommands.id, ids), eq(remoteCommands.state, "delivered")));
  }

  /** The PC took the command (sent before it runs, so a crash is visible): delivered → running. */
  async ack(device: DeviceRow, id: string): Promise<void> {
    const [row] = await this.db
      .update(remoteCommands)
      .set({ state: "running" })
      .where(
        and(
          eq(remoteCommands.id, id),
          eq(remoteCommands.deviceId, device.id),
          eq(remoteCommands.state, "delivered"),
        ),
      )
      .returning();
    if (row)
      await this.audit({
        accountId: device.accountId,
        deviceId: device.id,
        linkId: row.linkId,
        commandId: row.id,
        type: row.type,
        class: row.class,
        event: "running",
      });
  }

  async progress(device: DeviceRow, id: string, text: string): Promise<void> {
    await this.db
      .update(remoteCommands)
      .set({ progress: text.slice(0, 200) })
      .where(
        and(
          eq(remoteCommands.id, id),
          eq(remoteCommands.deviceId, device.id),
          inArray(remoteCommands.state, ["delivered", "running"]),
        ),
      );
  }

  /**
   * The PC's result. Idempotent: a command that already ended keeps its first result (a result resent after a reconnect). A result
   * that does not have the shape of its command type is stored as failed, so the phone never gets a shape it cannot read.
   */
  async complete(device: DeviceRow, msg: WsResult): Promise<void> {
    const [row] = await this.db
      .select()
      .from(remoteCommands)
      .where(and(eq(remoteCommands.id, msg.id), eq(remoteCommands.deviceId, device.id)));
    if (!row || !["delivered", "running"].includes(row.state)) return;
    let ok = msg.ok;
    let result: unknown = msg.result;
    let error = msg.error ?? null;
    if (ok) {
      const shape = RESULTS[row.type as RemoteCommandType].safeParse(msg.result);
      if (!shape.success) {
        ok = false;
        error = { code: "BAD_RESULT", message: "The PC's result does not have the shape of this command" };
      } else result = shape.data;
    }
    const finished = this.now();
    const [done] = await this.db
      .update(remoteCommands)
      .set({
        state: ok ? "done" : "failed",
        finishedAt: finished,
        result: ok ? this.seal.sealJson(result) : null,
        error: ok
          ? null
          : this.seal.sealJson(error ?? { code: "FAILED", message: "The request failed on the PC" }),
        progress: null,
      })
      .where(and(eq(remoteCommands.id, row.id), inArray(remoteCommands.state, ["delivered", "running"])))
      .returning();
    if (!done) return;
    const link = await this.link(done.linkId);
    await this.audit({
      accountId: device.accountId,
      deviceId: device.id,
      linkId: done.linkId,
      commandId: done.id,
      type: done.type,
      class: done.class,
      event: ok ? "done" : "failed",
      detail: ok ? null : (error?.code ?? "FAILED"),
    });
    if (link) this.onEvent?.({ kind: "finished", command: done, link });
  }

  /** The link dropped: see the rules in the header of this file. Returns the ids of the commands put back in the queue. */
  async onDisconnect(device: DeviceRow): Promise<void> {
    const now = this.now();
    // Not yet acknowledged: the PC has not run it, so it goes back to the queue.
    await this.db
      .update(remoteCommands)
      .set({ state: "queued", deliveredAt: null })
      .where(and(eq(remoteCommands.deviceId, device.id), eq(remoteCommands.state, "delivered")));
    // Running: a Read command changes nothing and goes back; a Prepare or Apply command is failed, and the user decides.
    await this.db
      .update(remoteCommands)
      .set({ state: "queued", deliveredAt: null, progress: null })
      .where(
        and(
          eq(remoteCommands.deviceId, device.id),
          eq(remoteCommands.state, "running"),
          eq(remoteCommands.class, "read"),
        ),
      );
    const interrupted = await this.db
      .update(remoteCommands)
      .set({
        state: "failed",
        finishedAt: now,
        progress: null,
        error: this.seal.sealJson({
          code: "INTERRUPTED",
          message: "The link dropped while the PC was working: check what was made",
        }),
      })
      .where(and(eq(remoteCommands.deviceId, device.id), eq(remoteCommands.state, "running")))
      .returning();
    for (const row of interrupted) {
      const link = await this.link(row.linkId);
      await this.audit({
        accountId: device.accountId,
        deviceId: device.id,
        linkId: row.linkId,
        commandId: row.id,
        type: row.type,
        class: row.class,
        event: "failed",
        detail: "INTERRUPTED",
      });
      if (link) this.onEvent?.({ kind: "interrupted", command: row, link });
    }
  }

  /**
   * The PC reconnects and says which ids it already holds. A command it holds that the server still thinks `running` or
   * `delivered` is left alone (its result will be resent); every other `delivered` one went back to the queue on the drop.
   */
  async reconcile(device: DeviceRow, doneIds: string[]): Promise<void> {
    if (doneIds.length === 0) return;
    // A queued command the PC already holds is not sent again: its result arrives from the PC's inbox.
    await this.db
      .update(remoteCommands)
      .set({ state: "running", deliveredAt: this.now() })
      .where(
        and(
          eq(remoteCommands.deviceId, device.id),
          eq(remoteCommands.state, "queued"),
          inArray(remoteCommands.id, doneIds),
        ),
      );
  }

  /** Queued commands past their time to live become expired and the phone is told. */
  async expireDue(): Promise<number> {
    const rows = await this.db
      .update(remoteCommands)
      .set({ state: "expired", finishedAt: this.now() })
      .where(and(eq(remoteCommands.state, "queued"), lt(remoteCommands.expiresAt, this.now())))
      .returning();
    for (const row of rows) {
      const link = await this.link(row.linkId);
      await this.audit({
        accountId: link?.accountId ?? "00000000-0000-0000-0000-000000000000",
        deviceId: row.deviceId,
        linkId: row.linkId,
        commandId: row.id,
        type: row.type,
        class: row.class,
        event: "expired",
      });
      if (link) this.onEvent?.({ kind: "expired", command: row, link });
    }
    return rows.length;
  }

  /** The state of a command row, for tests and the bot. */
  async stateOf(id: string): Promise<RemoteState | null> {
    const [row] = await this.db
      .select({ state: remoteCommands.state })
      .from(remoteCommands)
      .where(eq(remoteCommands.id, id));
    return row?.state ?? null;
  }

  /** The audit rows of an account, newest first (content-free). */
  async auditOf(accountId: string, limit = 100) {
    return this.db
      .select()
      .from(remoteAudit)
      .where(eq(remoteAudit.accountId, accountId))
      .orderBy(desc(remoteAudit.at))
      .limit(limit);
  }

  /** Used by tests: how many rows of the mailbox. */
  async countCommands(): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(remoteCommands);
    return row?.n ?? 0;
  }

  /** Whether a command is of a class the ceiling allows (used by the PC's own check through the hello). */
  static allowed(ceiling: RemoteCeiling, klass: RemoteClass): boolean {
    return classAllowed(ceiling, klass);
  }
}

/** Eight characters from an alphabet with no look-alikes (no 0/O, 1/I/L): easy to read from a screen and type by hand. */
function pairingCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
