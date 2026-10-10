/**
 * E-IMZO, the program on the accountant's PC that holds the electronic signature keys, over its local
 * WebSocket service (the protocol of the E-IMZO integration guide and its demo `e-imzo.js`): every call
 * is one short connection that sends one JSON message and gets one answer. The key's password is asked
 * by E-IMZO itself in its own window; this app never sees it.
 */
import type { DidoxSigner } from "./client.js";

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
export type Connect = (url: string) => SocketLike;

const defaultConnect: Connect = (url) => new WebSocket(url) as unknown as SocketLike;

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

  constructor(private readonly options: EImzoOptions = {}) {
    this.url = options.url ?? EIMZO_URL;
    this.connect = options.connect ?? defaultConnect;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  /** One call: connect, send, take the answer, close. The timeout is long, as the user may be typing a password. */
  private call(message: Record<string, unknown>): Promise<Answer> {
    return new Promise((resolve, reject) => {
      let socket: SocketLike;
      try {
        socket = this.connect(this.url);
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
    const answer = await this.call({ plugin, name, ...(args ? { arguments: args } : {}) });
    if (answer.success === false) {
      throw new EImzoError("EIMZO_FAILED", String(answer.reason ?? "E-IMZO refused the request"));
    }
    return answer;
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

  /** The data (base64) signed with the key, as a PKCS#7 document with the data inside. */
  async createPkcs7(keyId: string, dataBase64: string): Promise<string> {
    const answer = await this.ask("pkcs7", "create_pkcs7", [dataBase64, keyId, "no"]);
    const pkcs7 = typeof answer.pkcs7_64 === "string" ? answer.pkcs7_64 : null;
    if (!pkcs7) throw new EImzoError("EIMZO_FAILED", "E-IMZO sent no signature");
    return pkcs7;
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

  async pkcs7(data: string): Promise<string> {
    const certificate = await this.chosen();
    const dataBase64 = Buffer.from(data, "utf8").toString("base64");
    const keyId = async (fresh: boolean) => {
      // A key id lives 24 hours; the password stays in E-IMZO's memory with it.
      if (!fresh && this.key && Date.now() - this.key.at < 23 * 3_600_000) return this.key.id;
      const id = await this.client.loadKey(certificate);
      this.key = { id, at: Date.now() };
      return id;
    };
    try {
      return await this.client.createPkcs7(await keyId(false), dataBase64);
    } catch (e) {
      // The key id lapsed (E-IMZO restarted, or 24 hours passed): open the key again, once.
      if (e instanceof EImzoError && e.code === "EIMZO_FAILED" && /не найден|not found/i.test(e.message)) {
        return this.client.createPkcs7(await keyId(true), dataBase64);
      }
      throw e;
    }
  }
}
