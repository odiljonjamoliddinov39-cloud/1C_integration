/**
 * E-IMZO, the program on the accountant's PC that holds the electronic signature keys, over its local
 * WebSocket service (the protocol of the E-IMZO integration guide and its demo `e-imzo.js`): every call
 * is one short connection that sends one JSON message and gets one answer. The key's password is asked
 * by E-IMZO itself in its own window; this app never sees it.
 */
import type { DidoxSigner, Stamper } from "./client.js";
import { attachTimestampToken } from "./cms.js";

export const EIMZO_URL = "ws://127.0.0.1:64646/service/cryptapi";

export type EImzoErrorCode = "EIMZO_UNAVAILABLE" | "EIMZO_FAILED" | "EIMZO_NO_KEY" | "EIMZO_TIMEOUT";

export class EImzoError extends Error {
  constructor(
    readonly code: EImzoErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The part of a WebSocket that is used (Node's own WebSocket in the app, a fake in tests). */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
/** `origin`: the page address E-IMZO sees the call coming from (it binds its API keys to a domain). */
export type Connect = (url: string, origin?: string) => SocketLike;

/** Node's WebSocket (undici) takes request headers as an option; a desktop app has no page, so no Origin. */
const defaultConnect: Connect = (url, origin) =>
  (origin
    ? new (WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => unknown)(
        url,
        { headers: { Origin: origin } },
      )
    : new WebSocket(url)) as SocketLike;

/**
 * The API keys for `localhost` and `127.0.0.1` that E-IMZO's own integration guide publishes for a local
 * page. Some E-IMZO installations refuse any call without a key for the caller's domain ("API-key для
 * домена null недействителен": a desktop app has no domain). Then the calls are made as if from a local
 * page, with these keys; used only after E-IMZO has refused without them.
 */
const GUIDE_API_KEYS = [
  "localhost",
  "96D0C1491615C82B9A54D9989779DF825B690748224C2B04F500F370D51827CE2644D8D4A82C18184D73AB8530BB8ED537269603F61DB0D03D2104ABF789970B",
  "127.0.0.1",
  "A7BCFA5D490B351BE0754130DF03A068F855DB4333D43921125B9CF2670EF6A40370C646B90401955E1F7BC9CDBF59CE0B2C5467D820BE189C845D0B79CFC96F",
];
const GUIDE_ORIGIN = "http://localhost";
const refusesApiKey = (reason: unknown) => /api-?key/i.test(String(reason ?? ""));

export interface EImzoCertificate {
  /** Where the key lives; handed back to load_key. */
  disk: string;
  path: string;
  name: string;
  alias: string;
  /** The certificate's serial number in hexadecimal, as Didox wants it. */
  serialNumber: string;
  /** The company's tax number (INN) and the person's PINFL. */
  tin: string;
  pinfl: string;
  commonName: string;
  organization: string;
  validFrom: Date | null;
  validTo: Date | null;
}

type Answer = Record<string, unknown> & { success?: boolean; reason?: string };

export interface EImzoOptions {
  url?: string;
  connect?: Connect;
  /** Pairs of domain and API key, for E-IMZO versions that need the site's key (see docs/didox.md). */
  apiKeys?: string[];
  timeoutMs?: number;
}

/** "2026.01.31 23:59:59" as a date. */
function certificateDate(text: string): Date | null {
  const m = /^(\d{4})[.-](\d{2})[.-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text.trim());
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
}

/** The values of the certificate's name (CN=…,O=…,SERIALNUMBER=…), uppercased as E-IMZO's own demo reads them. */
export function parseAlias(alias: string): Record<string, string> {
  const upper = alias
    .toUpperCase()
    .replace("1.2.860.3.16.1.1=", "INN=")
    .replace("1.2.860.3.16.1.2=", "PINFL=");
  const values: Record<string, string> = {};
  for (const part of upper.split(/,(?=[A-Z]+=)/)) {
    const eq = part.indexOf("=");
    if (eq > 0) values[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return values;
}

export class EImzoClient {
  private readonly url: string;
  private readonly connect: Connect;
  private readonly timeoutMs: number;
  private keyed = false;
  /** E-IMZO refused a call for want of an API key: every call goes as from a local page, with the guide's keys. */
  private asLocalPage = false;

  constructor(private readonly options: EImzoOptions = {}) {
    this.url = options.url ?? EIMZO_URL;
    this.connect = options.connect ?? defaultConnect;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  /** One call: connect, send, take the answer, close. The timeout is long, as the user may be typing a password. */
  private call(message: Record<string, unknown>, origin?: string): Promise<Answer> {
    return new Promise((resolve, reject) => {
      let socket: SocketLike;
      try {
        socket = origin ? this.connect(this.url, origin) : this.connect(this.url);
      } catch (e) {
        reject(unavailable(e));
        return;
      }
      let done = false;
      const finish = (action: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          /* already closed */
        }
        action();
      };
      const timer = setTimeout(
        () => finish(() => reject(new EImzoError("EIMZO_TIMEOUT", "E-IMZO did not answer in time"))),
        this.timeoutMs,
      );
      socket.onopen = () => socket.send(JSON.stringify(message));
      socket.onmessage = (event) =>
        finish(() => {
          try {
            resolve(JSON.parse(String(event.data)) as Answer);
          } catch {
            reject(new EImzoError("EIMZO_FAILED", "E-IMZO sent an answer that could not be read"));
          }
        });
      socket.onerror = (e) => finish(() => reject(unavailable(e)));
      socket.onclose = (event) =>
        finish(() =>
          reject(unavailable(event.code === 1000 ? "the connection closed" : `code ${event.code}`)),
        );
    });
  }

  /** A call that must succeed. */
  private async ask(plugin: string, name: string, args?: unknown[]): Promise<Answer> {
    await this.sendApiKeys();
    const message = { plugin, name, ...(args ? { arguments: args } : {}) };
    let answer = await this.send(message);
    if (answer.success === false && !this.asLocalPage && refusesApiKey(answer.reason)) {
      this.asLocalPage = true;
      answer = await this.send(message);
    }
    if (answer.success === false) {
      const reason = String(answer.reason ?? "E-IMZO refused the request");
      // Which function refused, so that "function not found" says which one this E-IMZO lacks.
      throw new EImzoError(
        "EIMZO_FAILED",
        `${plugin}.${name}: ` +
          (this.asLocalPage && refusesApiKey(reason)
            ? `${reason} (it refuses this app even with the E-IMZO guide's local keys: it needs an API key for this application, see docs/didox.md)`
            : reason),
      );
    }
    return answer;
  }

  /**
   * One call. As a local page: the key is set on a connection of its own (E-IMZO closes a connection after
   * one answer, and keeps the key for the page's domain), then the call goes on another from the same origin.
   */
  private async send(message: Record<string, unknown>): Promise<Answer> {
    if (!this.asLocalPage) return this.call(message);
    const keyed = await this.call(
      { name: "apikey", arguments: [...(this.options.apiKeys ?? []), ...GUIDE_API_KEYS] },
      GUIDE_ORIGIN,
    );
    if (keyed.success === false) return keyed;
    return this.call(message, GUIDE_ORIGIN);
  }

  private async sendApiKeys(): Promise<void> {
    if (this.keyed || !this.options.apiKeys?.length) return;
    const answer = await this.call({ name: "apikey", arguments: this.options.apiKeys });
    if (answer.success === false) {
      throw new EImzoError("EIMZO_FAILED", `E-IMZO refused the API key: ${String(answer.reason ?? "")}`);
    }
    this.keyed = true;
  }

  /** The E-IMZO version, to see that it runs. */
  async version(): Promise<Answer> {
    return this.call({ name: "version" });
  }

  /** The keys E-IMZO can see (files on disks; ID cards and tokens are not offered here). */
  async listCertificates(): Promise<EImzoCertificate[]> {
    const answer = await this.ask("pfx", "list_all_certificates");
    const list = Array.isArray(answer.certificates) ? (answer.certificates as Record<string, unknown>[]) : [];
    const certificates: EImzoCertificate[] = [];
    for (const item of list) {
      const alias = String(item.alias ?? "");
      const x = parseAlias(alias);
      const tin = x.INN ?? x.UID ?? "";
      const pinfl = x.PINFL ?? "";
      if (!tin && !pinfl) continue;
      certificates.push({
        disk: String(item.disk ?? ""),
        path: String(item.path ?? ""),
        name: String(item.name ?? ""),
        alias,
        serialNumber: x.SERIALNUMBER ?? "",
        tin,
        pinfl,
        commonName: x.CN ?? "",
        organization: x.O ?? "",
        validFrom: certificateDate(x.VALIDFROM ?? ""),
        validTo: certificateDate(x.VALIDTO ?? ""),
      });
    }
    return certificates;
  }

  /** Opens a key for signing; E-IMZO asks for its password. The id is good for 24 hours. */
  async loadKey(certificate: EImzoCertificate): Promise<string> {
    const answer = await this.ask("pfx", "load_key", [
      certificate.disk,
      certificate.path,
      certificate.name,
      certificate.alias,
    ]);
    const id = typeof answer.keyId === "string" ? answer.keyId : null;
    if (!id) throw new EImzoError("EIMZO_FAILED", "E-IMZO sent no key id");
    return id;
  }

  /**
   * The data (base64) signed with the key, as a PKCS#7 document with the data inside, and what is
   * needed to have the signature time-stamped (E-IMZO gives the signature and the signer's serial next
   * to the document).
   */
  async createPkcs7(
    keyId: string,
    dataBase64: string,
  ): Promise<{ pkcs7: string; signatureHex: string; signerSerial: string; answered: string[] }> {
    const answer = await this.ask("pkcs7", "create_pkcs7", [dataBase64, keyId, "no"]);
    const pkcs7 = typeof answer.pkcs7_64 === "string" ? answer.pkcs7_64 : null;
    if (!pkcs7) throw new EImzoError("EIMZO_FAILED", "E-IMZO sent no signature");
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    return {
      pkcs7,
      signatureHex: text(answer.signature_hex),
      signerSerial: text(answer.signer_serial_number),
      answered: Object.keys(answer),
    };
  }

  /** The PKCS#7 with a time stamp token (base64, from a time stamp server) attached to the signer's signature. */
  async attachTimestamp(pkcs7: string, signerSerial: string, token: string): Promise<string> {
    const answer = await this.ask("pkcs7", "attach_timestamp_token_pkcs7", [pkcs7, signerSerial, token]);
    const stamped = typeof answer.pkcs7_64 === "string" ? answer.pkcs7_64 : null;
    if (!stamped) throw new EImzoError("EIMZO_FAILED", "E-IMZO sent no PKCS#7 with the time stamp");
    return stamped;
  }
}

function unavailable(detail: unknown): EImzoError {
  const text = detail instanceof Error ? detail.message : typeof detail === "string" ? detail : "";
  return new EImzoError(
    "EIMZO_UNAVAILABLE",
    `E-IMZO is not running on this PC, or it refused the connection${text ? ` (${text})` : ""}`,
  );
}

export interface SignerChoice {
  /** The key's serial number (hex), or the company's INN, to pick it when there are several. */
  serialNumber?: string;
  tin?: string;
  /** Overridable for tests. */
  now?: () => Date;
}

/** The key to use: the one asked for, else the only one that is valid now. */
export function chooseCertificate(
  certificates: EImzoCertificate[],
  choice: SignerChoice,
  now = new Date(),
): EImzoCertificate {
  const valid = certificates.filter(
    (c) => (!c.validFrom || c.validFrom <= now) && (!c.validTo || c.validTo >= now),
  );
  const matching = valid.filter(
    (c) =>
      (!choice.serialNumber || c.serialNumber.toUpperCase() === choice.serialNumber.toUpperCase()) &&
      (!choice.tin || c.tin === choice.tin),
  );
  if (matching.length === 1 && matching[0]) return matching[0];
  if (matching.length === 0) {
    throw new EImzoError(
      "EIMZO_NO_KEY",
      valid.length === 0
        ? "E-IMZO shows no valid signature key on this PC"
        : "None of the keys E-IMZO shows is the one chosen for this company",
    );
  }
  throw new EImzoError(
    "EIMZO_NO_KEY",
    `E-IMZO shows ${matching.length} valid keys: choose which one this company signs with`,
  );
}

/** Signs for Didox with the accountant's E-IMZO key. */
export class EImzoSigner implements DidoxSigner {
  private certificate: EImzoCertificate | null = null;
  private key: { id: string; at: number } | null = null;

  constructor(
    private readonly client: EImzoClient,
    private readonly choice: SignerChoice = {},
  ) {}

  private async chosen(): Promise<EImzoCertificate> {
    this.certificate ??= chooseCertificate(
      await this.client.listCertificates(),
      this.choice,
      this.choice.now?.() ?? new Date(),
    );
    return this.certificate;
  }

  async serialNumber(): Promise<string> {
    return (await this.chosen()).serialNumber;
  }

  async pkcs7(data: string, stamp?: Stamper): Promise<string> {
    const certificate = await this.chosen();
    const dataBase64 = Buffer.from(data, "utf8").toString("base64");
    const keyId = async (fresh: boolean) => {
      // A key id lives 24 hours; the password stays in E-IMZO's memory with it.
      if (!fresh && this.key && Date.now() - this.key.at < 23 * 3_600_000) return this.key.id;
      const id = await this.client.loadKey(certificate);
      this.key = { id, at: Date.now() };
      return id;
    };
    let signed;
    try {
      signed = await this.client.createPkcs7(await keyId(false), dataBase64);
    } catch (e) {
      // The key id lapsed (E-IMZO restarted, or 24 hours passed): open the key again, once.
      // "Ключ … не найден" (the id lapsed), not "Функция не найдена" (this E-IMZO lacks the function).
      const lapsed =
        e instanceof EImzoError &&
        /не найден|not found/i.test(e.message) &&
        !/функци|function/i.test(e.message);
      if (!(e instanceof EImzoError && e.code === "EIMZO_FAILED" && lapsed)) {
        throw e;
      }
      signed = await this.client.createPkcs7(await keyId(true), dataBase64);
    }
    if (!stamp) return signed.pkcs7;
    if (!signed.signatureHex || !signed.signerSerial) {
      throw new EImzoError(
        "EIMZO_FAILED",
        `E-IMZO gave no signature value or signer serial to time-stamp (it answered: ${signed.answered.join(", ")})`,
      );
    }
    const token = await stamp({ pkcs7: signed.pkcs7, signatureHex: signed.signatureHex });
    try {
      return await this.client.attachTimestamp(signed.pkcs7, signed.signerSerial, token);
    } catch (e) {
      // An E-IMZO without attach_timestamp_token_pkcs7 ("Функция не найдена"): the token is put in here.
      if (!(e instanceof EImzoError && /функци|function/i.test(e.message))) throw e;
      try {
        return attachTimestampToken(signed.pkcs7, token);
      } catch (inside) {
        const why = inside instanceof Error ? inside.message : String(inside);
        throw new EImzoError(
          "EIMZO_FAILED",
          `${e.message} (and attaching the time stamp here failed: ${why})`,
        );
      }
    }
  }
}
