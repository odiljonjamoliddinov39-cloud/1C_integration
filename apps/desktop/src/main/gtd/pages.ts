/**
 * What the clean text of a declaration's PDF says, with no model. The form pages of a GTD are scans with a broken text layer
 * (the numbers are read as pictures), but every page has a clean footer, and the back pages have a clean text of graph 31:
 *
 *   «Copy / 26003 / 04.11.2025 / 0090704. 3/ 12»          the declaration's number and the sheet this page is, of how many
 *   «Item No. 1»  then  «1. Preheating equipment/Оборудование для предварительного нагрева …»
 *
 * The footer groups the pages and shows a sheet that is missing (V1); the item lines give each item its English and Russian
 * names, split at the first «/», so the names are never read from a picture. Nothing here is guessed: what the text does not
 * say is absent.
 */
import type { PdfPage } from "./pdf-text.js";

export interface PdfItemText {
  no: number;
  nameEn: string;
  nameRu: string;
  /** «Б/у» or «Used» in the item's text. */
  used: boolean;
  /** The pages the item's text was found on. */
  pages: number[];
}

export interface PdfFooter {
  /** "26003/04.11.2025/0090704": customs post, date, serial number. */
  declarationNo: string;
  /** ISO. */
  date: string;
  post: string;
  serial: string;
  sheet: number;
  of: number;
}

export interface DeclarationPages {
  /** The declaration the pages belong to: the one most pages name. */
  footer: PdfFooter | null;
  /** The sheets the footers show, 1-based, and how many the declaration has. */
  present: number[];
  total: number | null;
  missing: number[];
  /** Pages of another declaration, or with no footer the program could read: said, never merged in silently. */
  foreign: { page: number; declarationNo: string }[];
  unmarked: number[];
  items: PdfItemText[];
  /** Two different texts for one item number (kept: the first). */
  conflicts: string[];
  /** The pages (1-based) the PDF has. */
  pageCount: number;
}

const FOOTER =
  /(?:Copy|Original|Копия|Оригинал)?\s*\/?\s*(\d{5})\s*\/\s*(\d{2})\.(\d{2})\.(\d{4})\s*\/\s*(\d{7})\s*\.?\s*(\d{1,3})\s*\/\s*(\d{1,3})/u;

/** Footer of one line; null when the line is not a footer. */
export function parseFooter(line: string): PdfFooter | null {
  const m = FOOTER.exec(line.replace(/\s+/g, " "));
  if (!m) return null;
  const [, post, dd, mm, yyyy, serial, sheet, of] = m;
  if (!post || !dd || !mm || !yyyy || !serial || !sheet || !of) return null;
  const date = `${yyyy}-${mm}-${dd}`;
  if (Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || Number(mm) > 12 || Number(dd) > 31) return null;
  return {
    declarationNo: `${post}/${dd}.${mm}.${yyyy}/${serial}`,
    date,
    post,
    serial,
    sheet: Number(sheet),
    of: Number(of),
  };
}

const ITEM_HEAD = /^(?:Item\s+No\.?|Товар\s*(?:№|N)?\.?)\s*(\d{1,3})\b/iu;
const NUMBERED = /^(\d{1,2})\.\s+\S/u;
const USED = /(?:^|[^\p{L}])б\s*\/\s*у(?![\p{L}])|(?:^|[^\p{L}])used(?![\p{L}])|(?:^|[^\p{L}])бывш\p{L}*/iu;

/** English and Russian name of an item from its graph 31 text: split at the first «/» (the Russian part is matched to 1C). */
export function splitName(text: string): { en: string; ru: string } {
  const clean = text.replace(/\s+/g, " ").trim();
  const slash = clean.indexOf("/");
  if (slash < 0) return { en: clean, ru: "" };
  return { en: clean.slice(0, slash).trim(), ru: clean.slice(slash + 1).trim() };
}

export function readPages(pdf: PdfPage[]): DeclarationPages {
  const footers = new Map<number, PdfFooter>();
  for (const page of pdf) {
    // The footer is at the foot of the page: the last lines are tried first, any line after them.
    for (const line of [...page.lines].reverse()) {
      const footer = parseFooter(line);
      if (footer) {
        footers.set(page.page, footer);
        break;
      }
    }
  }
  // The declaration most pages name is this one.
  const votes = new Map<string, number>();
  for (const f of footers.values()) votes.set(f.declarationNo, (votes.get(f.declarationNo) ?? 0) + 1);
  const main = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const own = [...footers.entries()].filter(([, f]) => f.declarationNo === main);
  const firstFooter = own[0]?.[1] ?? null;
  const ofVotes = new Map<number, number>();
  for (const [, f] of own) ofVotes.set(f.of, (ofVotes.get(f.of) ?? 0) + 1);
  const total = [...ofVotes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const present = [...new Set(own.map(([, f]) => f.sheet))].sort((a, b) => a - b);
  const missing: number[] = [];
  if (total !== null) for (let n = 1; n <= total; n += 1) if (!present.includes(n)) missing.push(n);

  const ownPages = new Set(own.map(([page]) => page));
  const items = new Map<number, PdfItemText>();
  const conflicts: string[] = [];
  for (const page of pdf) {
    // Item text on a page of another declaration is not this declaration's.
    if (footers.has(page.page) && !ownPages.has(page.page)) continue;
    const lines = page.lines;
    for (let i = 0; i < lines.length; i += 1) {
      const head = ITEM_HEAD.exec(lines[i] ?? "");
      if (!head) continue;
      const no = Number(head[1]);
      // The item's text: everything up to the next item, or the next numbered graph point after the name.
      const block: string[] = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j] ?? "";
        if (ITEM_HEAD.test(line) || parseFooter(line)) break;
        block.push(line);
      }
      const start = block.findIndex((l) => /^1\.\s*/u.test(l));
      if (start < 0) continue;
      const nameLines: string[] = [(block[start] ?? "").replace(/^1\.\s*/u, "")];
      for (let j = start + 1; j < block.length; j += 1) {
        const line = block[j] ?? "";
        if (NUMBERED.test(line)) break;
        nameLines.push(line);
      }
      const { en, ru } = splitName(nameLines.join(" "));
      if (!en) continue;
      const used = USED.test(block.join(" "));
      const known = items.get(no);
      if (known) {
        if (known.nameEn !== en)
          conflicts.push(
            `item ${no}: «${known.nameEn}» on page ${known.pages[0]} but «${en}» on page ${page.page}`,
          );
        known.pages.push(page.page);
        known.used = known.used || used;
      } else items.set(no, { no, nameEn: en, nameRu: ru, used, pages: [page.page] });
    }
  }
  return {
    footer: firstFooter,
    present,
    total,
    missing,
    foreign: [...footers.entries()]
      .filter(([, f]) => f.declarationNo !== main)
      .map(([page, f]) => ({ page, declarationNo: f.declarationNo })),
    unmarked: pdf.filter((p) => !footers.has(p.page)).map((p) => p.page),
    items: [...items.values()].sort((a, b) => a.no - b.no),
    conflicts,
    pageCount: pdf.length,
  };
}

/** A PDF the program found to be a customs declaration, and what its text says. */
export interface GtdFile {
  fileName: string;
  pages: DeclarationPages;
}

/** The note that goes with a declaration's PDF: what the program already read, and what is left for the model's eyes. */
export function gtdNote(file: GtdFile): string {
  const p = file.pages;
  return [
    `${file.fileName} is a customs declaration (GTD) ${p.footer?.declarationNo ?? ""}: ${p.present.length} of ${p.total ?? "?"} sheets found${p.missing.length ? ` (sheet ${p.missing.join(", ")} missing)` : ""}.`,
    `The program has read the footers and the item descriptions of graph 31 (${p.items.length} items) from the text of the PDF.`,
    "From the form pages read only the numbers and words of the graphs, then call gtd_declaration with them; it checks every number and proposes the postings. Calculate nothing yourself.",
  ].join(" ");
}

/** Whether the pages are a declaration's at all: at least one footer of the form. */
export const isDeclaration = (pages: DeclarationPages) => pages.footer !== null;
