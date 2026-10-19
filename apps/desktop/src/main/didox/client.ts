/**
 * Didox (the electronic document exchange) over its REST API, as Didox's own 1C library ("Библиотека
 * электронных документов для Узбекистана", given by Didox) calls it (docs/didox.md). Runs on the PC: the
 * accountant's key and the tokens never go to our server.
 *
 * Sign-in is by the accountant's E-IMZO key: the key's serial number gives an authId, the app signs
 * `{"authId": "..."}` (PKCS#7) with the key, has Didox time-stamp the signature (/v1/dsvs/timestamp), and
 * sends it to /v1/auth/{taxId}/token, which returns a token. With a person's key the token is then
 * exchanged for the company's (/v1/auth/company/{tin}/login). Every later request carries the token as
 * both `api-key` and `user-key`. The signing itself is a DidoxSigner (E-IMZO runs on the PC).
 *
 * Shapes Didox's documents do not show (the document list and a document's details) are returned as
 * they come (`unknown`).
 */

import { readTimestampToken, stampsSignature } from "./cms.js";

/** The accountant's E-IMZO key, as far as sign-in and signing are concerned. */
export interface DidoxSigner {
  /** The key's serial number in hexadecimal. */
  serialNumber(): Promise<string>;
  /** The tax number the key is for (the company's INN for a company's key, else the person's); "" if unknown. */
  taxId?(): Promise<string>;
  /**
   * The data signed with the key, as PKCS#7 (base64). With `stamp`, the signature's time stamp token is
   * asked of it and attached, as Didox wants.
   */
  pkcs7(data: string, stamp?: Stamper): Promise<string>;
}

/** What is known of a fresh signature, for asking the time stamp token for it. */
export interface SignedData {
  /** The PKCS#7 (base64) as E-IMZO made it. */
  pkcs7: string;
  /** The signature value in hexadecimal, as E-IMZO gives it next to the PKCS#7. */
  signatureHex: string;
}
/**
 * What Didox's time stamp service gives: a token to attach to the signature, or (`attached`) the signature
 * with the token already in it, which is then used as it is.
 */
export interface Stamped {
  value: string;
  attached: boolean;
}
/** Asks for the time stamp of a signature. */
export type Stamper = (signed: SignedData) => Promise<Stamped>;

export interface DidoxConfig {
  /** Didox's test server is the default; production is `https://api.didox.uz/`. */
  baseUrl?: string;
  /** A key sent as `api-key` on the requests made before sign-in (Didox's own library sends none). */
  apiKey?: string;
  /** The company to work for when the key is a person's: its INN (the token is exchanged for the company's). */
  companyTin?: string;
  fetch?: typeof fetch;
}

/** Didox's test server and its production server, as in Didox's own 1C library. */
export const DIDOX_DEV_URL = "https://testapi2.didox.uz/";
export const DIDOX_PROD_URL = "https://api.didox.uz/";

/**
 * The server address only: a page URL pasted from the browser (`https://didox.uz/documents/…`) is cut to
 * its server, and the site's own name (didox.uz) is taken for the API's (api.didox.uz).
 */
export function didoxServer(address: string | undefined): string {
  const text = (address ?? "").trim();
  if (text === "") return DIDOX_DEV_URL.replace(/\/+$/, "");
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
    const host = ["didox.uz", "www.didox.uz"].includes(url.host.toLowerCase()) ? "api.didox.uz" : url.host;
    return `${url.protocol}//${host}`;
  } catch {
    return text.replace(/\/+$/, "");
  }
}

export type DidoxErrorCode =
  | "DIDOX_AUTH"
  | "DIDOX_HTTP"
  | "DIDOX_NETWORK"
  | "DIDOX_RESPONSE"
  /** This Didox has no time stamp service (the route answers 404/405): not a refusal of the signature. */
  | "DIDOX_NO_TIMESTAMP";

export class DidoxError extends Error {
  constructor(
    readonly code: DidoxErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Document types of /v1/documents?doctype=… */
export const DIDOX_DOCTYPES = {
  "006": "Power of attorney",
  "061": "Power of attorney (Didox only)",
  "005": "Act",
  "001": "Invoice",
  "002": "Invoice without an act",
  "021": "Invoice, return",
  "008": "Invoice (pharma)",
  "081": "Invoice (pharma), return",
  "000": "Free-form document",
} as const;

/** Document statuses of /v1/documents?status=… */
export const DIDOX_STATUS = {
  created: 0,
  signedBySelf: 1,
  signedByPartner: 2,
  signed: 3,
  rejected: 4,
  deleted: 5,
  waitForAgentSign: 6,
  signedByAgent: 8,
  notValid: 40,
  partnerWaitForAgentSign: 60,
} as const;

export interface DocumentQuery {
  /** Comma-separated types, e.g. "001,002". */
  doctype?: string;
  /** Comma-separated statuses, e.g. "2,3". Without it Didox returns all but created and deleted. */
  status?: string;
  /** 0 incoming, 1 outgoing. */
  owner?: 0 | 1;
  page?: number;
  limit?: number;
  /** YYYY-MM-DD, by the document's update date. */
  dateFrom?: string;
  dateTo?: string;
  /** The partner's tax number. */
  partner?: string;
}

const TOKEN_LIFETIME_MS = 24 * 3_600_000;
/** Renewed a little early, so a request never leaves with a token about to lapse. */
const TOKEN_MARGIN_MS = 5 * 60_000;

/** A body that is a bare string or an object holding it under one of these names. */
function textField(body: unknown, names: string[]): string | null {
  if (typeof body === "string" && body.trim()) return body.trim().replace(/^"|"$/g, "");
  if (typeof body === "object" && body !== null) {
    for (const name of names) {
      const value = (body as Record<string, unknown>)[name];
      if (typeof value === "string" && value) return value;
    }
    const data = (body as Record<string, unknown>).data;
    if (data !== undefined) return textField(data, names);
  }
  return null;
}

export class DidoxClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private token: { value: string; expiresAt: number } | null = null;
  /** How the last sign-in's time stamp was got, for the error when Didox still refuses it. */
  private stamped = "";
  /** A sign-in is under way: a 401 inside it is its own answer, not a reason to sign in again. */
  private signingIn = false;

  constructor(
    private readonly config: DidoxConfig = {},
    private readonly signer?: DidoxSigner,
  ) {
    this.baseUrl = didoxServer(config.baseUrl);
    this.fetcher = config.fetch ?? fetch;
  }

  /** A token obtained elsewhere (kept from an earlier sign-in). */
  setToken(value: string, expiresAt: number): void {
    this.token = { value, expiresAt };
  }

  get signedIn(): boolean {
    return this.token !== null && this.token.expiresAt - TOKEN_MARGIN_MS > Date.now();
  }

  /** Signs in with the accountant's key. */
  async login(): Promise<void> {
    this.signingIn = true;
    try {
      await this.signIn();
    } finally {
      this.signingIn = false;
    }
  }

  private async signIn(): Promise<void> {
    const signer = this.signer;
    if (!signer) throw new DidoxError("DIDOX_AUTH", "No E-IMZO key is available to sign in with");
    const serialNumber = await signer.serialNumber();
    const taxId = (await signer.taxId?.()) ?? "";
    const authIdBody = await this.request("GET", `/v1/auth/authId/${encodeURIComponent(serialNumber)}`, {
      auth: false,
    });
    const authId = textField(authIdBody, ["authId", "authid", "id"]);
    if (!authId) throw new DidoxError("DIDOX_RESPONSE", "Didox sent no authId");
    this.stamped = "";
    const data = JSON.stringify({ authId });
    let pkcs7: string;
    try {
      pkcs7 = await signer.pkcs7(data, (signed) => this.timestampToken(signed));
    } catch (e) {
      // A Didox with no time stamp service (a site's web server answers 405 there) may not ask for a stamp:
      // sign without, and let the sign-in say whether it wants one.
      if (!(e instanceof DidoxError && e.code === "DIDOX_NO_TIMESTAMP")) throw e;
      this.stamped = "no time stamp: this Didox has no /v1/dsvs/timestamp";
      pkcs7 = await signer.pkcs7(data);
    }
    let loginBody: unknown;
    try {
      loginBody = await this.personLogin(serialNumber, taxId, pkcs7);
    } catch (e) {
      // What was stamped and how, to see why Didox does not take it.
      if (e instanceof DidoxError && this.stamped)
        throw new DidoxError(e.code, `${e.message} [${this.stamped}]`, e.status);
      throw e;
    }
    const value = textField(loginBody, ["token", "userKey", "user-key", "user_key"]);
    if (!value) throw new DidoxError("DIDOX_RESPONSE", "Didox sent no token");
    this.token = { value, expiresAt: Date.now() + TOKEN_LIFETIME_MS };

    // A person's key: the company's token is asked with the person's.
    const company = this.config.companyTin?.trim();
    if (company && company !== taxId) {
      const body = await this.request("POST", `/v1/auth/company/${encodeURIComponent(company)}/login`);
      const companyToken = textField(body, ["token", "userKey", "user-key", "user_key"]);
      if (!companyToken) throw new DidoxError("DIDOX_RESPONSE", "Didox sent no token for the company");
      this.token = { value: companyToken, expiresAt: Date.now() + TOKEN_LIFETIME_MS };
    }
  }

  /** The key's own sign-in: /v1/auth/{taxId}/token, or the older /v1/auth/login where that route is not. */
  private async personLogin(serialNumber: string, taxId: string, pkcs7: string): Promise<unknown> {
    const older = () =>
      this.request("POST", "/v1/auth/login", { auth: false, body: { serialNumber, pkcs7 } });
    if (!taxId) return older();
    try {
      return await this.request("POST", `/v1/auth/${encodeURIComponent(taxId)}/token`, {
        auth: false,
        body: { serialNumber, signature: pkcs7 },
      });
    } catch (e) {
      if (e instanceof DidoxError && (e.status === 404 || e.status === 405)) return older();
      throw e;
    }
  }

  /**
   * Didox refuses a signature with no time stamp ("Eimzo fail … timestamp is required"). Its time stamp
   * service takes the signature (`{"pkcs7", "signatureHex"}`, both) and answers
   * `{"success", "timeStampTokenB64", "isAttachedPkcs7"}`: with `isAttachedPkcs7` the value is the PKCS#7
   * with the token in it, else a token that is attached to the PKCS#7 (E-IMZO does it, or the app).
   * Didox's library calls /v1/dsvs/timestamp; the older collection names /v1/dsvs/gettimestamp.
   */
  async timestampToken({ pkcs7, signatureHex }: SignedData): Promise<Stamped> {
    const paths = ["/v1/dsvs/timestamp", "/v1/dsvs/gettimestamp"];
    const names = ["timeStampTokenB64", "timeStampToken", "tst", "token"];
    const seen: string[] = [];
    for (const path of paths) {
      try {
        const answer = await this.request("POST", path, { auth: false, body: { pkcs7, signatureHex } });
        const raw = textField(answer, names);
        if (!raw) {
          seen.push(`${path}: ${JSON.stringify(answer).slice(0, 160)}`);
          continue;
        }
        const attached =
          typeof answer === "object" &&
          answer !== null &&
          (answer as { isAttachedPkcs7?: unknown }).isAttachedPkcs7 === true;
        if (attached) {
          this.stamped = `time stamp from ${path}: attached to the PKCS#7 by Didox`;
          return { value: raw, attached: true };
        }
        // A token that says it stamps some other data is not this signature's.
        const read = readTimestampToken(raw);
        const stamps = read ? stampsSignature(read, signatureHex) : "unknown";
        this.stamped = `time stamp from ${path}: ${
          read
            ? `${read.wasResponse ? "a TimeStampResp, unwrapped" : "a token"}, ${read.algorithm} imprint ${read.imprint.slice(0, 16)}…, stamps the signature: ${stamps}`
            : `${Buffer.from(raw, "base64").length} bytes that are not a token the app can read`
        }`;
        if (stamps === "no") {
          seen.push(`${path}: a token for other data (${this.stamped})`);
          continue;
        }
        return { value: read?.contentInfo ?? raw, attached: false };
      } catch (e) {
        if (!(e instanceof DidoxError) || e.status === undefined || e.status < 400 || e.status >= 500)
          throw e;
        seen.push(`${path}: ${e.message}`);
      }
    }
    // Every route met a missing one (404/405, a web server's page): there is no time stamp service here.
    if (seen.length === paths.length && seen.every((line) => /answered (404|405|501)\b/.test(line))) {
      throw new DidoxError(
        "DIDOX_NO_TIMESTAMP",
        `Didox has no time stamp service (${seen[0]?.slice(0, 120)})`,
      );
    }
    throw new DidoxError("DIDOX_AUTH", `Didox gave no time stamp (${seen.join("; ")})`);
  }

  /** The profile of the signed-in company. */
  profile(): Promise<unknown> {
    return this.request("GET", "/v1/profile");
  }

  profileByTin(tin: string): Promise<unknown> {
    return this.request("GET", `/v1/profile/${encodeURIComponent(tin)}`);
  }

  /** Didox's list of units of measure (their ids go into the lines of a document). */
  measures(): Promise<unknown> {
    return this.request("GET", "/v1/measures/all");
  }

  /** The VAT registration code and status of a company. */
  vatStatus(tin: string): Promise<unknown> {
    return this.request("GET", `/v1/profile/vatRegStatus/${encodeURIComponent(tin)}`);
  }

  listDocuments(query: DocumentQuery = {}): Promise<unknown> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") params.set(key, String(value));
    }
    const qs = params.toString();
    return this.request("GET", `/v1/documents${qs ? `?${qs}` : ""}`);
  }

  countDocuments(query: DocumentQuery = {}): Promise<unknown> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") params.set(key, String(value));
    }
    const qs = params.toString();
    return this.request("GET", `/v1/documents/statistics/all${qs ? `?${qs}` : ""}`);
  }

  documentInfo(id: string): Promise<unknown> {
    return this.request("GET", `/v1/documents/${encodeURIComponent(id)}`);
  }

  /**
   * The print form of a document (the PDF of the page Didox shows, as Didox's own 1C library reads it):
   * the answer carries it as base64 in `file.data`.
   */
  async documentFile(id: string): Promise<Uint8Array> {
    const body = await this.request("GET", `/v1/documents/${encodeURIComponent(id)}/file/true`);
    const file = typeof body === "object" && body !== null ? (body as { file?: unknown }).file : undefined;
    const data = textField(file, ["data"]);
    if (!data) throw new DidoxError("DIDOX_RESPONSE", "Didox sent no file for this document");
    return new Uint8Array(Buffer.from(data, "base64"));
  }

  /** What Didox wants signed to accept, reject or cancel a document. */
  documentToSign(id: string, action: "accept" | "cancel" | "reject"): Promise<unknown> {
    return this.request("GET", `/v1/documents/${encodeURIComponent(id)}/tosign`, { body: { action } });
  }

  /** Creates a draft of a document of the given type (the body is Didox's own structure). */
  createDocument(docType: string, body: unknown): Promise<unknown> {
    return this.request("POST", `/v1/documents/${encodeURIComponent(docType)}/create`, { body });
  }

  signDocument(id: string, signature: string): Promise<unknown> {
    return this.request("POST", `/v1/documents/${encodeURIComponent(id)}/sign`, { body: { signature } });
  }

  rejectDocument(id: string, signature: string, comment: string): Promise<unknown> {
    return this.request("POST", `/v1/documents/${encodeURIComponent(id)}/reject`, {
      body: { signature, comment },
    });
  }

  /**
   * Request headers. After sign-in the token travels as both `api-key` and `user-key`, as Didox's own 1C
   * library sends it; before it, only a partner key if one was given.
   */
  private headers(auth: boolean): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (auth && this.token) {
      headers["api-key"] = this.token.value;
      headers["user-key"] = this.token.value;
    } else if (this.config.apiKey) headers["api-key"] = this.config.apiKey;
    return headers;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    options: { auth?: boolean; body?: unknown; text?: string } = {},
  ): Promise<unknown> {
    const auth = options.auth ?? true;
    if (auth && !this.signedIn && this.signer) await this.login();
    if (auth && !this.token) throw new DidoxError("DIDOX_AUTH", "Not signed in to Didox");
    for (let attempt = 0; ; attempt++) {
      const headers = this.headers(auth);
      const init: RequestInit = { method, headers };
      if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(options.body);
      } else if (options.text !== undefined) {
        headers["Content-Type"] = "text/plain";
        init.body = options.text;
      }
      let response: Response;
      try {
        response = await this.fetcher(`${this.baseUrl}${path}`, init);
      } catch (e) {
        throw new DidoxError("DIDOX_NETWORK", e instanceof Error ? e.message : String(e));
      }
      // A token that lapsed early is renewed once with the key, then the request goes again.
      if (response.status === 401 && auth && this.signer && attempt === 0 && !this.signingIn) {
        await this.login();
        continue;
      }
      const text = await response.text();
      // A web page (the site, not the API): the address is the site's. Said plainly, at the first request.
      if (/^\s*<(!doctype|html)/i.test(text)) {
        throw new DidoxError(
          "DIDOX_RESPONSE",
          `Didox answered ${response.status} with a web page, not the API: ${this.baseUrl} is the site's address. ` +
            `Use the address the API is on (the one your 1C Didox module connects to), with no page path.`,
          response.status,
        );
      }
      if (!response.ok) {
        throw new DidoxError(
          response.status === 401 || response.status === 403 ? "DIDOX_AUTH" : "DIDOX_HTTP",
          `Didox answered ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
          response.status,
        );
      }
      if (!text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
}
