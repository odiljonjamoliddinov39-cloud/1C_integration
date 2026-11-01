/**
 * CSV, the other thing a spreadsheet saves: Excel in this region writes `;` between values, Google Sheets `,`, some tools a tab; the
 * file may start with a byte-order mark and may be UTF-8 or Windows-1251 (Russian Excel). Quoted values may hold the delimiter,
 * quotes ("" inside) and line breaks.
 */
import { HttpError } from "../lib/errors.js";

const MAX_ROWS = 20_000;

/** The text of the file: UTF-8, or Windows-1251 when it is not valid UTF-8. */
export function decodeText(data: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    text = new TextDecoder("windows-1251").decode(data);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The delimiter used most in the header line (outside quotes); ";" before "," before a tab when they tie. */
function delimiterOf(text: string): string {
  const header = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  let quoted = false;
  const counts = new Map<string, number>();
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && [";", ",", "\t", "|"].includes(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let best = ",";
  let bestCount = 0;
  for (const d of [";", ",", "\t", "|"]) {
    const n = counts.get(d) ?? 0;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

export function readCsv(data: Uint8Array): string[][] {
  const text = decodeText(data);
  const delimiter = delimiterOf(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
    if (rows.length > MAX_ROWS)
      throw new HttpError(400, "TOO_MANY_ROWS", `A sheet may have up to ${MAX_ROWS} rows`);
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) endCell();
    else if (ch === "\n") endRow();
    else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else cell += ch;
  }
  if (cell !== "" || row.length) endRow();
  return rows;
}
