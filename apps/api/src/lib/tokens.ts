import { createHash, randomBytes, randomUUID } from "node:crypto";

import { type LicenseClaims } from "@platform/shared";
import { SignJWT, exportSPKI, importPKCS8, jwtVerify } from "jose";

import type { Config } from "../config.js";

const ISSUER = "platform-control";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export class Tokens {
  private readonly secret: Uint8Array;
  private licenseKey?: Awaited<ReturnType<typeof importPKCS8>>;
  private publicKeyPem?: string;

  constructor(private readonly config: Config) {
    this.secret = new TextEncoder().encode(config.JWT_SECRET);
  }

  async accessToken(userId: string, accountId: string): Promise<{ token: string; expiresIn: number }> {
    const expiresIn = this.config.ACCESS_TOKEN_MINUTES * 60;
    const token = await new SignJWT({ acc: accountId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(`${expiresIn}s`)
      .sign(this.secret);
    return { token, expiresIn };
  }

  async verifyAccess(token: string): Promise<{ userId: string; accountId: string } | null> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { issuer: ISSUER, algorithms: ["HS256"] });
      if (typeof payload.sub !== "string" || typeof payload.acc !== "string") return null;
      return { userId: payload.sub, accountId: payload.acc };
    } catch {
      return null;
    }
  }

  private async key() {
    this.licenseKey ??= await importPKCS8(this.config.LICENSE_PRIVATE_KEY, "EdDSA", { extractable: true });
    return this.licenseKey;
  }

  /** PEM the desktop app uses to check license tokens offline. */
  async publicKey(): Promise<string> {
    if (!this.publicKeyPem) {
      const { createPublicKey } = await import("node:crypto");
      const pub = createPublicKey(this.config.LICENSE_PRIVATE_KEY);
      this.publicKeyPem = await exportSPKI(pub);
    }
    return this.publicKeyPem;
  }

  async license(
    claims: Omit<LicenseClaims, "jti" | "iat" | "exp">,
  ): Promise<{ token: string; claims: LicenseClaims }> {
    const jti = randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + this.config.LICENSE_TOKEN_DAYS * 86400;
    const full: LicenseClaims = { ...claims, jti, iat, exp };
    const token = await new SignJWT({ ...full })
      .setProtectedHeader({ alg: "EdDSA", typ: "license+jwt" })
      .setIssuer(ISSUER)
      .sign(await this.key());
    return { token, claims: full };
  }
}
