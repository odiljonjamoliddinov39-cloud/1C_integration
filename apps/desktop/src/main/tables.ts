/**
 * Spreadsheets and CSV files attached to a chat, kept whole on the PC. The model sees a small one
 * whole and a large one as a summary, and reads the rest with the read_attachment tool: rows,
 * filters, and counts and totals over the whole file, so a 5 000-row bank statement can be compared
 * with 1C month by month without sending it all.
 */
import type { ReadAttachmentInput } from "@platform/shared";

export interface SheetTable {
  name: string;
  /** Cells as text: numbers as written by Excel ("1500000.5"), dates as YYYY-MM-DD. */
  rows: string[][];
}

export interface TableFile {
  name: string;
  sheets: SheetTable[];
}

/** A file this size or smaller goes to the model whole; a larger one as a summary. */
export const INLINE_CHARS = 60_000;
/** Rows shown at the start and the end of a large sheet's summary. */
const HEAD_ROWS = 40;
const TAIL_ROWS = 5;

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 19);
  }
  return String(value)
    .replace(/[\t\r\n]+/g, " ")
    .trim();
}

/** CSV or TSV, with ; , or tab between cells (1C saves ;), and "quoted" cells. */
export function parseCsv(text: string): string[][] {
  const firstLine = text.slice(0, text.indexOf("\n") >>> 0);
  const delimiter = [";", "\t", ","].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delimiter) {
      row.push(cell.trim());
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) rows.push([...row, cell.trim()]);
  return rows;
}

/** Column letters as in Excel: 0 → A, 26 → AA. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function columnIndex(letter: string): number {
  let n = 0;
  for (const c of letter.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

function width(sheet: SheetTable): number {
  return sheet.rows.reduce((max, row) => Math.max(max, row.length), 0);
}

function renderRows(rows: { n: number; cells: string[] }[], letters: string[]): string {
  const lines = rows
    .filter((row) => row.cells.some((cell) => cell !== ""))
    .map((row) => `${row.n}\t${row.cells.join("\t")}`.replace(/\t+$/, ""));
  return [`row\t${letters.join("\t")}`, ...lines].join("\n");
}

function sheetRows(sheet: SheetTable, from = 1, to = sheet.rows.length) {
  return sheet.rows.slice(from - 1, to).map((cells, i) => ({ n: from + i, cells }));
}

/** What the model gets for an attached table: the whole file when small, else a summary. */
export function describeTable(file: TableFile): { text: string; whole: boolean } {
  const whole = file.sheets
    .map((sheet) => {
      const letters = Array.from({ length: width(sheet) }, (_, i) => columnLetter(i));
      return `### ${sheet.name} (${sheet.rows.length} rows, columns ${letters[0] ?? "A"}–${letters.at(-1) ?? "A"})\n${renderRows(sheetRows(sheet), letters)}`;
    })
    .join("\n\n");
  if (whole.length <= INLINE_CHARS) return { text: whole, whole: true };

  const summary = file.sheets.map((sheet) => {
    const letters = Array.from({ length: width(sheet) }, (_, i) => columnLetter(i));
    const total = sheet.rows.length;
    const head = renderRows(sheetRows(sheet, 1, Math.min(HEAD_ROWS, total)), letters);
    const tail =
      total > HEAD_ROWS
        ? `\n…\n${renderRows(sheetRows(sheet, Math.max(HEAD_ROWS + 1, total - TAIL_ROWS + 1), total), letters)
            .split("\n")
            .slice(1)
            .join("\n")}`
        : "";
    return `### ${sheet.name} (${total} rows, columns ${letters[0] ?? "A"}–${letters.at(-1) ?? "A"})\n${head}${tail}`;
  });
  return {
    text:
      `This file is large (${file.sheets.reduce((n, s) => n + s.rows.length, 0)} rows), so only its start and end ` +
      `are shown. The whole file is on the accountant's PC: read it with read_attachment (file "${file.name}") — ` +
      `rows by number, filters, and counts and totals over all rows (group_by a column or by month).\n\n` +
      summary.join("\n\n"),
    whole: false,
  };
}

/** "1 234 567,89", "1,234,567.89", "-500" → number; NaN when the cell is not a number. */
export function parseNumber(text: string): number {
  let s = text.replace(/[\s\u00a0']/g, "");
  if (s === "") return Number.NaN;
  if (s.includes(",") && s.includes(".")) s = s.replace(/,/g, "");
  else if (s.includes(",")) s = s.replace(",", ".");
  return /^[-+]?\d*\.?\d+$/.test(s) ? Number(s) : Number.NaN;
}

/** "2026-01-05…", "05.01.2026", "05/01/2026" → "2026-01-05"; null when the cell is not a date. */
export function parseDate(text: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(text);
  if (dmy) return `${dmy[3]}-${(dmy[2] ?? "").padStart(2, "0")}-${(dmy[1] ?? "").padStart(2, "0")}`;
  return null;
}

/**
 * Compares as numbers when the value is a number, as dates when it is a date, else as text. A cell
 * of another kind (a title or header row) gives null: it is neither more nor less.
 */
function compare(cell: string, value: string): number | null {
  const b = parseNumber(value);
  if (!Number.isNaN(b)) {
    const a = parseNumber(cell);
    return Number.isNaN(a) ? null : a - b;
  }
  const db = parseDate(value);
  if (db) {
    const da = parseDate(cell);
    return da === null ? null : da < db ? -1 : da > db ? 1 : 0;
  }
  return cell.toLowerCase().localeCompare(value.toLowerCase());
}

type Where = NonNullable<ReadAttachmentInput["where"]>[number];

function matches(cells: string[], where: Where[]): boolean {
  return where.every(({ column, op, value = "" }) => {
    const cell = cells[columnIndex(column)] ?? "";
    switch (op) {
      case "=":
        return compare(cell, value) === 0;
      case "!=":
        return compare(cell, value) !== 0;
      case "contains":
        return cell.toLowerCase().includes(value.toLowerCase());
      case ">":
        return (compare(cell, value) ?? Number.NaN) > 0;
      case ">=":
        return (compare(cell, value) ?? Number.NaN) >= 0;
      case "<":
        return (compare(cell, value) ?? Number.NaN) < 0;
      case "<=":
        return (compare(cell, value) ?? Number.NaN) <= 0;
      case "empty":
        return cell === "";
      case "not_empty":
        return cell !== "";
    }
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export type ReadResult =
  { ok: true; data: unknown } | { ok: false; code: "FILE_NOT_FOUND" | "SHEET_NOT_FOUND"; message: string };

/** The read_attachment tool over the chat's tables (the newest file of a name wins). */
export function readTable(files: TableFile[], input: ReadAttachmentInput): ReadResult {
  const file = [...files].reverse().find((f) => f.name.toLowerCase() === input.file.toLowerCase());
  if (!file) {
    return {
      ok: false,
      code: "FILE_NOT_FOUND",
      message: `No attached table "${input.file}". Attached: ${files.map((f) => f.name).join(", ") || "none"}`,
    };
  }
  const wanted = input.sheet?.toLowerCase();
  const sheet = wanted ? file.sheets.find((s) => s.name.toLowerCase() === wanted) : file.sheets[0];
  if (!sheet) {
    return {
      ok: false,
      code: "SHEET_NOT_FOUND",
      message: `No sheet "${input.sheet}". Sheets: ${file.sheets.map((s) => s.name).join(", ")}`,
    };
  }
  const rows = sheetRows(sheet, input.from ?? 1, input.to ?? sheet.rows.length).filter(
    (row) => row.cells.some((cell) => cell !== "") && matches(row.cells, input.where ?? []),
  );
  const limit = input.limit ?? 200;

  if (input.group_by || input.sum) {
    const sums = input.sum ?? [];
    const groups = new Map<string, { count: number; totals: number[]; skipped: number }>();
    for (const row of rows) {
      let key = "all";
      if (input.group_by) {
        const cell = row.cells[columnIndex(input.group_by.column)] ?? "";
        const date = input.group_by.by === "value" ? null : parseDate(cell);
        key =
          input.group_by.by === "month"
            ? (date?.slice(0, 7) ?? "(not a date)")
            : input.group_by.by === "day"
              ? (date ?? "(not a date)")
              : cell;
      }
      const group = groups.get(key) ?? { count: 0, totals: sums.map(() => 0), skipped: 0 };
      group.count++;
      sums.forEach((column, i) => {
        const n = parseNumber(row.cells[columnIndex(column)] ?? "");
        if (Number.isNaN(n)) group.skipped++;
        else group.totals[i] = (group.totals[i] ?? 0) + n;
      });
      groups.set(key, group);
    }
    const keys = [...groups.keys()].sort();
    return {
      ok: true,
      data: {
        sheet: sheet.name,
        matchedRows: rows.length,
        columns: [
          input.group_by ? `group (${input.group_by.column}, ${input.group_by.by})` : "group",
          "rows",
          ...sums.map((c) => `sum ${c}`),
        ],
        groups: keys.slice(0, limit).map((key) => {
          const g = groups.get(key);
          return [key, g?.count ?? 0, ...(g?.totals ?? []).map(round2)];
        }),
        ...(keys.length > limit ? { moreGroups: keys.length - limit } : {}),
        note: "Cells that are not numbers are not added to the totals.",
      },
    };
  }

  const pick = (input.columns ?? []).map(columnIndex);
  const letters =
    input.columns?.map((c) => c.toUpperCase()) ??
    Array.from({ length: width(sheet) }, (_, i) => columnLetter(i));
  const shown = rows
    .slice(0, limit)
    .map((row) => [row.n, ...(pick.length > 0 ? pick.map((i) => row.cells[i] ?? "") : row.cells)]);
  return {
    ok: true,
    data: {
      sheet: sheet.name,
      matchedRows: rows.length,
      columns: ["row", ...letters],
      rows: shown,
      ...(rows.length > limit ? { more: rows.length - limit, next: `from ${rows[limit]?.n}` } : {}),
    },
  };
}
