/**
 * The text layer of a PDF, page by page. A GTD comes as a scan with a broken text layer on its form pages and a clean one on
 * the back pages and in the footer (gtd/pages.ts); this reads whatever text there is, so the program has the footer and the
 * item descriptions without any model, and a page with no usable text is left for the model to read as a picture.
 */

/** A PDF is not read past this many pages or bytes: a declaration is a few dozen pages. */
const MAX_PAGES = 200;
const MAX_BYTES = 40 * 1024 * 1024;

export interface PdfPage {
  /** 1-based. */
  page: number;
  /** Lines in reading order, top to bottom, each line's pieces left to right. */
  lines: string[];
}

interface TextItem {
  str: string;
  transform: number[];
  hasEOL?: boolean;
}

/** The pages of a PDF with their lines; null when it cannot be opened (damaged, locked, or too large). */
export async function readPdfPages(data: Uint8Array): Promise<PdfPage[] | null> {
  if (data.byteLength > MAX_BYTES) return null;
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({
      data: new Uint8Array(data),
      useSystemFonts: false,
      verbosity: 0,
    });
    const doc = await task.promise;
    try {
      const pages: PdfPage[] = [];
      for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n += 1) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        pages.push({ page: n, lines: linesOf(content.items as unknown as TextItem[]) });
        page.cleanup();
      }
      return pages;
    } finally {
      await task.destroy();
    }
  } catch {
    return null;
  }
}

/** Text pieces joined into lines by their height on the page (the PDF's own order is the order they were drawn in). */
export function linesOf(items: TextItem[]): string[] {
  const placed = items
    .filter((i) => typeof i.str === "string" && i.str.trim() !== "" && Array.isArray(i.transform))
    .map((i) => ({ text: i.str, x: i.transform[4] ?? 0, y: i.transform[5] ?? 0 }));
  placed.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { y: number; parts: { x: number; text: string }[] }[] = [];
  for (const piece of placed) {
    const line = lines.find((l) => Math.abs(l.y - piece.y) <= 2.5);
    if (line) line.parts.push({ x: piece.x, text: piece.text });
    else lines.push({ y: piece.y, parts: [{ x: piece.x, text: piece.text }] });
  }
  return lines
    .map((l) =>
      l.parts
        .sort((a, b) => a.x - b.x)
        .map((p) => p.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((l) => l !== "");
}
