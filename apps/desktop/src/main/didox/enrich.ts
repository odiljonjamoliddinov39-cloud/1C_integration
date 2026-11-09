/**
 * What the program finds for an outgoing invoice before the model is asked: the IKPU code a line lacks, from what the
 * buyer was sold (the same item; an advance line, which has no item, also takes the unit), and the buyer's INN from the company's own Didox
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
  /** The item's full name, when 1C has one (the invoice line may carry it instead of the short name). */
  fullName?: string;
  unit: string;
  sum: number;
}

const ADVANCE = /аванс|avans|advance/i;
const IKPU = /^\d{17}$/;

/** A name as the buyer's sales and the invoice may write it differently: lower case, no quotes or signs, one space. */
const plain = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * The line of the buyer's earlier sale that is this very item: the same name (case, quotes and signs aside), whole, never one
 * name inside another (two products can differ by a word or a size). `coded` is as 1C gave it, newest sale first, so the first
 * match is the code in use now.
 */
function sameItem(line: Line, coded: SoldLine[]): SoldLine | undefined {
  const name = plain(line.name);
  if (!name) return undefined;
  return coded.find(
    (s) => plain(s.name) === name || (s.fullName !== undefined && plain(s.fullName) === name),
  );
}

/**
 * The lines with the IKPU code (and name) filled where they have none, only from what is true of that line: a line of
 * goods takes the code of the same item in the buyer's earlier sales; an advance line (it has no item) takes the code and
 * the unit of the earlier sale's line with the largest sum that has a code. A goods line whose item the buyer was never
 * sold keeps no code and is named in `notes` (another item's code would put it in the wrong class of goods, with the
 * wrong tax treatment): the accountant gives the code. `sold` is the buyer's earlier sale lines, newest first. `notes` says
 * what was filled and what is left (only that none was found in those sales, not that none exists), for the card and the answer.
 */
export function fillFromSale(lines: Line[], sold: SoldLine[]): { lines: Line[]; notes: string[] } {
  const coded = sold.filter((s) => IKPU.test(s.ikpu.trim()));
  const biggest = [...coded].sort((a, b) => b.sum - a.sum).at(0);
  const notes: string[] = [];
  const filled = lines.map((line, i) => {
    if (line.catalogCode) return line;
    if (ADVANCE.test(line.name)) {
      if (!biggest) return line;
      const unit = biggest.unit.trim() ? biggest.unit.trim() : line.unit;
      notes.push(
        `Line ${i + 1}: IKPU ${biggest.ikpu.trim()} (${biggest.name}) from the buyer's last sale` +
          (unit !== line.unit ? `, unit "${unit}"` : ""),
      );
      return { ...line, unit, catalogCode: biggest.ikpu.trim(), catalogName: biggest.name };
    }
    const same = sameItem(line, coded);
    if (!same) {
      notes.push(
        `Line ${i + 1}: no IKPU found for "${line.name}" in the buyer's recent sales (none was borrowed from another item): give the code`,
      );
      return line;
    }
    notes.push(
      `Line ${i + 1}: IKPU ${same.ikpu.trim()} (${same.name}) from the buyer's earlier sale of this item`,
    );
    return { ...line, catalogCode: same.ikpu.trim(), catalogName: same.name };
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

/**
 * The units the company's own Didox documents use, as `{id, name}` (the shape `findMeasure` reads): what a document
 * says of a unit is certain to be one Didox accepts, whatever shape its list of units has.
 */
export function unitsOfDocuments(docs: DidoxDocument[]): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const doc of docs)
    for (const line of doc.lines)
      if (line.unitId && line.unit.trim() && !seen.has(line.unit.trim()))
        seen.set(line.unit.trim(), line.unitId);
  return [...seen].map(([name, id]) => ({ id, name }));
}
