/**
 * TOON (token-oriented object notation) for query results: the column names once, then one row per
 * line, values separated by commas, and dates without a time of day when it is midnight. A result is
 * sent again on every later step, so every token saved is paid back many times. (The app's own JSON
 * already had the columns once; the table is a little smaller and the dates much smaller.)
 *
 *   rows[2]{Счет,СальдоДт}:
 *     5110 Расчетный счет,125000000
 *     "6010, поставщики",0
 */

const NUMERIC = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const LEADING_ZERO = /^0\d+$/;
const SPECIAL = /[,"\\\n\r\t]/;
/** 1C dates come as midnight timestamps: the time adds tokens and no information. */
const MIDNIGHT = /^(\d{4}-\d{2}-\d{2})T00:00:00$/;

/** A value as one cell: quoted when it could be read as something else or break the layout. */
export function cell(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const text = MIDNIGHT.exec(raw)?.[1] ?? raw;
  const plain =
    text !== "" &&
    text === text.trim() &&
    !SPECIAL.test(text) &&
    !NUMERIC.test(text) &&
    !LEADING_ZERO.test(text) &&
    !text.startsWith("-") &&
    text !== "true" &&
    text !== "false" &&
    text !== "null";
  if (plain) return text;
  const escaped = text
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  return `"${escaped}"`;
}

/** The rows as a TOON table: "rows[N]{columns}:" and a line per row. */
export function encodeTable(columns: string[], rows: unknown[][]): string {
  const header = `rows[${rows.length}]{${columns.map(cell).join(",")}}:`;
  return [header, ...rows.map((row) => `  ${columns.map((_, i) => cell(row[i])).join(",")}`)].join("\n");
}

interface Token {
  text: string;
  quoted: boolean;
}

/** One line of cells (the inverse of how cell() writes them): commas split, quotes protect. */
function splitCells(line: string): Token[] {
  const tokens: Token[] = [];
  let text = "";
  let quoted = false;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? "";
    if (inQuotes) {
      if (ch === "\\") {
        const next = line[++i] ?? "";
        text += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next;
      } else if (ch === '"') inQuotes = false;
      else text += ch;
    } else if (ch === '"') {
      inQuotes = true;
      quoted = true;
    } else if (ch === ",") {
      tokens.push({ text, quoted });
      text = "";
      quoted = false;
    } else text += ch;
  }
  tokens.push({ text, quoted });
  return tokens;
}

function value(token: Token): unknown {
  if (token.quoted) return token.text;
  if (token.text === "null") return null;
  if (token.text === "true") return true;
  if (token.text === "false") return false;
  return NUMERIC.test(token.text) ? Number(token.text) : token.text;
}

/**
 * A TOON table back into columns and rows, as a saved chat holds query results the model was sent.
 * Null when the text is not one. Dates that were at midnight stay date-only strings.
 */
export function decodeTable(text: string): { columns: string[]; rows: unknown[][] } | null {
  const lines = text.split("\n");
  const head = /^rows\[\d+\]\{(.*)\}:$/s.exec(lines[0] ?? "");
  if (!head) return null;
  const columns = splitCells(head[1] ?? "").map((t) => t.text);
  const rows: unknown[][] = [];
  for (const line of lines.slice(1)) {
    if (!line.startsWith("  ")) break; // the note about a cut result, or the end
    rows.push(splitCells(line.slice(2)).map(value));
  }
  return { columns, rows };
}
