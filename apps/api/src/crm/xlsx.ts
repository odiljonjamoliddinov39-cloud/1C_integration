/**
 * Reads and writes .xlsx (a zip of XML files) with no spreadsheet library: only the first sheet, only its values. Reading takes
 * shared strings, inline strings, numbers and booleans; formulas give their last calculated value. Writing makes one sheet of
 * text and numbers with a bold header row.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import { HttpError } from "../lib/errors.js";
import { readCsv } from "./csv.js";

/** The biggest sheet read: a guard against a file that is a zip bomb or a million empty rows. */
const MAX_ROWS = 20_000;
const MAX_UNZIPPED = 60 * 1024 * 1024;

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

const escapeXml = (s: string) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** The text of a <si> / <is> element: its <t> parts joined (rich text has several). */
function richText(xml: string): string {
  let out = "";
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g)) out += unescapeXml(m[1] ?? "");
  return out;
}

/** "AB12" → column index 27. */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function columnName(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** A number cell as Excel wrote it: 9.98901234567E11 is the phone 998901234567, not text with an "E" in it. */
function plainNumber(v: string, type: string | undefined): string {
  if (type !== undefined && type !== "n") return v;
  if (!/^-?\d+(\.\d+)?[eE][+-]?\d+$/.test(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && Math.abs(n) < 1e21 ? BigInt(n).toString() : v;
}

/** What a file is, by its first bytes: a zip (an .xlsx), an old Excel .xls (OLE), or text (CSV). */
export function fileKind(data: Uint8Array): "xlsx" | "xls" | "text" {
  if (data[0] === 0x50 && data[1] === 0x4b) return "xlsx";
  if (data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0) return "xls";
  return "text";
}

/**
 * The rows of an uploaded file, whatever it is: an .xlsx, or a CSV. The old binary .xls cannot be read: the message says how to
 * save it as .xlsx.
 */
export function readSheetFile(data: Uint8Array): string[][] {
  switch (fileKind(data)) {
    case "xlsx":
      return readXlsx(data);
    case "xls":
      throw new HttpError(
        400,
        "OLD_XLS",
        "This is an old Excel file (.xls): open it in Excel and use File → Save As → Excel Workbook (.xlsx), or save it as CSV",
      );
    default:
      return readCsv(data);
  }
}

/** The first sheet of the workbook as rows of text (empty cells are ""). Throws 400 for a file that is not a workbook. */
export function readXlsx(data: Uint8Array): string[][] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (f) =>
        f.originalSize <= MAX_UNZIPPED &&
        /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(
          f.name,
        ),
    });
  } catch {
    throw new HttpError(400, "BAD_XLSX", "This is not an .xlsx file");
  }
  const workbook = files["xl/workbook.xml"];
  if (!workbook) throw new HttpError(400, "BAD_XLSX", "This is not an .xlsx file");

  // The first <sheet> and the file its relationship id points at.
  const first = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(strFromU8(workbook));
  const rels = files["xl/_rels/workbook.xml.rels"];
  let sheetPath: string | undefined;
  if (first && rels) {
    for (const m of strFromU8(rels).matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const attrs = m[1] ?? "";
      if (new RegExp(`\\bId="${first[1]}"`).test(attrs)) {
        const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1];
        if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
      }
    }
  }
  sheetPath ??= Object.keys(files)
    .filter((n) => n.startsWith("xl/worksheets/"))
    .sort()[0];
  const sheet = sheetPath ? files[sheetPath] : undefined;
  if (!sheet) throw new HttpError(400, "BAD_XLSX", "The workbook has no sheet");

  const shared: string[] = [];
  const sst = files["xl/sharedStrings.xml"];
  if (sst)
    for (const m of strFromU8(sst).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\s*\/>/g))
      shared.push(richText(m[1] ?? ""));

  const rows: string[][] = [];
  const xml = strFromU8(sheet);
  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(/\br="(\d+)"/.exec(rowMatch[1] ?? "")?.[1] ?? rows.length + 1);
    if (rowNumber > MAX_ROWS)
      throw new HttpError(400, "TOO_MANY_ROWS", `A sheet may have up to ${MAX_ROWS} rows`);
    const cells: string[] = [];
    let next = 0;
    for (const cell of (rowMatch[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const index = ref ? columnIndex(ref) : next;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const body = cell[2] ?? "";
      let value = "";
      if (type === "inlineStr") value = richText(body);
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v !== undefined) {
          if (type === "s") value = shared[Number(v)] ?? "";
          else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
          else value = plainNumber(unescapeXml(v), type);
        }
      }
      while (cells.length < index) cells.push("");
      cells[index] = value;
      next = index + 1;
    }
    while (rows.length < rowNumber - 1) rows.push([]);
    rows[rowNumber - 1] = cells;
  }
  return rows;
}

export interface Sheet {
  name: string;
  /** The first row is the header (bold). */
  rows: (string | number | null)[][];
}

function sheetXml(rows: Sheet["rows"]): string {
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          if (value === null || value === "") return "";
          const ref = `${columnName(c)}${r + 1}`;
          const style = r === 0 ? ' s="1"' : "";
          return typeof value === "number"
            ? `<c r="${ref}"${style}><v>${value}</v></c>`
            : `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  const width = Math.max(1, ...rows.map((r) => r.length));
  const cols = `<cols><col min="1" max="${width}" width="22" customWidth="1"/></cols>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${sheetRows}</sheetData></worksheet>`;
}

/** Sheets of values as an .xlsx file. */
export function writeXlsx(sheets: Sheet[]): Uint8Array {
  const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      xml(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
      ),
    ),
    "_rels/.rels": strToU8(
      xml(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
    ),
    "xl/workbook.xml": strToU8(
      xml(
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${escapeXml(s.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
      ),
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      xml(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      ),
    ),
    "xl/styles.xml": strToU8(
      xml(
        `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
      ),
    ),
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s.rows));
  });
  return zipSync(files);
}

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
