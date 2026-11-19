import { describe, expect, it } from "vitest";

import { discoverInfobases, parseIbasesV8i, parseLaunchArgs } from "./infobase-discovery.js";

describe("parsing a 1cv8 launch command line", () => {
  it("reads a file infobase with a saved login and password", () => {
    expect(
      parseLaunchArgs(
        '"C:\\Program Files\\1cv8\\8.3.24.1548\\bin\\1cv8.exe" ENTERPRISE /F"D:\\Bases\\TEST" /N"Admin" /P"secret"',
      ),
    ).toEqual({ infobase: { kind: "file", file: "D:\\Bases\\TEST" }, user: "Admin", password: "secret" });
  });

  it("reads a server infobase, splitting server\\ref on the first backslash", () => {
    expect(parseLaunchArgs('1cv8.exe ENTERPRISE /S"srv\\buh" /N"Бухгалтер"')).toEqual({
      infobase: { kind: "server", server: "srv", ref: "buh" },
      user: "Бухгалтер",
      password: "",
    });
  });

  it("gives no login/password when the shortcut has none -- OS auth or no auth configured", () => {
    expect(parseLaunchArgs('1cv8.exe ENTERPRISE /F"D:\\Bases\\TEST"')).toEqual({
      infobase: { kind: "file", file: "D:\\Bases\\TEST" },
      user: "",
      password: "",
    });
  });

  it("finds nothing in a command line that isn't a 1C launch", () => {
    expect(parseLaunchArgs('"C:\\Windows\\notepad.exe" "D:\\Bases\\TEST"')).toBeNull();
  });
});

describe("parsing ibases.v8i", () => {
  it("reads every Connect= line regardless of the surrounding section format", () => {
    const content = [
      "[Infobases]",
      "1",
      'Connect=File="D:\\Bases\\TEST";Usr="Admin";Pwd="secret";',
      "Name=Main base",
      "",
      "2",
      'Connect=Srvr="srv";Ref="buh";',
    ].join("\r\n");
    expect(parseIbasesV8i(content)).toEqual([
      { infobase: { kind: "file", file: "D:\\Bases\\TEST" }, user: "Admin", password: "secret" },
      { infobase: { kind: "server", server: "srv", ref: "buh" }, user: "", password: "" },
    ]);
  });

  it("is empty for content with no Connect= line", () => {
    expect(parseIbasesV8i("[Infobases]\r\nName=Nothing useful here\r\n")).toEqual([]);
  });
});

describe("discoverInfobases", () => {
  it("is empty outside Windows, without reading anything", () => {
    const calls: string[] = [];
    const deps = {
      platform: "darwin" as NodeJS.Platform,
      env: {},
      listShortcuts: async (dir: string) => {
        calls.push(dir);
        return [];
      },
      resolveShortcut: async () => "",
      readTextFile: async (path: string) => {
        calls.push(path);
        return "";
      },
    };
    return discoverInfobases(deps).then((result) => {
      expect(result).toEqual([]);
      expect(calls).toEqual([]);
    });
  });

  it("finds a shortcut's connection and an ibases.v8i entry, de-duplicating by location", async () => {
    const env = {
      USERPROFILE: "C:\\Users\\Anvar",
      ProgramData: "C:\\ProgramData",
      APPDATA: "C:\\Users\\Anvar\\AppData\\Roaming",
    };
    const deps = {
      platform: "win32" as NodeJS.Platform,
      env,
      listShortcuts: async (dir: string) =>
        dir === "C:\\Users\\Anvar\\Desktop" ? ["C:\\Users\\Anvar\\Desktop\\Buxgalteriya.lnk"] : [],
      resolveShortcut: async (lnk: string) =>
        lnk.endsWith("Buxgalteriya.lnk")
          ? '"C:\\Program Files\\1cv8\\8.3.24.1548\\bin\\1cv8.exe" ENTERPRISE /F"D:\\Bases\\TEST" /N"Admin" /P"secret"'
          : "",
      readTextFile: async (path: string) =>
        path.endsWith("ibases.v8i") ? 'Connect=Srvr="srv";Ref="buh";Usr="Бухгалтер";Pwd="qwerty";' : "",
    };
    const found = await discoverInfobases(deps);
    expect(found).toEqual([
      {
        infobase: { kind: "file", file: "D:\\Bases\\TEST" },
        user: "Admin",
        password: "secret",
        source: "shortcut",
        label: "D:\\Bases\\TEST",
      },
      {
        infobase: { kind: "server", server: "srv", ref: "buh" },
        user: "Бухгалтер",
        password: "qwerty",
        source: "ibases",
        label: "srv/buh",
      },
    ]);
  });

  it("ignores shortcuts that don't launch 1C, and drops a duplicate found twice", async () => {
    const env = { USERPROFILE: "C:\\Users\\Anvar", ProgramData: "C:\\ProgramData" };
    const deps = {
      platform: "win32" as NodeJS.Platform,
      env,
      listShortcuts: async (dir: string) =>
        dir === "C:\\Users\\Anvar\\Desktop" ? ["Chrome.lnk", "Buxgalteriya.lnk"] : [],
      resolveShortcut: async (lnk: string) =>
        lnk.endsWith("Chrome.lnk")
          ? '"C:\\Program Files\\Google\\Chrome\\chrome.exe"'
          : '1cv8.exe ENTERPRISE /F"D:\\Bases\\TEST"',
      // Both ibases.v8i locations repeat the same base the shortcut already found.
      readTextFile: async () => 'Connect=File="D:\\Bases\\TEST";',
    };
    const found = await discoverInfobases(deps);
    expect(found).toHaveLength(1);
    expect(found[0]?.source).toBe("shortcut");
  });
});
