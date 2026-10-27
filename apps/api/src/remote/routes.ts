/**
 * HTTP and WebSocket routes of the remote channel (section 8 of the design). Three kinds of caller: the phone (the Mini App, signed
 * by Telegram's initData: `Authorization: tma <initData>`), the desktop app (its device token: `Authorization: Device <token>`, or
 * the account's access token to register a device), and Telegram itself (the webhook's secret header).
 */
import {
  CreateCommandInput,
  PairingResult,
  REMOTE_LIMITS,
  RegisterDeviceInput,
  RemoteCeiling,
} from "@platform/shared";
import "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { Config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import type { Blobs } from "./blobs.js";
import type { DeviceHub } from "./hub.js";
import type { DeviceRow, LinkRow, RemoteService } from "./service.js";
import { type Bot, type TelegramCaller, verifyInitData } from "./telegram.js";

export interface RemoteRouteDeps {
  service: RemoteService;
  hub: DeviceHub;
  blobs: Blobs;
  bot: Bot | null;
  config: Config;
  /** The account behind an access token (the desktop's sign-in). */
  account: (req: FastifyRequest) => Promise<{ userId: string; accountId: string }>;
}

const uuid = z.object({ id: z.string().uuid() });

export async function registerRemoteRoutes(app: FastifyInstance, d: RemoteRouteDeps): Promise<void> {
  const { service, hub, blobs, bot, config } = d;

  // ---- who is calling ----

  async function device(req: FastifyRequest, options: { allowDisabled?: boolean } = {}): Promise<DeviceRow> {
    const header = req.headers.authorization ?? "";
    const found = header.startsWith("Device ") ? await service.deviceByToken(header.slice(7).trim()) : null;
    if (!found) throw new HttpError(401, "UNAUTHORIZED", "The device token is wrong");
    if (!found.enabled && !options.allowDisabled)
      throw new HttpError(403, "DEVICE_DISABLED", "Remote control is switched off for this PC");
    return found;
  }

  function caller(req: FastifyRequest): TelegramCaller {
    if (!config.TELEGRAM_BOT_TOKEN)
      throw new HttpError(503, "TELEGRAM_OFF", "Telegram is not set up on this server");
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("tma ")) throw new HttpError(401, "UNAUTHORIZED", "Open the app from Telegram");
    return verifyInitData(header.slice(4), config.TELEGRAM_BOT_TOKEN);
  }

  /** The phone's live links; a caller with none is refused. */
  async function links(req: FastifyRequest): Promise<{ who: TelegramCaller; links: LinkRow[] }> {
    const who = caller(req);
    const all = await service.linksOfTelegramUser(who.id);
    if (all.length === 0)
      throw new HttpError(403, "NOT_LINKED", "This Telegram account is not connected to any PC");
    return { who, links: all };
  }

  /** The link a command goes by: the one whose PC has the company (the PC's own `device_id` when the phone names it). */
  async function linkFor(all: LinkRow[], inn: string, deviceId?: string): Promise<LinkRow> {
    const candidates = deviceId ? all.filter((l) => l.deviceId === deviceId) : all;
    for (const link of candidates) {
      const dev = await service.db.query.remoteDevices.findFirst({
        where: (t, { eq }) => eq(t.id, link.deviceId),
      });
      if (dev?.companies.some((c) => c.inn === inn)) return link;
    }
    const [first] = candidates;
    if (!first) throw new HttpError(404, "DEVICE_NOT_FOUND", "No such PC");
    return first;
  }

  // ---- the desktop: registration, pairing, switches ----

  app.post("/remote/devices", async (req, reply) => {
    const { accountId } = await d.account(req);
    const body = RegisterDeviceInput.parse(req.body);
    return reply.status(201).send(await service.registerDevice(accountId, body));
  });

  app.get("/remote/devices", async (req) => service.devices((await d.account(req)).accountId));

  /** The kill switch, from the account (the desktop's settings with the user's sign-in). */
  app.post("/remote/devices/:id/enabled", async (req) => {
    const { accountId } = await d.account(req);
    const { id } = uuid.parse(req.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    await service.setEnabled(accountId, id, enabled);
    return { enabled };
  });

  /** The PC's own switch, with its device token (it may switch itself back on). */
  app.post("/remote/device/enabled", async (req) => {
    const dev = await device(req, { allowDisabled: true });
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    await service.setEnabled(dev.accountId, dev.id, enabled);
    return { enabled };
  });

  app.post("/remote/pairing", async (req, reply) => {
    const dev = await device(req);
    const { ceiling } = z.object({ ceiling: RemoteCeiling.optional() }).parse(req.body ?? {});
    const made = await service.createPairing(dev, ceiling ?? "prepare");
    const username = config.TELEGRAM_BOT_USERNAME;
    return reply.status(201).send(
      PairingResult.parse({
        code: made.code,
        link: username ? `https://t.me/${username}?start=${made.code}` : "",
        expires_at: made.expires_at,
      }),
    );
  });

  app.get("/remote/links", async (req) =>
    service.linksOfAccount((await device(req)).accountId, (await device(req)).id),
  );

  app.delete("/remote/links/:id", async (req, reply) => {
    const dev = await device(req);
    const { id } = uuid.parse(req.params);
    const link = await service.link(id);
    if (!link || link.deviceId !== dev.id) throw new HttpError(404, "LINK_NOT_FOUND", "No such connection");
    await service.revokeLink(link, "desktop");
    return reply.status(204).send();
  });

  app.get("/remote/audit", async (req) => service.auditOf((await device(req)).accountId));

  // ---- the desktop's channel ----

  app.get("/remote/device", { websocket: true }, async (socket, req) => {
    // The PC's hello comes the moment the socket opens, before the token is checked: keep it.
    const early: (Buffer | string)[] = [];
    let attached = false;
    socket.on("message", (data: Buffer | string) => {
      if (!attached) early.push(data);
    });
    const offered = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((p) => p.trim());
    const token = offered.find((p) => p.startsWith("bearer."))?.slice(7);
    const dev = token ? await service.deviceByToken(token) : null;
    if (!dev || !dev.enabled) {
      socket.close(4401, "unauthorized");
      return;
    }
    attached = true;
    hub.attachSocket(socket as never, dev, early);
  });

  // ---- files ----

  // A file travels as the raw body: name and checksum in headers (no multipart).
  const raw = { bodyLimit: REMOTE_LIMITS.maxFileBytes + 1024 };
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: raw.bodyLimit },
      (_req, body, done) => done(null, body),
    );

    /** The phone uploads a file for a command (or the PC uploads an output, with `command_id`). */
    scope.post("/remote/blobs", { bodyLimit: raw.bodyLimit }, async (req, reply) => {
      const name = decodeURIComponent(String(req.headers["x-file-name"] ?? ""));
      const sha256 = String(req.headers["x-sha256"] ?? "");
      if (!name || !/^[0-9a-f]{64}$/i.test(sha256))
        throw new HttpError(400, "VALIDATION", "x-file-name and x-sha256 headers are required");
      const data = req.body instanceof Buffer ? req.body : null;
      if (!data) throw new HttpError(415, "FILE_TYPE", "Send the file as application/octet-stream");
      const auth = req.headers.authorization ?? "";
      if (auth.startsWith("Device ")) {
        const dev = await device(req);
        const commandId = String(req.headers["x-command-id"] ?? "");
        if (!/^[0-9a-f-]{36}$/i.test(commandId))
          throw new HttpError(400, "VALIDATION", "x-command-id is required for an output");
        const stored = await blobs.store({
          deviceId: dev.id,
          direction: "out",
          name,
          data,
          sha256,
          commandId,
          check: false,
        });
        return reply.status(201).send(stored);
      }
      const { links: mine } = await links(req);
      const deviceId = String(req.headers["x-device-id"] ?? "") || mine[0]?.deviceId;
      const link = mine.find((l) => l.deviceId === deviceId);
      if (!link) throw new HttpError(403, "NOT_LINKED", "This Telegram account is not connected to that PC");
      const stored = await blobs.store({ deviceId: link.deviceId, direction: "in", name, data, sha256 });
      return reply.status(201).send(stored);
    });
  });

  app.get("/remote/blobs/:id", async (req, reply) => {
    const { id } = uuid.parse(req.params);
    const auth = req.headers.authorization ?? "";
    const found = await blobs.read(id);
    if (!found) throw new HttpError(404, "BLOB_EXPIRED", "The file was not found, or it has expired");
    const { row, data } = found;
    if (auth.startsWith("Device ")) {
      // The PC downloads an input file; the server deletes it once it has been taken.
      const dev = await device(req);
      if (row.deviceId !== dev.id || row.direction !== "in")
        throw new HttpError(404, "BLOB_NOT_FOUND", "No such file");
      await blobs.remove(row.id);
    } else {
      // The phone downloads an output of one of its own commands.
      const { links: mine } = await links(req);
      const own = row.commandId
        ? await service.commandOf(
            mine.map((l) => l.id),
            row.commandId,
          )
        : null;
      if (!own || row.direction !== "out") throw new HttpError(404, "BLOB_NOT_FOUND", "No such file");
    }
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`)
      .header("x-sha256", row.sha256)
      .send(data);
  });

  // ---- the phone: commands ----

  /** Who the phone is and what it can reach: its PCs (online or not) and their companies. */
  app.get("/remote/me", async (req) => {
    const { who, links: mine } = await links(req);
    const rows = await Promise.all(
      mine.map(async (l) => {
        const dev = await service.db.query.remoteDevices.findFirst({
          where: (t, { eq }) => eq(t.id, l.deviceId),
        });
        return {
          link_id: l.id,
          device_id: l.deviceId,
          device: dev?.name ?? "",
          online: dev ? service.online(dev.id) : false,
          last_seen_at: dev?.lastSeenAt?.toISOString() ?? null,
          ceiling: l.ceiling,
          active_company: l.activeCompanyInn,
          companies: dev?.companies ?? [],
        };
      }),
    );
    return { user: { id: who.id, username: who.username, language: who.language }, devices: rows };
  });

  app.post("/remote/active-company", async (req) => {
    const { links: mine } = await links(req);
    const { company_inn, device_id } = z
      .object({ company_inn: z.string().regex(/^\d{9}$/), device_id: z.string().uuid().optional() })
      .parse(req.body);
    const link = await linkFor(mine, company_inn, device_id);
    await service.setActiveCompany(link, company_inn);
    return { active_company: company_inn };
  });

  app.post("/remote/commands", async (req, reply) => {
    const { links: mine } = await links(req);
    const body = CreateCommandInput.parse(req.body);
    const deviceId = z.object({ device_id: z.string().uuid().optional() }).parse(req.body).device_id;
    const link = await linkFor(mine, body.company_inn, deviceId);
    const view = await service.create(link, body);
    return reply.status(201).send(view);
  });

  app.get("/remote/commands/:id", async (req) => {
    const { links: mine } = await links(req);
    const row = await service.commandOf(
      mine.map((l) => l.id),
      uuid.parse(req.params).id,
    );
    if (!row) throw new HttpError(404, "COMMAND_NOT_FOUND", "No such request");
    return service.view(row);
  });

  app.get("/remote/commands", async (req) => {
    const { links: mine } = await links(req);
    const { state } = z.object({ state: z.enum(["open", "recent"]).default("open") }).parse(req.query);
    return state === "open" ? service.openOf(mine.map((l) => l.id)) : service.recentOf(mine.map((l) => l.id));
  });

  app.post("/remote/commands/:id/cancel", async (req) => {
    const { links: mine } = await links(req);
    const row = await service.commandOf(
      mine.map((l) => l.id),
      uuid.parse(req.params).id,
    );
    if (!row) throw new HttpError(404, "COMMAND_NOT_FOUND", "No such request");
    const link = mine.find((l) => l.id === row.linkId);
    if (!link) throw new HttpError(404, "COMMAND_NOT_FOUND", "No such request");
    return service.cancel(link, row.id);
  });

  // ---- Telegram's webhook ----

  app.post("/telegram/webhook", async (req, reply) => {
    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_WEBHOOK_SECRET || !bot)
      throw new HttpError(503, "TELEGRAM_OFF", "Telegram is not set up on this server");
    // Telegram sends the secret we gave it with every update; anything else is not Telegram.
    if (req.headers["x-telegram-bot-api-secret-token"] !== config.TELEGRAM_WEBHOOK_SECRET)
      throw new HttpError(401, "UNAUTHORIZED", "Wrong secret");
    // Answered at once: a slow reply makes Telegram send the update again.
    void bot.handle(req.body as never).catch((error) => app.log.error(error));
    return reply.status(200).send({ ok: true });
  });
}
