/**
 * Didox (the electronic document exchange) over its REST API, as documented in the
 * "DIDOX-1C-INTEGRATION" Postman collection (docs/didox.md). Runs on the PC: the accountant's key and
 * the tokens never go to our server.
 *
 * Sign-in is by the accountant's E-IMZO key: the key's serial number gives an authId, the app signs
 * `{"authId": "..."}` (PKCS#7) with the key and sends it to /v1/auth/login, which returns a token for
 * 24 hours. The signing itself is a DidoxSigner (E-IMZO runs on the PC); this client only asks for it.
 *
 * Shapes the collection does not show (the document list and a document's details) are returned as
 * they come (`unknown`), and what is assumed about the token header is in one place (headers()).
 */

/** The accountant's E-IMZO key, as far as sign-in and signing are concerned. */
export interface DidoxSigner {
  /** The key's serial number in hexadecimal. */
  serialNumber(): Promise<string>;
  /** The data signed with the key, as PKCS#7 (base64). */
  pkcs7(data: string): Promise<string>;
}

export interface DidoxConfig {
  /** The development server is the default; production is set when a company goes live. */
  baseUrl?: string;
  /** The partner key Didox gives an integrator (header api-key). */
  apiKey?: string;
  fetch?: typeof fetch;
}

export const DIDOX_DEV_URL = "https://devapi.goodsign.biz/";

export type DidoxErrorCode = "DIDOX_AUTH" | "DIDOX_HTTP" | "DIDOX_NETWORK" | "DIDOX_RESPONSE";

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

  constructor(
    private readonly config: DidoxConfig = {},
    private readonly signer?: DidoxSigner,
  ) {
    this.baseUrl = (config.baseUrl ?? DIDOX_DEV_URL).replace(/\/+$/, "");
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
    const signer = this.signer;
    if (!signer) throw new DidoxError("DIDOX_AUTH", "No E-IMZO key is available to sign in with");
    const serialNumber = await signer.serialNumber();
    const authIdBody = await this.request("GET", `/v1/auth/authId/${encodeURIComponent(serialNumber)}`, {
      auth: false,
    });
    const authId = textField(authIdBody, ["authId", "authid", "id"]);
    if (!authId) throw new DidoxError("DIDOX_RESPONSE", "Didox sent no authId");
    const pkcs7 = await signer.pkcs7(JSON.stringify({ authId }));
    const loginBody = await this.request("POST", "/v1/auth/login", {
      auth: false,
      body: { serialNumber, pkcs7 },
    });
    const value = textField(loginBody, ["token", "userKey", "user-key", "user_key"]);
    if (!value) throw new DidoxError("DIDOX_RESPONSE", "Didox sent no token");
    this.token = { value, expiresAt: Date.now() + TOKEN_LIFETIME_MS };
  }

  /** The profile of the signed-in company. */
  profile(): Promise<unknown> {
    return this.request("GET", "/v1/profile");
  }

  profileByTin(tin: string): Promise<unknown> {
    return this.request("GET", `/v1/profile/${encodeURIComponent(tin)}`);
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
   * The archive of a document (its XML, PDF and signatures, the zip the Didox site offers): Didox gives
   * a link that is good for 5 minutes, and the archive is fetched from it.
   */
  async downloadArchive(id: string): Promise<Uint8Array> {
    const body = await this.request("GET", `/v1/documents/${encodeURIComponent(id)}/downloadrequest`);
    const url = textField(body, ["url", "link", "href"]);
    if (!url || !/^https:\/\//i.test(url))
      throw new DidoxError("DIDOX_RESPONSE", "Didox sent no download link");
    let response: Response;
    try {
      // The link is signed: our keys are not sent to wherever it points.
      response = await this.fetcher(url);
    } catch (e) {
      throw new DidoxError("DIDOX_NETWORK", e instanceof Error ? e.message : String(e));
    }
    if (!response.ok)
      throw new DidoxError("DIDOX_HTTP", `The archive link answered ${response.status}`, response.status);
    return new Uint8Array(await response.arrayBuffer());
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

  /** Request headers. Whether the token travels as `user-key` is to be confirmed on the dev server. */
  private headers(auth: boolean): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.config.apiKey) headers["api-key"] = this.config.apiKey;
    if (auth && this.token) headers["user-key"] = this.token.value;
    return headers;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    options: { auth?: boolean; body?: unknown } = {},
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
      }
      let response: Response;
      try {
        response = await this.fetcher(`${this.baseUrl}${path}`, init);
      } catch (e) {
        throw new DidoxError("DIDOX_NETWORK", e instanceof Error ? e.message : String(e));
      }
      // A token that lapsed early is renewed once with the key, then the request goes again.
      if (response.status === 401 && auth && this.signer && attempt === 0) {
        await this.login();
        continue;
      }
      const text = await response.text();
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
