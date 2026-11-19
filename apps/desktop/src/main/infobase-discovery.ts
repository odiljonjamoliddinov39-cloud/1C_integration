/**
 * Finds a working 1C connection without asking the accountant for anything (docs/
 * 1c-connect-discovery-td.md): most bases were set up once by someone else, and the person using
 * it daily never typed a login or password -- they just double-click a shortcut that already
 * knows how. This reads the same two places 1C itself relies on:
 *
 *   1. Desktop / Start Menu shortcuts that launch 1cv8/1cv8c, whose target often has /N"user"
 *      and /P"password" baked right in.
 *   2. 1C's own list of known bases, ibases.v8i, whose Connect= value is the exact grammar
 *      connection-string.ts already builds and parses.
 *
 * Both are plaintext already readable by the Windows account running this app -- the same tier of
 * access the folder picker already has -- so reading them crosses no new trust boundary.
 */
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { win32 } from "node:path";

import { parseConnectionString } from "@platform/onec-client";

import type { InfobaseInput } from "../shared/ipc.js";

export interface DiscoveredInfobase {
  infobase: InfobaseInput;
  user: string;
  password: string;
  source: "shortcut" | "ibases";
  /** For the UI: a human-readable name for the candidate, never the password. */
  label: string;
}

/** Splits "server\ref" into its two parts, on the first backslash only (TD §5 launch syntax). */
function splitServerRef(value: string): { server: string; ref: string } | null {
  const i = value.indexOf("\\");
  if (i < 0) return null;
  const server = value.slice(0, i).trim();
  const ref = value.slice(i + 1).trim();
  return server && ref ? { server, ref } : null;
}

/**
 * Parses a 1cv8/1cv8c launch command line: `/F"D:\Bases\X"` or `/S"server\ref"`, plus optional
 * `/N"user"` and `/P"password"`. Not a full command-line parser -- just the handful of flags 1C
 * itself documents for this -- so an unrecognized line simply yields no infobase.
 */
export function parseLaunchArgs(commandLine: string): Omit<DiscoveredInfobase, "source" | "label"> | null {
  const file = /\/F"([^"]*)"/i.exec(commandLine)?.[1];
  const serverRef = /\/S"([^"]*)"/i.exec(commandLine)?.[1];
  const user = /\/N"([^"]*)"/i.exec(commandLine)?.[1] ?? "";
  const password = /\/P"([^"]*)"/i.exec(commandLine)?.[1] ?? "";
  const infobase: InfobaseInput | null = file
    ? { kind: "file", file }
    : serverRef
      ? (() => {
          const parsed = splitServerRef(serverRef);
          return parsed ? { kind: "server" as const, ...parsed } : null;
        })()
      : null;
  return infobase ? { infobase, user, password } : null;
}

/**
 * Parses ibases.v8i: scans for every `Connect=` line (the surrounding `[section]`/`ID=`/`Name=`
 * structure varies by 1C version and isn't needed for a working connection) and reads each one
 * with the same grammar connection-string.ts already builds.
 */
export function parseIbasesV8i(content: string): Omit<DiscoveredInfobase, "source" | "label">[] {
  const out: Omit<DiscoveredInfobase, "source" | "label">[] = [];
  for (const m of content.matchAll(/^\s*Connect=(.+)$/gim)) {
    if (m[1] === undefined) continue;
    const { infobase, user, password } = parseConnectionString(m[1].trim());
    if (!infobase) continue;
    out.push({
      infobase: "file" in infobase ? { kind: "file", file: infobase.file } : { kind: "server", ...infobase },
      user: user ?? "",
      password: password ?? "",
    });
  }
  return out;
}

function labelFor(infobase: InfobaseInput): string {
  return infobase.kind === "file" ? infobase.file : `${infobase.server}/${infobase.ref}`;
}

function dedupeKey(infobase: InfobaseInput): string {
  if (infobase.kind === "file") return `file:${infobase.file.toLowerCase()}`;
  return `server:${infobase.server.toLowerCase()}/${infobase.ref.toLowerCase()}`;
}

export interface DiscoveryDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Lists shortcut (.lnk) files under a folder; [] for a folder that doesn't exist. */
  listShortcuts: (dir: string) => Promise<string[]>;
  /** Resolves a .lnk's target + arguments as one command line; "" if it can't be read. */
  resolveShortcut: (lnkPath: string) => Promise<string>;
  /** Reads a text file; "" if it doesn't exist or can't be read. */
  readTextFile: (path: string) => Promise<string>;
}

/** Everywhere a working 1C connection could already be sitting, newest/most-likely first. */
function candidateDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.USERPROFILE ?? "";
  const programData = env.ProgramData ?? "C:\\ProgramData";
  const appData = env.APPDATA ?? (home ? win32.join(home, "AppData", "Roaming") : "");
  return [
    home && win32.join(home, "Desktop"),
    win32.join(programData, "Microsoft", "Windows", "Start Menu", "Programs"),
    appData && win32.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
  ].filter((d): d is string => Boolean(d));
}

function ibasesPaths(env: NodeJS.ProcessEnv): string[] {
  const home = env.USERPROFILE ?? "";
  const programData = env.ProgramData ?? "C:\\ProgramData";
  const appData = env.APPDATA ?? (home ? win32.join(home, "AppData", "Roaming") : "");
  return [
    win32.join(appData, "1C", "1CEStart", "ibases.v8i"),
    win32.join(programData, "1C", "1CEStart", "ibases.v8i"),
  ];
}

/** Windows-only; resolves to [] everywhere else, same guard style as registerComConnector. */
export async function discoverInfobases(deps: DiscoveryDeps): Promise<DiscoveredInfobase[]> {
  if (deps.platform !== "win32") return [];
  const found: DiscoveredInfobase[] = [];

  for (const dir of candidateDirs(deps.env)) {
    for (const lnk of await deps.listShortcuts(dir)) {
      const commandLine = await deps.resolveShortcut(lnk);
      if (!/1cv8c?\.exe/i.test(commandLine)) continue;
      const parsed = parseLaunchArgs(commandLine);
      if (parsed) found.push({ ...parsed, source: "shortcut", label: labelFor(parsed.infobase) });
    }
  }
  for (const path of ibasesPaths(deps.env)) {
    const content = await deps.readTextFile(path);
    for (const parsed of parseIbasesV8i(content)) {
      found.push({ ...parsed, source: "ibases", label: labelFor(parsed.infobase) });
    }
  }

  const seen = new Set<string>();
  return found.filter((c) => {
    const key = dedupeKey(c.infobase);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** PowerShell string literal: single quotes doubled (same convention as com-register.ts). */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Resolves a .lnk's target + arguments as one command line, via WScript.Shell (no native deps). */
export function resolveShortcutWindows(lnkPath: string): Promise<string> {
  const script =
    `$s = (New-Object -COM WScript.Shell).CreateShortcut(${psQuote(lnkPath)}); ` +
    `Write-Output ($s.TargetPath + ' ' + $s.Arguments)`;
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 15_000 },
      (error, stdout) => resolve(error ? "" : stdout.trim()),
    );
  });
}

export async function listShortcutsWindows(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((name) => name.toLowerCase().endsWith(".lnk"))
      .map((name) => win32.join(dir, name));
  } catch {
    return [];
  }
}

export async function readTextFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf16le");
  } catch {
    try {
      return await readFile(path, "utf8");
    } catch {
      return "";
    }
  }
}
