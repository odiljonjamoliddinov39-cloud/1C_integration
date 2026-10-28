/**
 * What the program finds for an outgoing invoice before the model is asked: the IKPU code and unit a line lacks (an
 * advance line has no item) from what the buyer was last sold, and the buyer's INN from the company's own Didox
 * documents when 1C holds none. Nothing here is invented: a value is read from the company's own records, shown on the
 * card or offered for confirmation, and left empty when there is none.
 */
import type { DidoxDocument } from "./document.js";
import type { DraftInput } from "./outgoing.js";

type Line = DraftInput["lines"][number];

/** One line of the buyer's earlier sale in 1C. */
export interface SoldLine {
  ikpu: string;
  name: string;
  unit: string;
  sum: number;
}

const ADVANCE = /аванс|avans|advance/i;
const IKPU = /^\d{17}$/;

/**
 * The lines with the IKPU code (and name) filled where they have none, from the line of the buyer's earlier sale with the
 * largest sum that has a code. An advance line also takes that line's unit, as it has no unit of its own that Didox knows.
 * `notes` says what was filled, for the card and the answer.
 */
export function fillFromSale(lines: Line[], sold: SoldLine[]): { lines: Line[]; notes: string[] } {
  const base = sold
    .filter((s) => IKPU.test(s.ikpu.trim()))
    .sort((a, b) => b.sum - a.sum)
    .at(0);
  if (!base) return { lines, notes: [] };
  const notes: string[] = [];
  const filled = lines.map((line, i) => {
    if (line.catalogCode) return line;
    const unit = ADVANCE.test(line.name) && base.unit.trim() ? base.unit.trim() : line.unit;
    notes.push(
      `Line ${i + 1}: IKPU ${base.ikpu.trim()} (${base.name}) from the buyer's last sale` +
        (unit !== line.unit ? `, unit "${unit}"` : ""),
    );
    return { ...line, unit, catalogCode: base.ikpu.trim(), catalogName: base.name };
  });
  return { lines: filled, notes };
}

const FORMS = new Set(["ооо", "мчж", "mchj", "ooo", "ao", "аж", "aj", "ип", "yatt"]);

const normal = (name: string) =>
  name
    .toLowerCase()
    .replace(/["'«»“”`ʻʼ’.,]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !FORMS.has(word))
    .join(" ");

/** The companies in the Didox documents whose name is the buyer's (as 1C names it), each with its INN, once. */
export function tinsByName(docs: DidoxDocument[], name: string): { tin: string; name: string }[] {
  const wanted = normal(name);
  if (!wanted) return [];
  const found = new Map<string, string>();
  for (const doc of docs)
    for (const party of [doc.buyer, doc.seller])
      if (/^(\d{9}|\d{14})$/.test(party.tin) && !/^0+$/.test(party.tin) && normal(party.name) === wanted)
        found.set(party.tin, party.name);
  return [...found].map(([tin, partyName]) => ({ tin, name: partyName }));
}
