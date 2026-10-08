/**
 * Puts the PlatformAPI extension that ships with this app into the company's 1C base, the way the
 * accountant would in the Configurator («Загрузить конфигурацию из файлов», then F7), but in 1C's
 * own batch mode, in two runs of 1cv8.exe DESIGNER: /LoadConfigFromFiles … -Extension PlatformAPI,
 * then /UpdateDBCfg -Extension PlatformAPI (one run with both commands is refused by 1C as
 * "Ошибка в параметрах командной строки"). Only that extension changes; the configuration and the
 * data stay as they are.
 *
 * The 1C platform is the one whose COM connector the app already uses (found in the registry), so a
 * server base gets a client of the server's version.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import type { ConnectionInput, Result } from "../shared/ipc.js";
import { decodeText } from "./attachments.js";

export const EXTENSION_NAME = "PlatformAPI";
/** A large file base can take a while to restructure. */
const DESIGNER_TIMEOUT_MS = 15 * 60 * 1000;

export interface InstallerDeps {
  platform: NodeJS.Platform;
  /** The extension's XML files, shipped with the app. */
  sourceDir: string;
  findDesigner: () => Promise<string | null>;
  run: (exe: string, args: string[]) => Promise<{ code: number | null }>;
}

/** Opens the base in the Designer, quietly, writing 1C's messages to a log file. */
function baseArgs(connection: ConnectionInput, logFile: string): string[] {
  const base =
    connection.infobase.kind === "file"
      ? ["/F", connection.infobase.file]
      : ["/S", `${connection.infobase.server}\\${connection.infobase.ref}`];
  return [
    "DESIGNER",
    ...base,
    ...(connection.user ? ["/N", connection.user] : []),
    ...(connection.password ? ["/P", connection.password] : []),
    "/DisableStartupDialogs",
    "/DisableStartupMessages",
    "/Out",
    logFile,
  ];
}

/** Step 1: load the extension's files into the base (as «Загрузить конфигурацию из файлов»). */
export function loadArgs(connection: ConnectionInput, sourceDir: string, logFile: string): string[] {
  return [...baseArgs(connection, logFile), "/LoadConfigFromFiles", sourceDir, "-Extension", EXTENSION_NAME];
}

/** Step 2: update the database for it (as F7); without -Extension on platforms that do not take it. */
export function updateArgs(connection: ConnectionInput, logFile: string, withExtension = true): string[] {
  return [
    ...baseArgs(connection, logFile),
    "/UpdateDBCfg",
    ...(withExtension ? ["-Extension", EXTENSION_NAME] : []),
  ];
}

const COMMAND_LINE_ERROR = /параметрах командной строки|command line/i;

/** What went wrong, in words the accountant can act on, from the Designer's log. */
export function explainLog(log: string): { code: string; message: string } {
  const text = log.trim();
  if (/монопольн|exclusive/i.test(text)) {
    return {
      code: "EXTENSION_BASE_BUSY",
      message:
        "1C could not lock the base to update the extension: close 1C (and the Configurator) on every PC " +
        "that has this base open, then try again.",
    };
  }
  if (
    /пользовател|user|пароль|password|аутентификац|authentic/i.test(text) &&
    /не|not|fail|неправ/i.test(text)
  ) {
    return {
      code: "EXTENSION_NO_RIGHTS",
      message:
        "1C did not let this user change the base. The 1C user in the app needs administrator rights " +
        `(the role «Администратор» or «Полные права»). 1C said: ${text.slice(0, 300)}`,
    };
  }
  return {
    code: "EXTENSION_UPDATE_FAILED",
    message: text ? `1C said: ${text.slice(0, 500)}` : "The 1C Designer stopped without a message.",
  };
}

export async function installExtension(
  connection: ConnectionInput,
  deps: InstallerDeps,
): Promise<Result<{ designer: string; log: string }>> {
  if (deps.platform !== "win32") {
    return { ok: false, code: "NOT_WINDOWS", message: "The extension is updated by 1C on Windows only" };
  }
  if (!existsSync(join(deps.sourceDir, "Configuration.xml"))) {
    return { ok: false, code: "EXTENSION_FILES_MISSING", message: "The app's PlatformAPI files are missing" };
  }
  const designer = await deps.findDesigner();
  if (!designer) {
    return {
      ok: false,
      code: "DESIGNER_NOT_FOUND",
      message: "1C:Enterprise (1cv8.exe) was not found on this PC; install the 1C platform with the Designer",
    };
  }
  // The platform's version, from its folder (…\1cv8\8.3.24.1548\bin\1cv8.exe), helps when 1C refuses.
  const version = /\\(\d+\.\d+\.\d+\.\d+)\\/.exec(designer)?.[1] ?? "unknown version";
  const work = mkdtempSync(join(tmpdir(), "platformapi-"));
  let step = 0;
  const run = async (args: (logFile: string) => string[]) => {
    const logFile = join(work, `step-${++step}.log`);
    const { code } = await deps.run(designer, args(logFile));
    return { code, log: existsSync(logFile) ? decodeText(readFileSync(logFile)) : "" };
  };
  const failed = (what: string, log: string) => {
    const explained = explainLog(log);
    return {
      ok: false as const,
      code: explained.code,
      message: `${explained.message} (${what}; 1C ${version})`,
    };
  };
  try {
    const load = await run((logFile) => loadArgs(connection, deps.sourceDir, logFile));
    if (load.code !== 0) return failed("loading the extension files", load.log);

    let update = await run((logFile) => updateArgs(connection, logFile));
    if (update.code !== 0 && COMMAND_LINE_ERROR.test(update.log)) {
      // A platform that does not know /UpdateDBCfg -Extension updates all of the base's extensions.
      update = await run((logFile) => updateArgs(connection, logFile, false));
    }
    if (update.code !== 0) return failed("updating the database", update.log);
    return { ok: true, data: { designer, log: [load.log, update.log].filter(Boolean).join("\n") } };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Finding 1cv8.exe on Windows -----------------------------------------------------------------

type Exec = (file: string, args: string[]) => Promise<string>;

const execText: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000 }, (error, stdout) =>
      resolve(error ? "" : String(stdout)),
    );
  });

/** The (Default) value of a registry key, or null. */
async function registryDefault(exec: Exec, key: string): Promise<string | null> {
  const out = await exec("reg", ["query", key, "/ve"]);
  const match = /REG_(?:EXPAND_)?SZ\s+(.+)/.exec(out);
  return match?.[1]?.trim() ?? null;
}

/**
 * 1cv8.exe next to the COM connector the app uses (V83.COMConnector → its comcntr.dll), else the
 * newest one under Program Files\1cv8.
 */
export async function findDesigner(
  exec: Exec = execText,
  exists: (path: string) => boolean = existsSync,
  list: (dir: string) => string[] = (dir) => (existsSync(dir) ? readdirSync(dir) : []),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const clsid = await registryDefault(exec, "HKCR\\V83.COMConnector\\CLSID");
  if (clsid) {
    for (const root of ["HKCR\\CLSID", "HKCR\\WOW6432Node\\CLSID"]) {
      const dll = await registryDefault(exec, `${root}\\${clsid}\\InprocServer32`);
      if (dll) {
        const exe = win32.join(win32.dirname(dll.replace(/^"|"$/g, "")), "1cv8.exe");
        if (exists(exe)) return exe;
      }
    }
  }
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"]]
    .filter((p): p is string => Boolean(p))
    .map((p) => win32.join(p, "1cv8"));
  const found = roots.flatMap((root) =>
    list(root)
      .filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name))
      .map((name) => ({ name, exe: win32.join(root, name, "bin", "1cv8.exe") }))
      .filter(({ exe }) => exists(exe)),
  );
  const newest = found.sort((a, b) => compareVersions(b.name, a.name))[0];
  return newest?.exe ?? null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function runDesigner(exe: string, args: string[]): Promise<{ code: number | null }> {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout: DESIGNER_TIMEOUT_MS }, (error) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code });
    });
  });
}
