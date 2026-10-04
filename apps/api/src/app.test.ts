import { generateKeyPairSync } from "node:crypto";

import { LicenseClaims } from "@platform/shared";
import { decodeJwt, importSPKI, jwtVerify } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, runMigrations } from "./db/client.js";
import { subscriptions } from "./db/schema.js";
import { effectiveStatus } from "./service.js";

// Needs PostgreSQL (CI starts one). Each run gets a fresh database.
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const TEST_DB = "platform_api_test";
const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
const available = await admin`select 1`.then(() => true).catch(() => false);

const { privateKey } = generateKeyPairSync("ed25519");
const machineId = "a".repeat(64);
const account = {
  email: "Owner@Example.com",
  password: "correct-horse-battery",
  name: "Owner",
  accountName: "Buxgalter MChJ",
};

describe.skipIf(!available)("control system API", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    const url = ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`);
    db = createDb(url);
    await runMigrations(db.db);
    app = await buildApp(
      db.db,
      loadConfig({
        DATABASE_URL: url,
        JWT_SECRET: "test-secret-that-is-long-enough-1234567890",
        LICENSE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        LOG_LEVEL: "silent",
      }),
    );
  });

  beforeEach(async () => {
    await db.sql`TRUNCATE accounts, refresh_tokens CASCADE`;
  });

  afterAll(async () => {
    await app?.close();
    await db?.sql.end();
    await admin.end();
  });

  const post = (url: string, payload: unknown, token?: string) =>
    app.inject({
      method: "POST",
      url,
      payload: payload as object,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  it("registers an account with a 14-day trial and signs in", async () => {
    const reg = await post("/v1/auth/register", account);
    expect(reg.statusCode).toBe(200);
    expect(reg.json().me).toMatchObject({
      user: { email: "owner@example.com", role: "owner" },
      account: { name: "Buxgalter MChJ" },
      subscription: { plan: "trial", status: "trial" },
    });
    expect((await post("/v1/auth/register", account)).json().code).toBe("EMAIL_TAKEN");

    const bad = await post("/v1/auth/login", { email: account.email, password: "wrong-password" });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe("INVALID_CREDENTIALS");
    const login = await post("/v1/auth/login", { email: "owner@example.com", password: account.password });
    expect(login.statusCode).toBe(200);
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${login.json().accessToken}` },
    });
    expect(me.json().user.name).toBe("Owner");
    expect((await app.inject({ method: "GET", url: "/v1/me" })).statusCode).toBe(401);
  });

  it("rotates refresh tokens: the old one stops working", async () => {
    const { refreshToken } = (await post("/v1/auth/register", account)).json();
    const first = await post("/v1/auth/refresh", { refreshToken });
    expect(first.statusCode).toBe(200);
    expect((await post("/v1/auth/refresh", { refreshToken })).json().code).toBe("INVALID_REFRESH");
    await post("/v1/auth/logout", { refreshToken: first.json().refreshToken });
    expect((await post("/v1/auth/refresh", { refreshToken: first.json().refreshToken })).statusCode).toBe(
      401,
    );
  });

  it("activates a PC and signs a license token the desktop can verify offline", async () => {
    const { accessToken } = (await post("/v1/auth/register", account)).json();
    const res = await post("/v1/devices/activate", { machineId, name: "BUX-PC" }, accessToken);
    expect(res.statusCode).toBe(200);
    const { licenseToken, claims } = res.json();
    expect(LicenseClaims.parse(claims)).toMatchObject({
      plan: "trial",
      status: "trial",
      mid: machineId,
      maxCompanies: 5,
    });
    expect(claims.exp - claims.iat).toBe(7 * 86400);

    const { publicKey } = (await app.inject({ method: "GET", url: "/v1/license/public-key" })).json();
    const { payload } = await jwtVerify(licenseToken, await importSPKI(publicKey, "EdDSA"));
    expect(payload.jti).toBe(claims.jti);

    const check = await post("/v1/license/check", { machineId }, accessToken);
    expect(check.statusCode).toBe(200);
    expect(decodeJwt(check.json().licenseToken).jti).not.toBe(claims.jti);
    expect((await post("/v1/license/check", { machineId: "b".repeat(64) }, accessToken)).json().code).toBe(
      "DEVICE_NOT_ACTIVATED",
    );
  });

  it("enforces the device limit of the plan", async () => {
    const { accessToken } = (await post("/v1/auth/register", account)).json();
    expect(
      (await post("/v1/devices/activate", { machineId: "1".repeat(64), name: "PC1" }, accessToken))
        .statusCode,
    ).toBe(200);
    expect(
      (await post("/v1/devices/activate", { machineId: "2".repeat(64), name: "PC2" }, accessToken))
        .statusCode,
    ).toBe(200);
    const third = await post("/v1/devices/activate", { machineId: "3".repeat(64), name: "PC3" }, accessToken);
    expect(third.statusCode).toBe(409);
    expect(third.json().code).toBe("DEVICE_LIMIT");
    // The same PC again is not a new device.
    expect(
      (await post("/v1/devices/activate", { machineId: "1".repeat(64), name: "PC1" }, accessToken))
        .statusCode,
    ).toBe(200);
  });

  it("reports an expired trial as grace, then suspended", async () => {
    const { accessToken } = (await post("/v1/auth/register", account)).json();
    await db.db.update(subscriptions).set({ endsAt: new Date(Date.now() - 2 * 86_400_000) });
    const res = await post("/v1/devices/activate", { machineId, name: "PC" }, accessToken);
    expect(res.json().claims.status).toBe("grace");
    await db.db.update(subscriptions).set({ endsAt: new Date(Date.now() - 4 * 86_400_000) });
    expect((await post("/v1/license/check", { machineId }, accessToken)).json().claims.status).toBe(
      "suspended",
    );
  });

  it("validates input", async () => {
    const res = await post("/v1/auth/register", { ...account, password: "short" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION");
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ ok: true });
  });
});

describe("effectiveStatus", () => {
  it("keeps paid time, then 3 days of grace, then suspended", () => {
    const end = new Date("2026-10-10T00:00:00Z");
    expect(effectiveStatus("active", end, new Date("2026-10-09T00:00:00Z"))).toBe("active");
    expect(effectiveStatus("active", end, new Date("2026-10-12T00:00:00Z"))).toBe("grace");
    expect(effectiveStatus("trial", end, new Date("2026-10-14T00:00:00Z"))).toBe("suspended");
    expect(effectiveStatus("cancelled", end, new Date("2026-10-01T00:00:00Z"))).toBe("cancelled");
  });
});
