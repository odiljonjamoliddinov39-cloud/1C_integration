/**
 * A .rar archive read in memory with the unrar library (WebAssembly, so no program is run and nothing is written to disk),
 * as the same entries `readZip` gives, so attached archives of both kinds are walked by one piece of code.
 */
import { createExtractorFromData } from "node-unrar-js";

import { type ZipEntry, ZipError } from "./zip.js";

const MAX_ENTRIES = 10_000;

/** A RAR archive starts with "Rar!\x1A\x07" (RAR 4 and 5). */
export const isRar = (data: Uint8Array): boolean =>
  data.byteLength > 7 && [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07].every((byte, at) => data[at] === byte);

export async function readRar(data: Uint8Array): Promise<ZipEntry[]> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  let extractor;
  try {
    extractor = await createExtractorFromData({ data: copy.buffer });
  } catch (error) {
    throw new ZipError("DAMAGED", error instanceof Error ? error.message : "the archive is damaged");
  }
  let headers;
  try {
    const list = extractor.getFileList();
    if (list.arcHeader.flags.headerEncrypted)
      throw new ZipError("ENCRYPTED", "the archive is password-protected");
    if (list.arcHeader.flags.volume)
      throw new ZipError("UNSUPPORTED", "an archive in several volumes is not read");
    headers = [...list.fileHeaders];
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError("DAMAGED", "the archive is damaged");
  }
  if (headers.length > MAX_ENTRIES) throw new ZipError("TOO_MANY", "the archive holds too many files");
  const open = extractor;
  return headers.map((header) => ({
    name: header.name.replaceAll("\\", "/"),
    size: header.unpSize,
    directory: header.flags.directory,
    read: () => {
      if (header.flags.encrypted) throw new ZipError("ENCRYPTED", "the file is password-protected");
      try {
        const { files } = open.extract({ files: [header.name] });
        const [file] = [...files];
        const bytes = file?.extraction;
        if (!bytes) throw new ZipError("DAMAGED", "the file could not be unpacked");
        const out = new Uint8Array(bytes.byteLength);
        out.set(bytes);
        return out;
      } catch (error) {
        if (error instanceof ZipError) throw error;
        throw new ZipError("DAMAGED", "the file could not be unpacked");
      }
    },
  }));
}
