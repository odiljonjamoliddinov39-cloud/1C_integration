import type { DidoxSigner, Stamper } from "./client.js";

/** A signer that signs nothing real: for tests and the demo, where there is no E-IMZO. */
export class FakeSigner implements DidoxSigner {
  readonly signed: string[] = [];
  constructor(private readonly serial = "5A3C0F") {}
  async serialNumber(): Promise<string> {
    return this.serial;
  }
  async pkcs7(data: string, stamp?: Stamper): Promise<string> {
    this.signed.push(data);
    const pkcs7 = Buffer.from(`PKCS7:${data}`).toString("base64");
    if (!stamp) return pkcs7;
    const token = await stamp({ pkcs7, signatureHex: Buffer.from(data).toString("hex") });
    return Buffer.from(`TS:${token}:${pkcs7}`).toString("base64");
  }
}

export interface FakeRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A stand-in for the Didox server: the sign-in handshake, a list of documents and archives to
 * download. `fetch` can be handed to DidoxClient.
 */
export class FakeDidox {
  readonly requests: FakeRequest[] = [];
  /** Archives by document id (a zip as the Didox site gives it). */
  archives = new Map<string, Uint8Array>();
  documents: { id: string; doctype: string; status: number; owner: 0 | 1 }[] = [];
  /** Tokens that were issued and have not been revoked. */
  private readonly tokens = new Set<string>();
  private issued = 0;
  /** What /v1/dsvs/gettimestamp understands; anything else gets the empty token the real one gives. */
  timestampTakes: "signature-json" | "signature-text" | "pkcs7-json" | "pkcs7-text" = "signature-json";
  /** Makes the next authorized request answer 401, as a token that lapsed. */
  expireTokens(): void {
    this.tokens.clear();
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

    if (url.host === "files.didox.test") {
      const bytes = this.archives.get(url.pathname.slice(1));
      return bytes ? new Response(bytes.slice().buffer as ArrayBuffer) : new Response("", { status: 404 });
    }
    const path = url.pathname;
    if (path.startsWith("/v1/auth/authId/")) return json({ authId: `auth-${path.split("/").pop()}` });
    if (path === "/v1/dsvs/gettimestamp") {
      const [what, how] = this.timestampTakes.split("-") as ["signature" | "pkcs7", "json" | "text"];
      const sent = typeof body === "string" ? body : (body as Record<string, string> | undefined)?.[what];
      const fits = (how === "text") === (typeof body === "string") && Boolean(sent);
      const hex = what === "signature" && fits && /^[0-9a-f]+$/.test(String(sent));
      const understood = fits && (what === "pkcs7" || hex);
      return json({
        success: true,
        timeStampTokenB64: understood ? Buffer.from(`TST(${sent})`).toString("base64") : "",
        isAttachedPkcs7: false,
      });
    }
    if (path === "/v1/auth/login") {
      const sent = body as { serialNumber?: string; pkcs7?: string } | undefined;
      if (!sent?.pkcs7) return json({ error: "no signature" }, 400);
      // The fake signer writes "TS:<token>:…", the fake E-IMZO "STAMPED(<serial>,<token>):…".
      const stamp = /^(?:TS:|STAMPED\([^,]*,)([^:)]*)/.exec(
        Buffer.from(sent.pkcs7, "base64").toString(),
      )?.[1];
      if (
        !Buffer.from(stamp ?? "", "base64")
          .toString()
          .startsWith("TST(")
      ) {
        return json({ error: "Unauthorized. Invalid signature: Eimzo fail. timestamp is required" }, 401);
      }
      const token = `token-${++this.issued}`;
      this.tokens.add(token);
      return json({ token });
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
    const archive = /^\/v1\/documents\/([^/]+)\/downloadrequest$/.exec(path);
    if (archive?.[1]) {
      return this.archives.has(archive[1])
        ? new Response(`https://files.didox.test/${archive[1]}`)
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
