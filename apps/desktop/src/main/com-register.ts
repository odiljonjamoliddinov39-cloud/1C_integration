/**
 * Registers 1C's COM connector (comcntr.dll) for this app, the way the accountant would by hand:
 * `regsvr32 "C:\Program Files\1cv8\<version>\bin\comcntr.dll"` as administrator. The 1C installer
 * does it only when «Компонент COM-соединения» is ticked, so a fresh install often lacks it, and a
 * 32-bit platform registers a 32-bit connector that this 64-bit app cannot load.
 *
 * Windows asks the user for administrator rights (UAC); nothing is changed without that approval.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { win32 } from "node:path";

import type { Result } from "../shared/ipc.js";

export interface ComConnectorFile {
  version: string;
  dll: string;
  /** The bitness of the platform it belongs to (Program Files vs Program Files (x86)). */
  bits: 32 | 64;
}

export interface ComRegisterDeps {
  platform: NodeJS.Platform;
  /** This process's architecture: only a connector of the same bitness is of any use. */
  arch: string;
  find: () => ComConnectorFile[];
  /** Runs regsvr32 on the file with administrator rights; the exit code, or null when it was not run. */
  register: (dll: string) => Promise<{ code: number | null }>;
  /** Whether V83.COMConnector is now registered. */
  isRegistered: () => Promise<boolean>;
}

/** Exit code the elevation script gives when the user refuses the Windows prompt. */
export const ELEVATION_REFUSED = 1223;

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Every comcntr.dll the installed 1C platforms carry, newest version first. */
export function findComConnectors(
  exists: (path: string) => boolean = existsSync,
  list: (dir: string) => string[] = (dir) => (existsSync(dir) ? readdirSync(dir) : []),
  env: NodeJS.ProcessEnv = process.env,
): ComConnectorFile[] {
  const roots: { dir: string; bits: 32 | 64 }[] = [];
  const x64 = env.ProgramW6432 ?? env.ProgramFiles;
  if (x64) roots.push({ dir: x64, bits: 64 });
  if (env["ProgramFiles(x86)"]) roots.push({ dir: env["ProgramFiles(x86)"], bits: 32 });
  return roots
    .flatMap(({ dir, bits }) =>
      list(win32.join(dir, "1cv8"))
        .filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name))
        .map((version) => ({ version, dll: win32.join(dir, "1cv8", version, "bin", "comcntr.dll"), bits }))
        .filter(({ dll }) => exists(dll)),
    )
    .sort((a, b) => compareVersions(b.version, a.version));
}

export interface ComRegistered {
  version: string;
  dll: string;
}

/** Registers the newest connector of this process's bitness, or says exactly why it cannot. */
export async function registerComConnector(deps: ComRegisterDeps): Promise<Result<ComRegistered>> {
  const fail = (code: string, message: string): Result<ComRegistered> => ({ ok: false, code, message });
  if (deps.platform !== "win32")
    return fail("COM_REGISTER_UNSUPPORTED", "The 1C COM connector is Windows-only");
  const want = deps.arch === "ia32" ? 32 : 64;
  const files = deps.find();
  const mine = files.filter((f) => f.bits === want);
  const target = mine[0];
  if (!target) {
    const other = files[0];
    if (other)
      return fail(
        "COM_REGISTER_WRONG_BITNESS",
        `Only the ${other.bits}-bit 1C platform ${other.version} is installed; this app is ${want}-bit. ` +
          `Install the ${want}-bit 1C platform (the same version) and try again.`,
      );
    return fail(
      "COM_REGISTER_NO_PLATFORM",
      "No 1C platform was found in Program Files. Install it (tick «Компонент COM-соединения») and try again.",
    );
  }
  const { code } = await deps.register(target.dll);
  if (code === ELEVATION_REFUSED || code === null)
    return fail(
      "COM_REGISTER_DENIED",
      "Windows did not get administrator approval, so nothing was registered.",
    );
  if (code !== 0)
    return fail(
      "COM_REGISTER_FAILED",
      `regsvr32 could not register ${target.dll} (exit code ${code}). Run the app's PC as an administrator or reinstall 1C with the COM connector component.`,
    );
  if (!(await deps.isRegistered()))
    return fail(
      "COM_REGISTER_FAILED",
      `regsvr32 reported success for ${target.dll}, but Windows still has no V83.COMConnector.`,
    );
  return { ok: true, data: { version: target.version, dll: target.dll } };
}

/** PowerShell string literal: single quotes doubled. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The command the elevation runs: regsvr32 quietly, its exit code passed back, a refused prompt as 1223. */
export function elevationScript(dll: string): string {
  return (
    `try { $p = Start-Process -FilePath regsvr32.exe -ArgumentList '/s', ${psQuote(`"${dll}"`)} ` +
    `-Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit ${ELEVATION_REFUSED} }`
  );
}

export function runRegsvr32Elevated(dll: string): Promise<{ code: number | null }> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", elevationScript(dll)],
      { windowsHide: true, timeout: 120_000 },
      (error) => {
        if (!error) return resolve({ code: 0 });
        resolve({ code: typeof error.code === "number" ? error.code : null });
      },
    );
  });
}

/** Whether V83.COMConnector has a class registered for this process (reg.exe from a 64-bit app reads the 64-bit view). */
export function isComRegistered(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query", "HKCR\\V83.COMConnector\\CLSID", "/ve"],
      { windowsHide: true, timeout: 15_000 },
      (error, out) => resolve(!error && /REG_(?:EXPAND_)?SZ\s+\{/.test(String(out))),
    );
  });
}
