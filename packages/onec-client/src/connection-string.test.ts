import { describe, expect, it } from "vitest";

import { buildConnectionString, describeInfobase, parseConnectionString } from "./connection-string.js";

describe("buildConnectionString", () => {
  it("builds a file infobase string", () => {
    expect(
      buildConnectionString({ infobase: { file: "D:\\Bases\\TEST" }, user: "Admin", password: "secret" }),
    ).toBe('File="D:\\Bases\\TEST";Usr="Admin";Pwd="secret";');
  });

  it("builds a server infobase string and doubles quotes", () => {
    expect(
      buildConnectionString({ infobase: { server: "srv", ref: "buh" }, user: "Бухгалтер", password: 'a"b' }),
    ).toBe('Srvr="srv";Ref="buh";Usr="Бухгалтер";Pwd="a""b";');
  });

  it("refuses an empty location and hides the password from descriptions", () => {
    expect(() => buildConnectionString({ infobase: { file: " " } })).toThrow();
    expect(describeInfobase({ server: "srv", ref: "buh" })).toBe("srv/buh");
  });
});

describe("parseConnectionString", () => {
  it("is the inverse of buildConnectionString for a file infobase", () => {
    const built = buildConnectionString({
      infobase: { file: "D:\\Bases\\TEST" },
      user: "Admin",
      password: "secret",
    });
    expect(parseConnectionString(built)).toEqual({
      infobase: { file: "D:\\Bases\\TEST" },
      user: "Admin",
      password: "secret",
    });
  });

  it("is the inverse of buildConnectionString for a server infobase, doubled quotes included", () => {
    const built = buildConnectionString({
      infobase: { server: "srv", ref: "buh" },
      user: "Бухгалтер",
      password: 'a"b',
    });
    expect(parseConnectionString(built)).toEqual({
      infobase: { server: "srv", ref: "buh" },
      user: "Бухгалтер",
      password: 'a"b',
    });
  });

  it("reports no infobase and no credentials when nothing usable is present", () => {
    expect(parseConnectionString('Something="else";')).toEqual({
      infobase: null,
      user: undefined,
      password: undefined,
    });
  });

  it("reads a file infobase with no credentials (OS auth or no auth configured)", () => {
    expect(parseConnectionString('File="D:\\Bases\\TEST";')).toEqual({
      infobase: { file: "D:\\Bases\\TEST" },
      user: undefined,
      password: undefined,
    });
  });
});
