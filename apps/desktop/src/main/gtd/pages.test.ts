import { describe, expect, it } from "vitest";

import { parseFooter, readPages, splitName } from "./pages.js";
import type { PdfPage } from "./pdf-text.js";

const footer = (sheet: number, of = 12, no = "26003 / 04.11.2025 / 0090704") =>
  `Copy / ${no}. ${sheet}/ ${of}`;

/** Twelve sheets: the form pages carry only a footer (their text layer is garbled), the back pages carry item text. */
export function sampleDeclaration(skip: number[] = []): PdfPage[] {
  const pages: PdfPage[] = [];
  for (let sheet = 1; sheet <= 12; sheet += 1) {
    if (skip.includes(sheet)) continue;
    const lines = [`garbled ${"╬Ж".repeat(sheet)}`, footer(sheet)];
    if (sheet === 1)
      lines.unshift(
        "Item No. 1",
        "1. Preheating equipment/Оборудование для предварительного нагрева",
        "2. Brand: none",
      );
    if (sheet === 2)
      lines.unshift(
        "Item No. 29",
        "1. PDC nozzles (Used)/Сопла PDC Б/у",
        "Item No. 31",
        "1. PDC nozzles/Сопла PDC",
      );
    pages.push({ page: pages.length + 1, lines });
  }
  return pages;
}

describe("the footer of a declaration's page", () => {
  it("gives the declaration's number and the sheet", () => {
    expect(parseFooter("Copy / 26003 / 04.11.2025 / 0090704. 3/ 12")).toMatchObject({
      declarationNo: "26003/04.11.2025/0090704",
      date: "2025-11-04",
      post: "26003",
      serial: "0090704",
      sheet: 3,
      of: 12,
    });
  });
  it.each(["", "Page 3 of 12", "Copy / 26003 / 31.31.2025 / 0090704. 3/ 12", "26003 / 04.11.2025 / 0090704"])(
    "%s is not a footer",
    (line) => expect(parseFooter(line)).toBeNull(),
  );
  it("takes the Russian words too", () => {
    expect(parseFooter("Копия / 27001 / 02.11.2025 / 0160321. 1/ 1")?.declarationNo).toBe(
      "27001/02.11.2025/0160321",
    );
  });
});

describe("the pages of one declaration", () => {
  it("groups by the footer and finds all 12 sheets", () => {
    const read = readPages(sampleDeclaration());
    expect(read.footer?.declarationNo).toBe("26003/04.11.2025/0090704");
    expect(read.total).toBe(12);
    expect(read.present).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(read.missing).toEqual([]);
  });

  it("names the sheet that is missing", () => {
    const read = readPages(sampleDeclaration([7]));
    expect(read.missing).toEqual([7]);
    expect(read.present).not.toContain(7);
  });

  it("reads the names of the items from the back pages, English and Russian split at the first slash", () => {
    const read = readPages(sampleDeclaration());
    expect(read.items.map((i) => i.no)).toEqual([1, 29, 31]);
    expect(read.items[0]).toMatchObject({
      nameEn: "Preheating equipment",
      nameRu: "Оборудование для предварительного нагрева",
      used: false,
    });
    // «Б/у» holds a slash of its own: the name is still split at the first one.
    expect(read.items[1]).toMatchObject({
      nameEn: "PDC nozzles (Used)",
      nameRu: "Сопла PDC Б/у",
      used: true,
    });
    expect(read.items[2]?.used).toBe(false);
  });

  it("a page of another declaration is said and its items are not taken", () => {
    const pages = [
      ...sampleDeclaration(),
      { page: 13, lines: ["Item No. 99", "1. Foreign/Чужой", footer(1, 1, "27001 / 02.11.2025 / 0160321")] },
    ];
    const read = readPages(pages);
    expect(read.foreign).toEqual([{ page: 13, declarationNo: "27001/02.11.2025/0160321" }]);
    expect(read.items.map((i) => i.no)).not.toContain(99);
  });

  it("pages with no readable footer are listed, not merged in", () => {
    const read = readPages([...sampleDeclaration(), { page: 13, lines: ["scan"] }]);
    expect(read.unmarked).toEqual([13]);
  });

  it("the same item text on a continuation sheet is not a second item; a different one is a conflict", () => {
    const pages = sampleDeclaration();
    pages.push({
      page: 20,
      lines: ["Item No. 1", "1. Preheating equipment/Оборудование для предварительного нагрева", footer(11)],
    });
    pages.push({ page: 21, lines: ["Item No. 1", "1. Something else/Другое", footer(12)] });
    const read = readPages(pages);
    expect(read.items.filter((i) => i.no === 1)).toHaveLength(1);
    expect(read.conflicts).toHaveLength(1);
  });

  it("an empty PDF is not a declaration", () => {
    expect(readPages([]).footer).toBeNull();
  });
});

describe("splitting graph 31", () => {
  it("at the first slash", () => {
    expect(splitName("Hardfacing welding rods/Электроды для наплавки")).toEqual({
      en: "Hardfacing welding rods",
      ru: "Электроды для наплавки",
    });
    expect(splitName("No slash here")).toEqual({ en: "No slash here", ru: "" });
  });
});
