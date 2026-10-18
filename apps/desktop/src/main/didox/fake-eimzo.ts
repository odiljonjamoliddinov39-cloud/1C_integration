import type { SocketLike } from "./eimzo.js";

export interface FakeCertificate {
  disk: string;
  path: string;
  name: string;
  alias: string;
}

/** An E-IMZO that answers like the real one: one answer per connection. For tests and the demo. */
export class FakeEImzo {
  readonly messages: Record<string, unknown>[] = [];
  certificates: FakeCertificate[] = [];
  /** Key ids that are no longer known (E-IMZO restarted). */
  forgotten = new Set<string>();
  private loaded = 0;
  down = false;
  /** An E-IMZO that refuses every call but `version` unless the connection came from `http://localhost` and sent a key first. */
  requireApiKey = false;
  /** An E-IMZO that sends the PKCS#7 but not the signature value and signer serial a time stamp needs. */
  omitSignatureValue = false;

  /** The origin of each connection made, in order (undefined: no page, as a desktop app). */
  readonly origins: (string | undefined)[] = [];

  readonly connect = (_url?: string, origin?: string): SocketLike => {
    if (this.down) throw new Error("ECONNREFUSED");
    this.origins.push(origin);
    let keyed = false;
    const socket: SocketLike = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (text) => {
        const message = JSON.parse(text) as { plugin?: string; name: string; arguments?: unknown[] };
        this.messages.push(message);
        let answer = this.answer(message);
        if (message.name === "apikey" && this.requireApiKey) {
          keyed = origin === "http://localhost" && (message.arguments ?? []).includes("localhost");
          answer = keyed
            ? { success: true }
            : { success: false, reason: "API-key для домена null недействителен." };
        } else if (this.requireApiKey && !keyed && message.name !== "version") {
          answer = { success: false, reason: "API-key для домена null недействителен." };
        }
        queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(answer) }));
      },
      close: () => {},
    };
    queueMicrotask(() => socket.onopen?.());
    return socket;
  };

  private answer(m: { plugin?: string; name: string; arguments?: unknown[] }): unknown {
    if (m.name === "apikey") return { success: true };
    if (m.name === "version") return { success: true, major: "6", minor: "0" };
    if (m.name === "list_all_certificates") return { success: true, certificates: this.certificates };
    if (m.name === "load_key") return { success: true, keyId: `key-${++this.loaded}` };
    if (m.name === "create_pkcs7") {
      const id = String(m.arguments?.[1]);
      if (this.forgotten.has(id) || !id.startsWith("key-")) {
        return { success: false, reason: "Ключ по идентификатору не найден" };
      }
      return {
        success: true,
        pkcs7_64: Buffer.from(`SIGNED(${id}):${String(m.arguments?.[0])}`).toString("base64"),
        ...(this.omitSignatureValue ? {} : { signature_hex: "ab12", signer_serial_number: "5a3c0f11" }),
      };
    }
    if (m.name === "attach_timestamp_token_pkcs7") {
      const [pkcs7, serial, token] = (m.arguments ?? []).map(String);
      return {
        success: true,
        pkcs7_64: Buffer.from(`STAMPED(${serial},${token}):${pkcs7}`).toString("base64"),
      };
    }
    return { success: false, reason: `unknown ${m.name}` };
  }
}
