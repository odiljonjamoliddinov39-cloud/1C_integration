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

  readonly connect = (): SocketLike => {
    if (this.down) throw new Error("ECONNREFUSED");
    const socket: SocketLike = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (text) => {
        const message = JSON.parse(text) as { plugin?: string; name: string; arguments?: unknown[] };
        this.messages.push(message);
        queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(this.answer(message)) }));
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
      };
    }
    return { success: false, reason: `unknown ${m.name}` };
  }
}
