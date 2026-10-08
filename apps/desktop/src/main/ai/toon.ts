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
