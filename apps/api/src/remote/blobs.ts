/**
 * Uploaded files and generated outputs wait here sealed. An upload is checked for its type and size before it is stored; an input
 * file is deleted once the PC has downloaded it, any file after 24 hours.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type BlobRef, REMOTE_LIMITS } from "@platform/shared";
import { and, eq, lt } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { remoteBlobs } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import type { Seal } from "./seal.js";

const HOUR = 3_600_000;

/** What a phone may upload: a bank statement (Excel, CSV), a GTD or an invoice (PDF, Excel, XML, JSON). Archives are left out. */
const ALLOWED = [".xlsx", ".xls", ".csv", ".pdf", ".xml", ".json", ".xlsm"];

/** The kind of file by its first bytes: a renamed file is not what its name says. */
export function sniff(data: Uint8Array): "zip" | "pdf" | "ole" | "text" | "other" {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (starts(0x50, 0x4b, 0x03, 0x04)) return "zip";
  if (starts(0x25, 0x50, 0x44, 0x46)) return "pdf";
  if (starts(0xd0, 0xcf, 0x11, 0xe0)) return "ole";
  const head = data.subarray(0, Math.min(data.length, 4096));
  return head.includes(0) ? "other" : "text";
}

/** Checks a file's name, size and content against the allowed kinds; throws the error the phone is told. */
export function checkUpload(name: string, data: Uint8Array): void {
  if (data.byteLength === 0) throw new HttpError(400, "EMPTY_FILE", "The file is empty");
  if (data.byteLength > REMOTE_LIMITS.maxFileBytes)
    throw new HttpError(413, "FILE_TOO_LARGE", "The file is larger than 20 MB");
  const ext = name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  if (!ALLOWED.includes(ext))
    throw new HttpError(415, "FILE_TYPE", `Files of this kind are not accepted (${ALLOWED.join(", ")} are)`);
  const kind = sniff(data);
  const ok =
    ext === ".pdf"
      ? kind === "pdf"
      : ext === ".xlsx" || ext === ".xlsm"
        ? kind === "zip"
        : ext === ".xls"
          ? kind === "ole"
          : kind === "text";
  if (!ok) throw new HttpError(415, "FILE_CONTENT", "The content of the file is not what its name says");
}

export class Blobs {
  constructor(
    private readonly db: Db,
    private readonly seal: Seal,
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Stores a file for a device. `sha256` is the checksum the sender computed; a mismatch is refused (a damaged upload).
   * `commandId` is set for an output the PC made for a command.
   */
  async store(input: {
    deviceId: string;
    direction: "in" | "out";
    name: string;
    data: Uint8Array;
    sha256: string;
    commandId?: string;
    /** Inputs are checked for type; outputs are made by the PC and only size-checked. */
    check?: boolean;
  }): Promise<BlobRef> {
    if (input.check !== false) checkUpload(input.name, input.data);
    else if (input.data.byteLength > REMOTE_LIMITS.maxFileBytes)
      throw new HttpError(413, "FILE_TOO_LARGE", "The file is larger than 20 MB");
    const actual = createHash("sha256").update(input.data).digest("hex");
    if (actual !== input.sha256.toLowerCase())
      throw new HttpError(400, "CHECKSUM", "The checksum does not match the file: upload it again");
    const id = randomUUID();
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, id), this.seal.seal(Buffer.from(input.data)));
    await this.db.insert(remoteBlobs).values({
      id,
      deviceId: input.deviceId,
      commandId: input.commandId ?? null,
      direction: input.direction,
      name: input.name.slice(0, 200),
      size: input.data.byteLength,
      sha256: actual,
      storageKey: id,
      expiresAt: new Date(this.now().getTime() + REMOTE_LIMITS.blobHours * HOUR),
    });
    return { id, name: input.name.slice(0, 200), size: input.data.byteLength, sha256: actual };
  }

  /** The bytes and name of a file that has not expired, or null. */
  async read(id: string): Promise<{ row: typeof remoteBlobs.$inferSelect; data: Buffer } | null> {
    const [row] = await this.db.select().from(remoteBlobs).where(eq(remoteBlobs.id, id));
    if (!row || row.expiresAt <= this.now()) return null;
    let sealed: string;
    try {
      sealed = await readFile(join(this.dir, row.storageKey), "utf8");
    } catch {
      return null;
    }
    const data = this.seal.open(sealed);
    return data ? { row, data } : null;
  }

  /** Deletes a file and its row (an input after the PC has downloaded it). */
  async remove(id: string): Promise<void> {
    await rm(join(this.dir, id), { force: true });
    await this.db.delete(remoteBlobs).where(eq(remoteBlobs.id, id));
  }

  /** Files past 24 hours are deleted: bytes and rows. Returns how many. */
  async purgeExpired(): Promise<number> {
    const rows = await this.db.select().from(remoteBlobs).where(lt(remoteBlobs.expiresAt, this.now()));
    for (const row of rows) await rm(join(this.dir, row.storageKey), { force: true });
    if (rows.length > 0) await this.db.delete(remoteBlobs).where(and(lt(remoteBlobs.expiresAt, this.now())));
    return rows.length;
  }
}
