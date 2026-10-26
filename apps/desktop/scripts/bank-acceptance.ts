/**
 * The acceptance run on real statements, read-only: every line classified, the totals checked.
 *
 *   npx tsx apps/desktop/scripts/bank-acceptance.ts <folder with the .xlsx statements> [company INN]
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import readXlsxFile from "read-excel-file/node";

import { acceptance, acceptanceText } from "../src/main/bank/acceptance.js";
import { parseBankStatement } from "../src/main/bank/statement.js";
import { cellText } from "../src/main/tables.js";

const [folder, ownInn] = process.argv.slice(2);
if (!folder) {
  console.error("usage: bank-acceptance.ts <folder> [company INN]");
  process.exit(1);
}
const statements = [];
for (const name of (await readdir(folder)).filter((f) => /\.xlsx$/i.test(f)).sort()) {
  const sheets = await readXlsxFile(await readFile(join(folder, name)));
  const read = parseBankStatement({
    name,
    sheets: sheets.map(({ sheet, data }) => ({ name: sheet, rows: data.map((row) => row.map(cellText)) })),
  });
  if (read) statements.push(read);
  else console.log(`${name}: not a statement`);
}
console.log(acceptanceText(acceptance(statements, ownInn ? { ownInn } : {})));
