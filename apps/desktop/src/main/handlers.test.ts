import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OneCError } from "@platform/onec-client";
import { FakePlatform } from "@platform/onec-client/testing";
import { describe, expect, it } from "vitest";

import type { ConnectionInput } from "../shared/ipc.js";
import { InProcessConnector } from "./connector.js";
import { createHandlers } from "./handlers.js";
import { SessionService } from "./session.js";
import { infobaseKey } from "./onec-jobs.js";
import { LocalStore, type SecretBox, StoreError } from "./store.js";

// Stand-in for safeStorage: reversible, but never the plain text.
const secrets: SecretBox = {
  encrypt: (plain) => Buffer.from(plain).toString("base64").split("").reverse().join(""),
  decrypt: (enc) => Buffer.from(enc.split("").reverse().join(""), "base64").toString(),
};

function setup() {
  const file = join(mkdtempSync(join(tmpdir(), "platform-")), "platform.json");
  const bases = new Map<string, FakePlatform>();
  const seen: ConnectionInput[] = [];
  const connector = new InProcessConnector((connection) => {
    seen.push(connection);
    if (connection.password === "wrong")
      throw new OneCError("CONNECT_FAILED", "Неправильное имя или пароль пользователя");
    const key = infobaseKey(connection.infobase);
    if (!bases.has(key)) bases.set(key, new FakePlatform());
    return bases.get(key)!;
  });
  const store = new LocalStore(file, secrets);
  const handlers = createHandlers({
    store,
    session: new SessionService({
      store,
      machineId: async () => "m".repeat(64),
      deviceName: "PC",
      bakedPublicKey: "",
    }),
    connector,
    info: {
      version: "0.0.0",
      platform: "win32",
      arch: "x64",
      demo1C: false,
      defaultServerUrl: "http://localhost:3000",
    },
    pickFolder: async () => "D:\\Bases\\TEST",
  });
  return { handlers, file, seen, store };
}

const connection = {
  infobase: { kind: "file" as const, file: "D:\\Bases\\TEST" },
  user: "Admin",
  password: "secret-1C",
};

describe("desktop main handlers", () => {
  it("tests a connection, then connects the chosen organization", async () => {
    const { handlers, file } = setup();
    const test = await handlers.testConnection(connection);
    expect(test.status.ok).toBe(true);
    const org = test.organizations[0]!;

    const added = await handlers.addCompany({ ...connection, organization: org });
    expect(added).toMatchObject({
      ok: true,
      data: { name: org.name, inn: org.inn, lastStatus: { ok: true } },
    });
    expect(await handlers.listCompanies()).toHaveLength(1);
    // The 1C password is stored encrypted, never in plain text.
    expect(readFileSync(file, "utf8")).not.toContain("secret-1C");

    const again = await handlers.addCompany({ ...connection, organization: org });
    expect(again).toMatchObject({ ok: false, code: "DUPLICATE" });
  });

  it("reports 1C errors as a status instead of throwing", async () => {
    const { handlers } = setup();
    const test = await handlers.testConnection({ ...connection, password: "wrong" });
    expect(test.status).toMatchObject({ ok: false, code: "CONNECT_FAILED" });
    const invalid = await handlers.testConnection({
      infobase: { kind: "file", file: "" },
      user: "",
      password: "",
    });
    expect(invalid.status).toMatchObject({ ok: false, code: "VALIDATION" });
  });

  it("refuses an organization that the infobase does not have", async () => {
    const { handlers } = setup();
    const result = await handlers.addCompany({
      ...connection,
      organization: { ref: "00000000-0000-0000-0000-000000000000", name: "X", inn: "1" },
    });
    expect(result).toMatchObject({ ok: false, code: "ORGANIZATION_NOT_FOUND" });
  });

  it("re-checks a company with its stored (decrypted) credentials, and removes it", async () => {
    const { handlers, seen } = setup();
    const org = (await handlers.testConnection(connection)).organizations[0]!;
    const added = await handlers.addCompany({ ...connection, organization: org });
    if (!added.ok) throw new Error("not added");
    const checked = await handlers.checkStatus(added.data.id);
    expect(checked.lastStatus).toMatchObject({ ok: true });
    expect(seen.at(-1)?.password).toBe("secret-1C");
    await handlers.removeCompany(added.data.id);
    expect(await handlers.listCompanies()).toEqual([]);
  });

  it("keeps data across restarts", async () => {
    const { handlers, file } = setup();
    const org = (await handlers.testConnection(connection)).organizations[0]!;
    await handlers.addCompany({ ...connection, organization: org });
    const reopened = new LocalStore(file, secrets);
    expect(reopened.listCompanies()).toHaveLength(1);
    expect(reopened.connection(reopened.listCompanies()[0]!.id).password).toBe("secret-1C");
  });
});

describe("without secure storage", () => {
  it("refuses to save a 1C password instead of storing it in plain text", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "platform-")), "platform.json");
    const noKeyring: SecretBox = {
      encrypt: () => {
        throw new StoreError("SECURE_STORAGE", "Secure storage for passwords is not available");
      },
      decrypt: () => "",
    };
    const base = new FakePlatform();
    const store = new LocalStore(file, noKeyring);
    const handlers = createHandlers({
      store,
      session: new SessionService({
        store,
        machineId: async () => "m".repeat(64),
        deviceName: "PC",
        bakedPublicKey: "",
      }),
      connector: new InProcessConnector(() => base),
      info: { version: "0.0.0", platform: "linux", arch: "x64", demo1C: false, defaultServerUrl: "" },
      pickFolder: async () => null,
    });
    const org = (await handlers.testConnection(connection)).organizations[0]!;
    expect(await handlers.addCompany({ ...connection, organization: org })).toMatchObject({
      ok: false,
      code: "SECURE_STORAGE",
    });
    expect(await handlers.listCompanies()).toEqual([]);
  });
});
