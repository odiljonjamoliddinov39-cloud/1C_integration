/**
 * Finding the 1C infobase a user means. A file base is a folder with a 1Cv8.1CD file in it; people often pick
 * the wrong folder (Downloads, the folder above, or the .1CD file itself). This looks for the base around the
 * chosen folder, and reads the list of bases the 1C launcher already knows (ibases.v8i).
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RegisteredInfobase } from "../shared/ipc.js";

export const DB_FILE = "1Cv8.1CD";

/** How far below the chosen folder to look, and how many folders to open at most (a Downloads folder can be big). */
const MAX_DEPTH = 3;
const MAX_FOLDERS = 3000;
const SKIP = new Set([
  "node_modules",
  "$recycle.bin",
  "system volume information",
  "windows",
  "program files",
]);

export type ResolvedInfobase =
  | { ok: true; folder: string; changed: boolean }
  | {
      ok: false;
      code: "INFOBASE_NOT_FOUND" | "INFOBASE_FOLDER_MISSING" | "INFOBASE_AMBIGUOUS";
      message: string;
      candidates: string[];
    };

const isDbFile = (name: string) => name.toLowerCase() === DB_FILE.toLowerCase();

/** Removes quotes and trailing separators that come with a pasted path. */
export function cleanPath(raw: string): string {
  let p = raw
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .trim();
  while (p.length > 3 && /[\\/]$/.test(p)) p = p.slice(0, -1);
  return p;
}

async function holdsDb(folder: string): Promise<boolean> {
  try {
    return (await readdir(folder)).some(isDbFile);
  } catch {
    return false;
  }
}

/** Folders below `root` (breadth first, a few levels) that hold a 1Cv8.1CD. */
async function findBelow(root: string): Promise<string[]> {
  const found: string[] = [];
  let level = [root];
  let opened = 0;
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0 && opened < MAX_FOLDERS; depth++) {
    const next: string[] = [];
    for (const folder of level) {
      let entries;
      try {
        entries = await readdir(folder, { withFileTypes: true });
      } catch {
        continue;
      }
      opened++;
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP.has(entry.name.toLowerCase()))
          continue;
        const child = join(folder, entry.name);
        if (await holdsDb(child)) found.push(child);
        else next.push(child);
        if (opened + next.length >= MAX_FOLDERS) break;
      }
    }
    level = next;
  }
  return found;
}

/**
 * The folder of the base for what the user entered: the folder itself when it holds 1Cv8.1CD; the folder of the file
 * when a .1CD file was given; otherwise the one base found below it. More than one, or none, is a clear refusal.
 */
export async function resolveInfobaseFolder(input: string): Promise<ResolvedInfobase> {
  const path = cleanPath(input);
  // The message is only the data (the folder, the folders found): the screen words the reason in the user's language.
  const notFound = (message: string): ResolvedInfobase => ({
    ok: false,
    code: "INFOBASE_NOT_FOUND",
    message,
    candidates: [],
  });

  let folder = path;
  const info = await stat(path).catch(() => null);
  if (!info) return { ok: false, code: "INFOBASE_FOLDER_MISSING", message: path, candidates: [] };
  if (info.isFile()) {
    // The file of the base (or any file in its folder): the base is the folder it lies in.
    folder = dirname(path);
    if (!(await holdsDb(folder))) {
      return notFound(folder);
    }
    return { ok: true, folder, changed: true };
  }
  if (await holdsDb(folder)) return { ok: true, folder, changed: folder !== input };

  const below = await findBelow(folder);
  if (below.length === 1) return { ok: true, folder: below[0] as string, changed: true };
  if (below.length > 1) {
    return {
      ok: false,
      code: "INFOBASE_AMBIGUOUS",
      message: below.slice(0, 8).join(" ; "),
      candidates: below.slice(0, 10),
    };
  }
  return notFound(path);
}

/** The bases in 1C's launcher list (ibases.v8i): `[Name]` then `Connect=File="path";` or `Connect=Srvr="s";Ref="r";`. */
export function parseIbases(text: string): RegisteredInfobase[] {
  const bases: RegisteredInfobase[] = [];
  let name: string | null = null;
  for (const raw of (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      name = section[1] as string;
      continue;
    }
    const connect = /^Connect=(.*)$/i.exec(line);
    if (!connect || name === null) continue;
    const value = connect[1] as string;
    const pick = (key: string) => new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*"([^"]*)"`, "i").exec(value)?.[1];
    const file = pick("File");
    const server = pick("Srvr");
    const ref = pick("Ref");
    if (file) bases.push({ name, kind: "file", file });
    else if (server && ref) bases.push({ name, kind: "server", server, ref });
  }
  return bases;
}

/** The registered bases of this PC; empty when 1C's launcher list is not there. */
export async function listRegisteredInfobases(appData = process.env.APPDATA): Promise<RegisteredInfobase[]> {
  if (!appData) return [];
  try {
    return parseIbases(await readFile(join(appData, "1C", "1CEStart", "ibases.v8i"), "utf8"));
  } catch {
    return [];
  }
}
