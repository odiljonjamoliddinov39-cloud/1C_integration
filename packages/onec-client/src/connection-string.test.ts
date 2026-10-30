import { describe, expect, it } from "vitest";

import { buildConnectionString, describeCredentials, describeInfobase } from "./connection-string.js";

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

describe("describeCredentials", () => {
  it("shows the user name and its alphabets but never the password", () => {
    const text = describeCredentials("Администратор", "s3cret!");
    expect(text).toBe("user «Администратор» (13 chars: Cyrillic 13), password 7 chars");
    expect(text).not.toContain("s3cret");
  });

  it("exposes a look-alike Latin letter, a trailing space and a padded password", () => {
    // Latin "A" (U+0041) in front of Cyrillic letters, and a space at the end.
    expect(describeCredentials("Aдмин ", " x")).toBe(
      "user «Aдмин » (6 chars: Latin 1, Cyrillic 4, spaces 1), password 2 chars (starts or ends with a space)",
    );
  });

  it("says when nothing was sent", () => {
    expect(describeCredentials()).toBe("no user and no password were sent");
    expect(describeCredentials("", "pw")).toBe("no user, password 2 chars");
  });
});
