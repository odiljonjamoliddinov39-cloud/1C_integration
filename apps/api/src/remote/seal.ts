/**
 * What waits in the mailbox is sealed with AES-256-GCM under the server's key (decision 2 of the design: server-key encryption, so
 * the server can hold a command while the PC is off). A sealed value is `v1.<iv>.<tag>.<ciphertext>` in base64url; a wrong key or
 * a changed value does not open.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export class Seal {
  private readonly key: Buffer;

  /** `secret` is REMOTE_ENCRYPTION_KEY or, when it is not set, the server's JWT secret (a key is derived from it either way). */
  constructor(secret: string) {
    this.key = Buffer.from(hkdfSync("sha256", secret, "platform-remote", "remote-channel-v1", 32));
  }

  seal(plain: string | Buffer): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return ["v1", iv, cipher.getAuthTag(), body]
      .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
      .join(".");
  }

  /** Null for a value that is not sealed with this key (or was changed). */
  open(sealed: string): Buffer | null {
    const [version, iv, tag, body] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || body === undefined) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]);
    } catch {
      return null;
    }
  }

  sealJson(value: unknown): string {
    return this.seal(JSON.stringify(value ?? null));
  }

  openJson<T = unknown>(sealed: string | null): T | null {
    if (sealed === null) return null;
    const plain = this.open(sealed);
    if (!plain) return null;
    try {
      return JSON.parse(plain.toString("utf8")) as T;
    } catch {
      return null;
    }
  }
}
