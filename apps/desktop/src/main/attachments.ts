/**
 * Files attached to a question, turned into what the model reads. Images and PDFs go as they are
 * (the model sees the pages); spreadsheets, Word files and text files are read here and go as
 * text, so they cost fewer tokens and need no viewer on the server. Spreadsheets and CSV files are
 * also kept whole as tables (tables.ts): a large one goes as a summary, and the model reads the
 * rest with read_attachment.
 */
import type { AiContentBlock } from "@platform/shared";
import mammoth from "mammoth";
import readXlsxFile from "read-excel-file/node";

import type { AssistantFile, AttachmentInfo } from "../shared/ipc.js";
import { type TableFile, cellText, describeTable, parseCsv } from "./tables.js";
import { ZipError, readZip } from "./zip.js";

/** The longest side the model looks at; larger photos are scaled down before they are sent. */
const IMAGE_SIDE = 1568;
/** The API refuses larger images. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Text taken from one Word or text file. */
const MAX_TEXT_CHARS = 150_000;
/** Files read from one archive, and how much they may add up to once unpacked. */
const ATTACHMENT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 25;
const MAX_ARCHIVE_BYTES = 30 * 1024 * 1024;
/** What is read inside an archive (images are told by their extension here, not by content). */
const ARCHIVE_EXTENSIONS = new Set([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".xlsx",
  ".xlsm",
  ".csv",
  ".tsv",
  ".docx",
  ".txt",
  ".xml",
  ".json",
  ".md",
]);

/** Scales a PNG or JPEG down and re-encodes it as JPEG; null when it cannot read the image. */
export type ShrinkImage = (data: Uint8Array, maxSide: number) => Uint8Array | null;

export class AttachmentError extends Error {
  constructor(
    readonly code: "FILE_TYPE" | "FILE_TOO_LARGE" | "FILE_UNREADABLE",
    message: string,
  ) {
    super(message);
  }
}

export interface ReadAttachments {
  blocks: AiContentBlock[];
  info: AttachmentInfo[];
  /** Spreadsheets and CSV files, whole, for read_attachment. */
  tables: TableFile[];
}

export async function readAttachments(
  files: AssistantFile[],
  shrink?: ShrinkImage,
): Promise<ReadAttachments> {
  const blocks: AiContentBlock[] = [];
  const info: AttachmentInfo[] = [];
  const tables: TableFile[] = [];
  for (const file of files) {
    if (extensionOf(file.name) === ".zip") {
      const archive = await readArchive(file, shrink);
      blocks.push(...archive.blocks);
      info.push({ name: file.name, kind: "archive", size: file.data.byteLength });
      tables.push(...archive.tables);
      continue;
    }
    const read = await readOne(file, shrink);
    blocks.push(read.block);
    info.push({ name: file.name, kind: read.kind, size: file.data.byteLength });
    if (read.table) tables.push(read.table);
  }
  return { blocks, info, tables };
}

async function readOne(
  { name, data }: AssistantFile,
  shrink?: ShrinkImage,
): Promise<{ block: AiContentBlock; kind: AttachmentInfo["kind"]; table?: TableFile }> {
  const extension = extensionOf(name);
  const image = imageType(data);
  if (image) return { block: imageBlock(data, image, shrink, name), kind: "image" };
  if (extension === ".pdf" || startsWith(data, "%PDF-")) {
    if (!startsWith(data, "%PDF-")) throw unreadable(name);
    return {
      block: {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: base64(data) },
        title: name,
      },
      kind: "pdf",
    };
  }
  if (extension === ".xlsx" || extension === ".xlsm") {
    const table = await spreadsheet(data, name);
    return { block: tableBlock(table), kind: "spreadsheet", table };
  }
  if (extension === ".csv" || extension === ".tsv") {
    const table = { name, sheets: [{ name, rows: parseCsv(decodeText(data)) }] };
    return { block: tableBlock(table), kind: "text", table };
  }
  if (extension === ".docx") {
    try {
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
      return { block: textBlock(name, value), kind: "document" };
    } catch {
      throw unreadable(name);
    }
  }
  if ([".txt", ".xml", ".json", ".md"].includes(extension)) {
    return { block: textBlock(name, decodeText(data)), kind: "text" };
  }
  if (extension === ".xls" || extension === ".doc") {
    throw new AttachmentError(
      "FILE_TYPE",
      `${name}: old Office format; save it as ${extension === ".xls" ? ".xlsx" : ".docx"} or PDF and attach it again`,
    );
  }
  throw new AttachmentError(
    "FILE_TYPE",
    `${name}: this kind of file is not supported (PDF, images, Excel, Word and text files are)`,
  );
}

const extensionOf = (name: string) => name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";

/**
 * A .zip is opened here and each file in it is read as if it had been attached by itself, named
 * "archive.zip/folder/file.xlsx". A file in it that is not supported, or can not be read, is left
 * out and said so in a note at the start, so one odd file does not lose the rest.
 */
async function readArchive(
  { name, data }: AssistantFile,
  shrink?: ShrinkImage,
): Promise<{ blocks: AiContentBlock[]; tables: TableFile[] }> {
  let entries;
  try {
    entries = readZip(data);
  } catch (error) {
    throw archiveError(name, error);
  }
  const files = entries.filter((entry) => !entry.directory && !isNoise(entry.name));
  const blocks: AiContentBlock[] = [];
  const tables: TableFile[] = [];
  const read: string[] = [];
  const skipped: string[] = [];
  let total = 0;
  let supported = 0;
  for (const entry of files) {
    const extension = extensionOf(entry.name);
    if (!ARCHIVE_EXTENSIONS.has(extension)) {
      skipped.push(
        `${entry.name} (${extension === ".zip" ? "an archive inside an archive" : "not a supported kind of file"})`,
      );
      continue;
    }
    supported += 1;
    if (entry.size > ATTACHMENT_FILE_BYTES) {
      skipped.push(`${entry.name} (larger than 10 MB)`);
      continue;
    }
    if (read.length >= MAX_ARCHIVE_FILES || total + entry.size > MAX_ARCHIVE_BYTES) {
      skipped.push(`${entry.name} (the archive has more than is read at once)`);
      continue;
    }
    try {
      const file = await readOne({ name: `${name}/${entry.name}`, data: entry.read() }, shrink);
      total += entry.size;
      blocks.push(file.block);
      if (file.table) tables.push(file.table);
      read.push(entry.name);
    } catch (error) {
      if (error instanceof ZipError && error.reason === "ENCRYPTED") throw archiveError(name, error);
      skipped.push(
        `${entry.name} (${error instanceof AttachmentError && error.code === "FILE_TOO_LARGE" ? "too large" : "could not be read"})`,
      );
    }
  }
  if (read.length === 0) {
    throw supported === 0
      ? new AttachmentError(
          "FILE_TYPE",
          `${name}: nothing in the archive can be read (PDF, images, Excel, Word and text files can)`,
        )
      : unreadable(name);
  }
  const note = [
    `Archive ${name}: ${read.length} file(s) read: ${read.join(", ")}.`,
    skipped.length > 0 ? `Not read: ${skipped.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { blocks: [{ type: "text", text: note }, ...blocks], tables };
}

/** Files that archivers and systems add themselves. */
const isNoise = (path: string) =>
  path.startsWith("__MACOSX/") || /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|~\$[^/]*)$/i.test(path);

function archiveError(name: string, error: unknown): AttachmentError {
  if (error instanceof ZipError) {
    if (error.reason === "ENCRYPTED") {
      return new AttachmentError(
        "FILE_UNREADABLE",
        `${name}: the archive is password-protected; unpack it and attach the files`,
      );
    }
    if (error.reason === "UNSUPPORTED") {
      return new AttachmentError(
        "FILE_UNREADABLE",
        `${name}: this kind of archive is not supported (${error.message}); attach the files themselves`,
      );
    }
    if (error.reason === "TOO_MANY") {
      return new AttachmentError("FILE_TOO_LARGE", `${name}: the archive has too many files`);
    }
  }
  return unreadable(name);
}

type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** By content, not by name: a renamed file would be refused by the API. */
function imageType(data: Uint8Array): ImageType | null {
  if (data[0] === 0x89 && startsWith(data.subarray(1), "PNG")) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (startsWith(data, "GIF8")) return "image/gif";
  if (startsWith(data, "RIFF") && startsWith(data.subarray(8), "WEBP")) return "image/webp";
  return null;
}

function imageBlock(data: Uint8Array, type: ImageType, shrink: ShrinkImage | undefined, name: string) {
  let bytes = data;
  let mediaType: ImageType = type;
  // Photos of papers are often 4000 px and several MB; the model reads them as well at 1568 px.
  if (shrink && (type === "image/png" || type === "image/jpeg")) {
    let smaller: Uint8Array | null = null;
    try {
      smaller = shrink(data, IMAGE_SIDE);
    } catch {
      // sent as it is; the size check below still applies
    }
    if (smaller && smaller.byteLength < data.byteLength) {
      bytes = smaller;
      mediaType = "image/jpeg";
    }
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new AttachmentError("FILE_TOO_LARGE", `${name}: the image is larger than 5 MB`);
  }
  return { type: "image", source: { type: "base64", media_type: mediaType, data: base64(bytes) } };
}

async function spreadsheet(data: Uint8Array, name: string): Promise<TableFile> {
  let sheets;
  try {
    sheets = await readXlsxFile(Buffer.from(data));
  } catch {
    throw unreadable(name);
  }
  return {
    name,
    sheets: sheets.map(({ sheet, data: rows }) => ({
      name: sheet,
      rows: rows.map((row) => row.map(cellText)),
    })),
  };
}

/** A table, whole when it is small, else its start and end and how to read the rest. */
function tableBlock(table: TableFile): AiContentBlock {
  return {
    type: "document",
    source: {
      type: "text",
      media_type: "text/plain",
      data: describeTable(table).text || "(the file is empty)",
    },
    title: table.name,
  };
}

/** UTF-8, or Windows-1251 as 1C and older Excel save CSV and text files in Uzbekistan. */
export function decodeText(data: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return new TextDecoder("windows-1251").decode(data);
  }
}

function textBlock(name: string, text: string): AiContentBlock {
  const cut =
    text.length > MAX_TEXT_CHARS
      ? `${text.slice(0, MAX_TEXT_CHARS)}\n… [cut: the file has ${text.length} characters; only the start is shown]`
      : text;
  return {
    type: "document",
    source: { type: "text", media_type: "text/plain", data: cut.trim() || "(the file is empty)" },
    title: name,
  };
}

function startsWith(data: Uint8Array, text: string): boolean {
  for (let i = 0; i < text.length; i++) if (data[i] !== text.charCodeAt(i)) return false;
  return true;
}

function base64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
}

function unreadable(name: string): AttachmentError {
  return new AttachmentError("FILE_UNREADABLE", `${name}: the file could not be read; it may be damaged`);
}
