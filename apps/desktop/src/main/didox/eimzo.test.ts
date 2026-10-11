import { describe, expect, it } from "vitest";

import { EImzoClient, EImzoError, EImzoSigner, chooseCertificate, parseAlias } from "./eimzo.js";
import { FakeEImzo } from "./fake-eimzo.js";

const ALIAS =
  "1.2.860.3.16.1.1=302936161,CN=ИВАНОВ ИВАН,O=FIDES PROJECTS XK,T=DIRECTOR,SERIALNUMBER=5A3C0F11,VALIDFROM=2025.01.01 00:00:00,VALIDTO=2027.01.01 23:59:59";
const cert = (alias: string, name = "key1") => ({ disk: "DSK1", path: "/keys", name, alias });

describe("E-IMZO", () => {
  it("reads a certificate's name: INN, serial number, organization, validity", () => {
    const x = parseAlias(ALIAS);
    expect(x).toMatchObject({ INN: "302936161", SERIALNUMBER: "5A3C0F11", O: "FIDES PROJECTS XK" });
  });

  it("lists the keys with their tax number and dates, leaving out ones with neither INN nor PINFL", async () => {
    const eimzo = new FakeEImzo();
    eimzo.certificates = [cert(ALIAS)];
    eimzo.certificates.push(cert("CN=NO ID,SERIALNUMBER=1", "other"));
    const list = await new EImzoClient({ connect: eimzo.connect }).listCertificates();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ serialNumber: "5A3C0F11", tin: "302936161", disk: "DSK1", name: "key1" });
    expect(list[0]?.validTo?.getFullYear()).toBe(2027);
  });

  it("signs the data with the key: the key is opened once, the data goes as base64", async () => {
    const eimzo = new FakeEImzo();
    eimzo.certificates = [cert(ALIAS)];
    const signer = new EImzoSigner(new EImzoClient({ connect: eimzo.connect }));
    expect(await signer.serialNumber()).toBe("5A3C0F11");
    const first = await signer.pkcs7('{"authId":"x"}');
    await signer.pkcs7("again");
    const sent = Buffer.from('{"authId":"x"}').toString("base64");
    expect(Buffer.from(first, "base64").toString()).toBe(`SIGNED(key-1):${sent}`);
    expect(eimzo.messages.filter((m) => m.name === "load_key")).toHaveLength(1);
    expect(eimzo.messages.find((m) => m.name === "create_pkcs7")).toMatchObject({
      plugin: "pkcs7",
      arguments: [sent, "key-1", "no"],
    });
  });

  it("opens the key again when E-IMZO no longer knows its id, once", async () => {
    const eimzo = new FakeEImzo();
    eimzo.certificates = [cert(ALIAS)];
    const signer = new EImzoSigner(new EImzoClient({ connect: eimzo.connect }));
    await signer.pkcs7("a");
    eimzo.forgotten.add("key-1");
    const signed = await signer.pkcs7("b");
    expect(Buffer.from(signed, "base64").toString()).toContain("SIGNED(key-2)");
  });

  it("sends the API keys once, before the first call", async () => {
    const eimzo = new FakeEImzo();
    eimzo.certificates = [cert(ALIAS)];
    const client = new EImzoClient({ connect: eimzo.connect, apiKeys: ["localhost", "KEY"] });
    await client.listCertificates();
    await client.listCertificates();
    expect(eimzo.messages.filter((m) => m.name === "apikey")).toEqual([
      { name: "apikey", arguments: ["localhost", "KEY"] },
    ]);
    expect(eimzo.messages[0]?.name).toBe("apikey");
  });

  it("says so when E-IMZO is not running", async () => {
    const eimzo = new FakeEImzo();
    eimzo.certificates = [cert(ALIAS)];
    eimzo.down = true;
    const error = await new EImzoClient({ connect: eimzo.connect })
      .listCertificates()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EImzoError);
    expect(error).toMatchObject({ code: "EIMZO_UNAVAILABLE" });
  });

  it("picks the key asked for, the only valid one, and refuses to guess among several", () => {
    const mk = (serial: string, tin: string, to: string) => ({
      disk: "",
      path: "",
      name: "",
      alias: "",
      serialNumber: serial,
      tin,
      pinfl: "",
      commonName: "",
      organization: "",
      validFrom: new Date("2025-01-01"),
      validTo: new Date(to),
    });
    const now = new Date("2026-10-10");
    const a = mk("AA", "111", "2027-01-01");
    const b = mk("BB", "222", "2027-01-01");
    const old = mk("CC", "111", "2026-01-01");
    expect(chooseCertificate([a, old], {}, now)).toBe(a);
    expect(chooseCertificate([a, b], { tin: "222" }, now)).toBe(b);
    expect(chooseCertificate([a, b], { serialNumber: "aa" }, now)).toBe(a);
    expect(() => chooseCertificate([a, b], {}, now)).toThrow(/2 valid keys/);
    expect(() => chooseCertificate([old], {}, now)).toThrow(/no valid/);
    expect(() => chooseCertificate([a], { tin: "999" }, now)).toThrow(/None of the keys/);
  });
});
