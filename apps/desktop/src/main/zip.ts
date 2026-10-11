/**
 * A small reader for .zip files, enough for what people attach: stored and deflated entries, names in
 * UTF-8 or the DOS code page that Windows archivers use for Russian names. Nothing is written to
 * disk, so a hostile entry name can not escape anywhere; sizes are checked before anything is
 * inflated, and inflating stops at the size the archive declares.
 */
import { inflateRawSync } from "node:zlib";

export class ZipError extends Error {
  constructor(
    readonly reason: "DAMAGED" | "ENCRYPTED" | "UNSUPPORTED" | "TOO_MANY",
    message: string,
  ) {
    super(message);
  }
}

export interface ZipEntry {
  /** The path inside the archive, with "/" separators. */
  name: string;
  /** The size the archive declares for the unpacked file. */
  size: number;
  directory: boolean;
  /** Unpacks the file. Throws ZipError when it is damaged or larger than it declared. */
  read: () => Uint8Array<ArrayBuffer>;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** The end record sits in the last 64 KB (a comment can follow it) plus its own 22 bytes. */
const EOCD_SEARCH = 0xffff + 22;
const MAX_ENTRIES = 10_000;

const damaged = () => new ZipError("DAMAGED", "the archive is damaged");

export function readZip(data: Uint8Array): ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (at: number) => {
    if (at < 0 || at + 2 > data.byteLength) throw damaged();
    return view.getUint16(at, true);
  };
  const u32 = (at: number) => {
    if (at < 0 || at + 4 > data.byteLength) throw damaged();
    return view.getUint32(at, true);
  };

  let end = -1;
  for (let at = data.byteLength - 22; at >= Math.max(0, data.byteLength - EOCD_SEARCH); at--) {
    if (u32(at) === EOCD) {
      end = at;
      break;
    }
  }
  if (end < 0) throw damaged();

  const count = u16(end + 10);
  const centralSize = u32(end + 12);
  let at = u32(end + 16);
  if (count === 0xffff || centralSize === 0xffffffff || at === 0xffffffff) {
    throw new ZipError("UNSUPPORTED", "the archive is in ZIP64 format");
  }
  if (count > MAX_ENTRIES) throw new ZipError("TOO_MANY", "the archive has too many files");

  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (u32(at) !== CENTRAL) throw damaged();
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const compressed = u32(at + 20);
    const size = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    const local = u32(at + 42);
    if (at + 46 + nameLength > data.byteLength) throw damaged();
    const rawName = data.subarray(at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    const name = entryName(rawName, (flags & 0x800) !== 0).replaceAll("\\", "/");
    const directory = name.endsWith("/");
    entries.push({
      name,
      size,
      directory,
      read: () => {
        if (flags & 0x1) throw new ZipError("ENCRYPTED", "the archive is password-protected");
        if (compressed === 0xffffffff || size === 0xffffffff) {
          throw new ZipError("UNSUPPORTED", "the archive is in ZIP64 format");
        }
        if (u32(local) !== LOCAL) throw damaged();
        const start = local + 30 + u16(local + 26) + u16(local + 28);
        if (start + compressed > data.byteLength) throw damaged();
        const packed = data.subarray(start, start + compressed);
        if (method === 0) {
          if (compressed !== size) throw damaged();
          return packed.slice();
        }
        if (method !== 8) throw new ZipError("UNSUPPORTED", `compression method ${method} is not supported`);
        try {
          // Stops at the declared size, so a small file can not unpack into gigabytes.
          const unpacked = inflateRawSync(packed, { maxOutputLength: Math.max(1, size) });
          if (unpacked.byteLength !== size) throw damaged();
          return new Uint8Array(unpacked);
        } catch (error) {
          throw error instanceof ZipError ? error : damaged();
        }
      },
    });
  }
  return entries;
}

/** UTF-8 when the archive says so or the bytes are valid UTF-8, else the DOS Cyrillic code page. */
function entryName(raw: Uint8Array, utf8: boolean): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    if (utf8) return new TextDecoder("utf-8").decode(raw);
  }
  try {
    return new TextDecoder("ibm866").decode(raw);
  } catch {
    return new TextDecoder("windows-1251").decode(raw);
  }
}
