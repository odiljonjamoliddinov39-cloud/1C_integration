import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import { explainLog, findDesigner, installExtension, loadArgs, updateArgs } from "./extension-installer.js";

const fileBase = {
  infobase: { kind: "file" as const, file: "D:\\Bases\\Crystal Water" },
  user: "Админ",
  password: 'p"w',
};

function sourceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xml-"));
  writeFileSync(join(dir, "Configuration.xml"), "<x/>");
  return dir;
}

describe("PlatformAPI installer", () => {
  it("builds the two Designer runs: load the files, then update the database", () => {
    const head = [
      "DESIGNER",
      "/F",
      "D:\\Bases\\Crystal Water",
      "/N",
      "Админ",
      "/P",
      'p"w',
      "/DisableStartupDialogs",
      "/DisableStartupMessages",
      "/Out",
      "C:\\t\\log.txt",
    ];
    expect(loadArgs(fileBase, "C:\\app\\platformapi", "C:\\t\\log.txt")).toEqual([
      ...head,
      "/LoadConfigFromFiles",
      "C:\\app\\platformapi",
      "-Extension",
      "PlatformAPI",
    ]);
    expect(updateArgs(fileBase, "C:\\t\\log.txt")).toEqual([
      ...head,
      "/UpdateDBCfg",
      "-Extension",
      "PlatformAPI",
    ]);
    expect(updateArgs(fileBase, "C:\\t\\log.txt", false)).toEqual([...head, "/UpdateDBCfg"]);
    const server = loadArgs(
      { infobase: { kind: "server", server: "srv1c", ref: "buh" }, user: "", password: "" },
      "x",
      "l",
    );
    expect(server.slice(0, 3)).toEqual(["DESIGNER", "/S", "srv1c\\buh"]);
    expect(server).not.toContain("/N");
    expect(server).not.toContain("/P");
  });

  it("loads, then updates; retries the update without -Extension on a platform that refuses it", async () => {
    const runs: string[][] = [];
    const designer = "C:\\Program Files\\1cv8\\8.3.18.1208\\bin\\1cv8.exe";
    const ok = await installExtension(fileBase, {
      platform: "win32",
      sourceDir: sourceDir(),
      findDesigner: async () => designer,
      run: async (_exe, args) => {
        runs.push(args);
        if (args.includes("/UpdateDBCfg") && args.includes("-Extension")) {
          writeFileSync(args[args.indexOf("/Out") + 1]!, "Ошибка в параметрах командной строки.");
          return { code: 1 };
        }
        return { code: 0 };
      },
    });
    expect(ok).toMatchObject({ ok: true });
    expect(runs.map((args) => args.slice(args.indexOf("/Out") + 2))).toEqual([
      ["/LoadConfigFromFiles", expect.any(String), "-Extension", "PlatformAPI"],
      ["/UpdateDBCfg", "-Extension", "PlatformAPI"],
      ["/UpdateDBCfg"],
    ]);

    const loadFails = await installExtension(fileBase, {
      platform: "win32",
      sourceDir: sourceDir(),
      findDesigner: async () => designer,
      run: async (_exe, args) => {
        writeFileSync(args[args.indexOf("/Out") + 1]!, "Ошибка в параметрах командной строки.");
        return { code: 1 };
      },
    });
    expect(loadFails).toMatchObject({
      ok: false,
      code: "EXTENSION_UPDATE_FAILED",
      message: expect.stringMatching(
        /параметрах командной строки.*loading the extension files; 1C 8\.3\.18\.1208/,
      ),
    });
  });

  it("reports 1C's own reason when it fails", async () => {
    const busy = await installExtension(fileBase, {
      platform: "win32",
      sourceDir: sourceDir(),
      findDesigner: async () => "1cv8.exe",
      run: async (_exe, args) => {
        writeFileSync(args[args.indexOf("/Out") + 1]!, "Ошибка установки монопольного режима");
        return { code: 1 };
      },
    });
    expect(busy).toMatchObject({ ok: false, code: "EXTENSION_BASE_BUSY" });

    expect(
      await installExtension(fileBase, {
        platform: "win32",
        sourceDir: sourceDir(),
        findDesigner: async () => null,
        run: async () => ({ code: 0 }),
      }),
    ).toMatchObject({ ok: false, code: "DESIGNER_NOT_FOUND" });
    expect(
      await installExtension(fileBase, {
        platform: "linux",
        sourceDir: sourceDir(),
        findDesigner: async () => "x",
        run: async () => ({ code: 0 }),
      }),
    ).toMatchObject({ ok: false, code: "NOT_WINDOWS" });
  });

  it("explains rights problems and passes other messages on", () => {
    // 1C 8.3.18's wording for a base held open by another session, with who holds it.
    const locked = explainLog(
      "Ошибка исключительной блокировки информационной базы. Активны сеансы: компьютер: DESKTOP-KKQGLVV, сеанс: 2, начат: 08.10.2026 в 22:55:03, приложение: Тонкий клиент",
    );
    expect(locked.code).toBe("EXTENSION_BASE_BUSY");
    expect(locked.message).toContain("DESKTOP-KKQGLVV, сеанс: 2");
    expect(locked.message).toContain("1cv8c.exe");
    expect(explainLog("Неправильное имя или пароль пользователя").code).toBe("EXTENSION_NO_RIGHTS");
    expect(explainLog("Ошибка проверки модуля").message).toContain("Ошибка проверки модуля");
    expect(explainLog("").message).toContain("without a message");
  });

  it("finds 1cv8.exe next to the COM connector, else the newest in Program Files", async () => {
    const registry: Record<string, string> = {
      "HKCR\\V83.COMConnector\\CLSID":
        "    (Default)    REG_SZ    {181E893D-73A4-4722-B61D-D604B3D67D47}\r\n",
      "HKCR\\CLSID\\{181E893D-73A4-4722-B61D-D604B3D67D47}\\InprocServer32":
        "    (Default)    REG_SZ    C:\\Program Files\\1cv8\\8.3.24.1548\\bin\\comcntr.dll\r\n",
    };
    const exec = async (_file: string, args: string[]) => registry[args[1]!] ?? "";
    const found = await findDesigner(
      exec,
      (p) => p.endsWith("1cv8.exe"),
      () => [],
      {},
    );
    expect(found).toBe("C:\\Program Files\\1cv8\\8.3.24.1548\\bin\\1cv8.exe");

    const scanned = await findDesigner(
      async () => "",
      (p) => p.includes("8.3.") && p.endsWith("1cv8.exe"),
      () => ["8.3.18.1208", "8.3.24.1548", "common", "8.3.9.2170"],
      { ProgramFiles: "C:\\Program Files" },
    );
    expect(scanned).toBe(win32.join("C:\\Program Files", "1cv8", "8.3.24.1548", "bin", "1cv8.exe"));
    expect(
      await findDesigner(
        async () => "",
        () => false,
        () => [],
        {},
      ),
    ).toBeNull();
  });
});
