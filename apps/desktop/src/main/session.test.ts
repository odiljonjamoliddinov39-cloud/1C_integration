import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LicenseClaims } from "@platform/shared";
import { SignJWT, importPKCS8 } from "jose";
import { beforeEach, describe, expect, it } from "vitest";

import { ControlClient } from "./control-client.js";
import { readLicense } from "./license.js";
import { SessionService } from "./session.js";
import { LocalStore, type SecretBox } from "./store.js";

const secrets: SecretBox = {
  encrypt: (plain) => "enc:" + Buffer.from(plain).toString("base64"),
  decrypt: (enc) => Buffer.from(enc.slice(4), "base64").toString(),
};
const keys = generateKeyPairSync("ed25519");
const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const MACHINE = "c".repeat(64);
const DAY = 86400;

/** A stand-in for apps/api, signing real Ed25519 license tokens. */
class FakeControl {
  offline = false;
  status: LicenseClaims["status"] = "trial";
  tokenDays = 7;
  refreshValid = true;
  loggedOut: string[] = [];
  private refresh = "refresh-token-0123456789-abc";

  fetch: typeof fetch = async (input, init) => {
    if (this.offline) throw new TypeError("fetch failed");
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    const signedIn = () => ({
      accessToken: "access",
      expiresIn: 900,
      refreshToken: this.refresh,
      me: {
        user: { id: "u1", email: "acc@example.com", name: "Acc", role: "owner" },
        account: { id: "a1", name: "Buxgalter MChJ" },
        subscription: { plan: "trial", status: this.status, endsAt: "2026-10-18T00:00:00.000Z" },
      },
    });
    switch (path) {
      case "/v1/auth/login":
        return body.password === "right-password"
          ? json(200, signedIn())
          : json(401, { code: "INVALID_CREDENTIALS", message: "Wrong" });
      case "/v1/auth/register":
        return json(200, signedIn());
      case "/v1/auth/refresh":
        if (!this.refreshValid) return json(401, { code: "INVALID_REFRESH", message: "Sign in again" });
        this.refresh = `rotated-${randomUUID()}`;
        return json(200, { accessToken: "access2", expiresIn: 900, refreshToken: this.refresh });
      case "/v1/auth/logout":
        this.loggedOut.push(body.refreshToken);
        return new Response(null, { status: 204 });
      case "/v1/license/public-key":
        return json(200, { publicKey: publicPem });
      case "/v1/devices/activate":
      case "/v1/license/check":
        return json(200, await this.license(body.machineId));
    }
    return json(404, { code: "NOT_FOUND", message: path });
  };

  async license(machineId: string) {
    const iat = Math.floor(Date.now() / 1000);
    const claims: LicenseClaims = {
      sub: "u1",
      acc: "a1",
      dev: "d1",
      mid: machineId,
      plan: "trial",
      status: this.status,
      paidUntil: "2026-10-18T00:00:00.000Z",
      maxCompanies: 5,
      jti: randomUUID(),
      iat,
      exp: iat + this.tokenDays * DAY,
    };
    const licenseToken = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: "EdDSA" })
      .sign(await importPKCS8(privatePem, "EdDSA"));
    return { licenseToken, claims };
  }
}

describe("SessionService", () => {
  let control: FakeControl;
  let store: LocalStore;
  let file: string;
  let service: SessionService;
  const signIn = {
    serverUrl: "https://1-2-3-4.sslip.io/",
    email: "acc@example.com",
    password: "right-password",
  };

  beforeEach(() => {
    control = new FakeControl();
    file = join(mkdtempSync(join(tmpdir(), "session-")), "platform.json");
    store = new LocalStore(file, secrets);
    service = new SessionService({
      store,
      machineId: async () => MACHINE,
      deviceName: "BUX-PC",
      bakedPublicKey: "",
      clientFor: (url) => new ControlClient(url, control.fetch),
    });
  });

  it("signs in, activates this PC and verifies the signed license", async () => {
    const result = await service.signIn(signIn);
    expect(result).toMatchObject({
      ok: true,
      data: {
        accountName: "Buxgalter MChJ",
        serverUrl: "https://1-2-3-4.sslip.io",
        license: { plan: "trial", status: "trial", mode: "active", reason: null },
      },
    });
    const saved = readFileSync(file, "utf8");
    expect(saved).not.toContain("refresh-token-0123456789-abc");
    expect(saved).not.toContain("right-password");
  });

  it("explains failures with codes", async () => {
    expect(await service.signIn({ ...signIn, password: "nope" })).toMatchObject({
      ok: false,
      code: "INVALID_CREDENTIALS",
    });
    control.offline = true;
    expect(await service.signIn(signIn)).toMatchObject({ ok: false, code: "OFFLINE" });
    expect(await service.view()).toBeNull();
  });

  it("refuses a server whose license signature does not match the baked key", async () => {
    const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    const pinned = new SessionService({
      store,
      machineId: async () => MACHINE,
      deviceName: "PC",
      bakedPublicKey: other,
      clientFor: (url) => new ControlClient(url, control.fetch),
    });
    expect(await pinned.signIn(signIn)).toMatchObject({ ok: false, code: "LICENSE_INVALID" });
    expect(store.session).toBeNull();
  });

  it("re-checks the license, rotating the refresh token; offline keeps the last license", async () => {
    await service.signIn(signIn);
    const before = store.session!.licenseToken;
    expect((await service.refreshLicense())?.license?.mode).toBe("active");
    expect(store.session!.licenseToken).not.toBe(before);
    expect(store.decrypt(store.session!.refreshTokenEnc)).toMatch(/^rotated-/);

    control.offline = true;
    const offline = await service.refreshLicense();
    expect(offline?.license?.mode).toBe("active");
  });

  it("goes read-only when the subscription is suspended", async () => {
    control.status = "suspended";
    const result = await service.signIn(signIn);
    expect(result.ok && result.data.license).toMatchObject({ mode: "read_only", reason: "suspended" });
  });

  it("signs out when the server rejects the session, and on sign-out", async () => {
    await service.signIn(signIn);
    control.refreshValid = false;
    expect(await service.refreshLicense()).toBeNull();

    control.refreshValid = true;
    await service.signIn(signIn);
    await service.signOut();
    expect(store.session).toBeNull();
    expect(control.loggedOut).toHaveLength(1);
  });
});

describe("readLicense", () => {
  async function token(claims: Partial<LicenseClaims>) {
    const iat = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub: "u",
      acc: "a",
      dev: "d",
      mid: MACHINE,
      plan: "trial",
      status: "trial",
      paidUntil: "x",
      maxCompanies: 5,
      jti: "j",
      iat,
      exp: iat + 7 * DAY,
      ...claims,
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .sign(await importPKCS8(privatePem, "EdDSA"));
  }

  it("is read-only after 7 days offline, on another PC, or with a forged token", async () => {
    const now = new Date();
    const valid = await token({});
    expect((await readLicense(valid, publicPem, MACHINE, "", now)).mode).toBe("active");
    const in8days = new Date(now.getTime() + 8 * DAY * 1000);
    expect(await readLicense(valid, publicPem, MACHINE, "", in8days)).toMatchObject({
      mode: "read_only",
      reason: "expired_offline",
    });
    expect(await readLicense(valid, publicPem, "d".repeat(64), "", now)).toMatchObject({
      reason: "wrong_machine",
    });
    const forged = valid.slice(0, -4) + "AAAA";
    expect(await readLicense(forged, publicPem, MACHINE, "", now)).toMatchObject({ reason: "invalid" });
  });
});
