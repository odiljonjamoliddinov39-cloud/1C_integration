import type { DidoxSigner, Stamper } from "./client.js";

/** A signer that signs nothing real: for tests and the demo, where there is no E-IMZO. */
export class FakeSigner implements DidoxSigner {
  readonly signed: string[] = [];
  constructor(
    private readonly serial = "5A3C0F",
    private readonly tax = "302936161",
  ) {}
  async serialNumber(): Promise<string> {
    return this.serial;
  }
  async taxId(): Promise<string> {
    return this.tax;
  }
  async pkcs7(data: string, stamp?: Stamper): Promise<string> {
    this.signed.push(data);
    const pkcs7 = Buffer.from(`PKCS7:${data}`).toString("base64");
    if (!stamp) return pkcs7;
    const stamped = await stamp({ pkcs7, signatureHex: Buffer.from(data).toString("hex") });
    if (stamped.attached) return stamped.value;
    return Buffer.from(`TS:${stamped.value}:${pkcs7}`).toString("base64");
  }
}

export interface FakeRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A stand-in for the Didox server: the sign-in handshake, a list of documents and their print forms. `fetch` can be handed to DidoxClient.
 */
export class FakeDidox {
  readonly requests: FakeRequest[] = [];
  /** Print forms by document id (a PDF). */
  files = new Map<string, Uint8Array>();
  documents: { id: string; doctype: string; status: number; owner: 0 | 1 }[] = [];
  /** Tokens that were issued and have not been revoked. */
  private readonly tokens = new Set<string>();
  private issued = 0;
  /** Didox puts the time stamp token into the PKCS#7 itself (`isAttachedPkcs7`), instead of giving the token. */
  attachesStamp = false;
  /** The older Didox: no /v1/auth/{taxId}/token, only /v1/auth/login. */
  hasPersonLogin = true;
  /** A Didox with no time stamp service (nginx answers 405), and one whose sign-in needs no time stamp. */
  hasTimestampEndpoint = true;
  requiresTimestamp = true;
  /** Makes the next authorized request answer 401, as a token that lapsed. */
  expireTokens(): void {
    this.tokens.clear();
  }

  /** The INNs the company's token was asked for. */
  readonly companyTokens: string[] = [];

  /** A sign-in with a signature: refused without the time stamp the sign-in requires. */
  private signIn(
    signature: string | undefined,
    json: (value: unknown, status?: number) => Response,
  ): Response {
    if (!signature) return json({ error: "no signature" }, 400);
    // The fake signer writes "TS:<token>:…", the fake E-IMZO "STAMPED(<serial>,<token>):…".
    const stamp = /^(?:TS:|STAMPED\([^,]*,)([^:)]*)/.exec(Buffer.from(signature, "base64").toString())?.[1];
    if (
      this.requiresTimestamp &&
      !Buffer.from(stamp ?? "", "base64")
        .toString()
        .startsWith("TST(")
    ) {
      return json({ error: "Unauthorized. Invalid signature: Eimzo fail. timestamp is required" }, 401);
    }
    const token = `token-${++this.issued}`;
    this.tokens.add(token);
    return json({ token, related_companies: [] });
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const asText = typeof init?.body === "string" && headers["content-type"] === "text/plain";
    const body =
      typeof init?.body === "string" ? (asText ? init.body : (JSON.parse(init.body) as unknown)) : undefined;
    this.requests.push({ method: init?.method ?? "GET", url, headers, body });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

    const path = url.pathname;
    if (path.startsWith("/v1/auth/authId/")) return json({ authId: `auth-${path.split("/").pop()}` });
    if (path === "/v1/dsvs/timestamp" || path === "/v1/dsvs/gettimestamp") {
      if (!this.hasTimestampEndpoint) {
        return new Response("<html><head><title>405 Not Allowed</title></head></html>", { status: 405 });
      }
      // Both the PKCS#7 and the signature value are asked for, as Didox's own library sends them.
      const sent = body as { pkcs7?: string; signatureHex?: string } | undefined;
      if (!sent?.pkcs7 || !sent.signatureHex) {
        return json({ success: true, timeStampTokenB64: "", isAttachedPkcs7: false });
      }
      const token = Buffer.from(`TST(${sent.signatureHex})`).toString("base64");
      return json({
        success: true,
        timeStampTokenB64: this.attachesStamp
          ? Buffer.from(`TS:${token}:${sent.pkcs7}`).toString("base64")
          : token,
        isAttachedPkcs7: this.attachesStamp,
      });
    }
    const personLogin = /^\/v1\/auth\/(\d+)\/token$/.exec(path);
    if (personLogin && !this.hasPersonLogin) return json({ error: "not found" }, 404);
    if (personLogin) {
      const sent = body as { serialNumber?: string; signature?: string } | undefined;
      return this.signIn(sent?.signature, json);
    }
    const companyLogin = /^\/v1\/auth\/company\/(\d+)\/login$/.exec(path);
    if (companyLogin) {
      if (!this.tokens.has(headers["user-key"] ?? "")) return json({ error: "unauthorized" }, 401);
      const token = `token-${++this.issued}`;
      this.tokens.add(token);
      this.companyTokens.push(companyLogin[1] ?? "");
      return json({ token });
    }
    if (path === "/v1/auth/login") {
      const sent = body as { serialNumber?: string; pkcs7?: string } | undefined;
      return this.signIn(sent?.pkcs7, json);
    }
    if (!this.tokens.has(headers["user-key"] ?? "")) return json({ error: "unauthorized" }, 401);
    if (path === "/v1/documents") {
      const owner = url.searchParams.get("owner");
      const doctypes = url.searchParams.get("doctype")?.split(",");
      return json(
        this.documents.filter(
          (d) => (owner === null || d.owner === Number(owner)) && (!doctypes || doctypes.includes(d.doctype)),
        ),
      );
    }
    const file = /^\/v1\/documents\/([^/]+)\/file\/true$/.exec(path);
    if (file?.[1]) {
      const bytes = this.files.get(file[1]);
      return bytes
        ? json({ file: { data: Buffer.from(bytes).toString("base64") } })
        : json({ error: "not found" }, 404);
    }
    const one = /^\/v1\/documents\/([^/]+)$/.exec(path);
    if (one?.[1]) {
      const found = this.documents.find((d) => d.id === one[1]);
      return found ? json(found) : json({ error: "not found" }, 404);
    }
    return json({ error: "not found" }, 404);
  };
}
