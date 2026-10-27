/**
 * Telegram: who a Mini App caller is (the signed initData), the Bot API calls the server makes, and the bot itself (pairing,
 * /status, /unlink, a message or a file written in the chat). The bot never puts anything from the books in a message: counts and
 * the app's name only (section 6); content travels inside the Mini App over HTTPS.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { type NOTIFY_EVENTS, REMOTE_LIMITS, notificationText } from "@platform/shared";

import type { Config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import type { Blobs } from "./blobs.js";
import type { CommandRow, LinkRow, RemoteEvent, RemoteService } from "./service.js";

export type Lang = "uz" | "ru" | "en";

/** The Telegram user behind a Mini App call, from the signed `initData` the Mini App sends. */
export interface TelegramCaller {
  id: string;
  username: string | null;
  language: Lang;
}

/**
 * Checks Telegram's signature over initData (HMAC-SHA256 keyed with HMAC("WebAppData", bot token)) and its age. Throws 401 for a wrong
 * signature, data older than an hour, or data with no user.
 */
export function verifyInitData(initData: string, botToken: string, now = new Date()): TelegramCaller {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new HttpError(401, "BAD_INIT_DATA", "The Telegram sign-in data is incomplete");
  params.delete("hash");
  const check = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  let given: Buffer;
  try {
    given = Buffer.from(hash, "hex");
  } catch {
    given = Buffer.alloc(0);
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw new HttpError(401, "BAD_INIT_DATA", "The Telegram signature is wrong");
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || now.getTime() / 1000 - authDate > REMOTE_LIMITS.initDataMaxAgeSeconds)
    throw new HttpError(
      401,
      "INIT_DATA_EXPIRED",
      "The Telegram sign-in is older than an hour: open the app again",
    );
  let user: { id?: number; username?: string; language_code?: string };
  try {
    user = JSON.parse(params.get("user") ?? "") as typeof user;
  } catch {
    throw new HttpError(401, "BAD_INIT_DATA", "The Telegram sign-in has no user");
  }
  if (typeof user.id !== "number")
    throw new HttpError(401, "BAD_INIT_DATA", "The Telegram sign-in has no user");
  return { id: String(user.id), username: user.username ?? null, language: langOf(user.language_code) };
}

export const langOf = (code: string | undefined | null): Lang =>
  code?.startsWith("uz") ? "uz" : code?.startsWith("en") ? "en" : "ru";

/** The calls the server makes to the Bot API; a test hands in its own. */
export interface TelegramApi {
  sendMessage(chatId: string, text: string, button?: { text: string; url: string }): Promise<void>;
  /** The bytes of a file the user sent to the bot. */
  download(fileId: string): Promise<{ name: string; data: Uint8Array } | null>;
  setWebhook?(url: string, secret: string): Promise<void>;
}

/** The Bot API over HTTPS. */
export function botApi(token: string, fetchImpl: typeof fetch = fetch): TelegramApi {
  const base = `https://api.telegram.org/bot${token}`;
  return {
    async sendMessage(chatId, text, button) {
      await fetchImpl(`${base}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          ...(button
            ? { reply_markup: { inline_keyboard: [[{ text: button.text, web_app: { url: button.url } }]] } }
            : {}),
        }),
      });
    },
    async download(fileId) {
      const meta = (await (
        await fetchImpl(`${base}/getFile?file_id=${encodeURIComponent(fileId)}`)
      ).json()) as {
        ok?: boolean;
        result?: { file_path?: string; file_size?: number };
      };
      const path = meta.result?.file_path;
      if (!meta.ok || !path || (meta.result?.file_size ?? 0) > REMOTE_LIMITS.maxFileBytes) return null;
      const res = await fetchImpl(`https://api.telegram.org/file/bot${token}/${path}`);
      if (!res.ok) return null;
      return { name: path.split("/").pop() ?? "file", data: new Uint8Array(await res.arrayBuffer()) };
    },
    async setWebhook(url, secret) {
      await fetchImpl(`${base}/setWebhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, secret_token: secret, allowed_updates: ["message"] }),
      });
    },
  };
}

const WORDS = {
  uz: {
    start:
      "Salom! Kompyuterdagi ilovada Sozlamalar → Masofaviy boshqaruv → «Telegramni ulash» orqali olingan havolani oching.",
    connected: (device: string) => `Ulandi: ${device}. Endi yozishingiz va fayl yuborishingiz mumkin.`,
    badCode: "Kod noto'g'ri, muddati o'tgan yoki ishlatilgan. Ilovada yangi kod oling.",
    notLinked: "Hech narsa ulanmagan. Ilovada «Telegramni ulash» havolasini oching.",
    online: (name: string) => `${name}: kompyuter ulangan.`,
    offline: (name: string) => `${name}: kompyuter o'chiq. So'rovlar navbatda turadi va ulangach bajariladi.`,
    unlinked: "Ulanish uzildi. Qayta ulash uchun ilovadan yangi kod oling.",
    queued: "Qabul qilindi. Kompyuter ulangach bajariladi, tayyor bo'lganda xabar beraman.",
    open: "Ilovani ochish",
    ready: "Javob tayyor. Ilovani oching.",
    failed: "So'rov bajarilmadi. Ilovani oching.",
    expired: "So'rov muddati o'tdi: kompyuter ulanmadi. Qayta yuboring.",
    interrupted: "Ulanish uzilib qoldi: nima qilingani noma'lum. Ilovada tekshiring.",
    chooseCompany: "Qaysi korxona? Ilovani oching va tanlang.",
    fileBad: "Faylni qabul qilib bo'lmadi (turi yoki hajmi).",
    rate: "Juda ko'p so'rov: biroz kuting.",
    refused: "So'rov rad etildi.",
    attached: "Fayl qabul qilindi. Kompyuter ulangach o'qiladi.",
  },
  ru: {
    start:
      "Здравствуйте! В приложении на компьютере откройте Настройки → Удалённое управление → «Подключить Telegram» и перейдите по ссылке.",
    connected: (device: string) => `Подключено: ${device}. Теперь можно писать и присылать файлы.`,
    badCode: "Код неверный, просрочен или уже использован. Получите новый в приложении.",
    notLinked: "Ничего не подключено. Откройте ссылку «Подключить Telegram» в приложении.",
    online: (name: string) => `${name}: компьютер на связи.`,
    offline: (name: string) =>
      `${name}: компьютер выключен. Запросы ждут в очереди и выполнятся, когда он включится.`,
    unlinked: "Связь отключена. Чтобы подключить снова, возьмите новый код в приложении.",
    queued: "Принято. Выполню, когда компьютер выйдет на связь, и сообщу.",
    open: "Открыть приложение",
    ready: "Ответ готов. Откройте приложение.",
    failed: "Запрос не выполнен. Откройте приложение.",
    expired: "Срок запроса истёк: компьютер не вышел на связь. Отправьте снова.",
    interrupted: "Связь оборвалась: неизвестно, что успело сделаться. Проверьте в приложении.",
    chooseCompany: "Какая организация? Откройте приложение и выберите.",
    fileBad: "Файл не принят (тип или размер).",
    rate: "Слишком много запросов: подождите немного.",
    refused: "Запрос отклонён.",
    attached: "Файл принят. Прочитаю, когда компьютер выйдет на связь.",
  },
  en: {
    start: "Hello! On the desktop open Settings → Remote control → “Connect Telegram” and follow the link.",
    connected: (device: string) => `Connected: ${device}. You can write and send files now.`,
    badCode: "The code is wrong, expired or already used. Get a new one in the app.",
    notLinked: "Nothing is connected. Open the “Connect Telegram” link in the app.",
    online: (name: string) => `${name}: the PC is online.`,
    offline: (name: string) => `${name}: the PC is off. Requests wait in the queue and run when it is back.`,
    unlinked: "Disconnected. To connect again, get a new code in the app.",
    queued: "Got it. It will run when the PC is online, and I will tell you.",
    open: "Open the app",
    ready: "The reply is ready. Open the app.",
    failed: "The request failed. Open the app.",
    expired: "The request expired: the PC did not come online. Send it again.",
    interrupted: "The link dropped: it is not known what was done. Check in the app.",
    chooseCompany: "Which company? Open the app and choose.",
    fileBad: "The file was not accepted (type or size).",
    rate: "Too many requests: wait a little.",
    refused: "The request was refused.",
    attached: "File received. It will be read when the PC is online.",
  },
} as const;

interface Update {
  message?: {
    message_id?: number;
    chat?: { id: number };
    from?: { id: number; username?: string; language_code?: string };
    text?: string;
    document?: { file_id: string; file_name?: string; file_size?: number };
  };
}

export class Bot {
  constructor(
    private readonly service: RemoteService,
    private readonly api: TelegramApi,
    private readonly blobs: Blobs,
    private readonly config: Pick<Config, "MINIAPP_URL">,
  ) {
    service.onEvent = (event) => void this.onEvent(event).catch(() => undefined);
  }

  private button(lang: Lang) {
    return this.config.MINIAPP_URL ? { text: WORDS[lang].open, url: this.config.MINIAPP_URL } : undefined;
  }

  /** A command ended: the phone is told in a few words, with the button that opens the Mini App. */
  private async onEvent(event: RemoteEvent): Promise<void> {
    const w = WORDS[event.link.language];
    const text =
      event.kind === "finished"
        ? event.command.state === "done"
          ? w.ready
          : w.failed
        : event.kind === "expired"
          ? w.expired
          : w.interrupted;
    await this.api.sendMessage(event.link.telegramUserId, text, this.button(event.link.language));
  }

  /** The PC reports an event (import finished, a card is waiting…): one short message to each live link of the device. */
  async notify(deviceId: string, event: (typeof NOTIFY_EVENTS)[number], count?: number): Promise<void> {
    const links = await this.service.db.query.telegramLinks.findMany({
      where: (t, { and, eq, isNull }) => and(eq(t.deviceId, deviceId), isNull(t.revokedAt)),
    });
    for (const link of links)
      await this.api.sendMessage(
        link.telegramUserId,
        notificationText(event, link.language, count),
        this.button(link.language),
      );
  }

  /** One Telegram update. Never throws: a bad update is answered with a short message or ignored. */
  async handle(update: Update): Promise<void> {
    const m = update.message;
    if (!m?.from) return;
    const user = {
      id: String(m.from.id),
      username: m.from.username ?? null,
      language: langOf(m.from.language_code),
    };
    const chat = String(m.chat?.id ?? m.from.id);
    const w = WORDS[user.language];
    const say = (text: string, button = false) =>
      this.api.sendMessage(chat, text, button ? this.button(user.language) : undefined);
    const text = (m.text ?? "").trim();

    if (text.startsWith("/start")) {
      const code = text.split(/\s+/)[1];
      if (!code) return say(w.start);
      const paired = await this.service.redeemPairing(code, user);
      return paired ? say(w.connected(paired.device.name), true) : say(w.badCode);
    }

    const links = await this.service.linksOfTelegramUser(user.id);
    if (text === "/unlink") {
      if (links.length === 0) return say(w.notLinked);
      for (const link of links) await this.service.revokeLink(link, "telegram");
      return say(w.unlinked);
    }
    if (links.length === 0) return say(w.notLinked);
    if (text === "/status") {
      for (const link of links) {
        const device = await this.service.db.query.remoteDevices.findFirst({
          where: (t, { eq }) => eq(t.id, link.deviceId),
        });
        if (device)
          await say(this.service.online(device.id) ? w.online(device.name) : w.offline(device.name), true);
      }
      return;
    }

    // A message or a file written in the chat: a command for the link's active company.
    const link = links[0];
    if (!link) return;
    if (!link.activeCompanyInn) return say(w.chooseCompany, true);
    try {
      if (m.document) {
        const file = await this.api.download(m.document.file_id);
        if (!file) return say(w.fileBad);
        const name = m.document.file_name ?? file.name;
        const { createHash, randomUUID } = await import("node:crypto");
        const blob = await this.blobs.store({
          deviceId: link.deviceId,
          direction: "in",
          name,
          data: file.data,
          sha256: createHash("sha256").update(file.data).digest("hex"),
        });
        await this.service.create(link, {
          type: "chat.attach",
          company_inn: link.activeCompanyInn,
          payload: { blob_id: blob.id, name },
          request_id: randomUUID(),
        });
        return say(w.attached);
      }
      if (text && !text.startsWith("/")) {
        const { randomUUID } = await import("node:crypto");
        await this.service.create(link, {
          type: "chat.message",
          company_inn: link.activeCompanyInn,
          payload: { text },
          request_id: randomUUID(),
        });
        return say(w.queued);
      }
    } catch (error) {
      if (error instanceof HttpError)
        return say(
          error.code === "RATE_LIMIT" ? w.rate : error.code.startsWith("FILE") ? w.fileBad : w.refused,
        );
      throw error;
    }
  }
}

/** The label of a command in a content-free message (kept for the audit and the log). */
export const describeCommand = (c: Pick<CommandRow, "type" | "class">, _link: Pick<LinkRow, "id">) =>
  `${c.type} (${c.class})`;
