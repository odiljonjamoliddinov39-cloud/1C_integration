import { describe, expect, it } from "vitest";

import { buildConnectionString, describeInfobase } from "./connection-string.js";

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
