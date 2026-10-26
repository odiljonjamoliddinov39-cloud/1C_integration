import { describe, expect, it } from "vitest";

import { makePdf } from "./make-pdf.js";
import { linesOf, readPdfPages } from "./pdf-text.js";

describe("the text layer of a PDF", () => {
  it("gives the lines of each page in reading order", async () => {
    const pages = await readPdfPages(makePdf([["Copy / 26003 / 04.11.2025 / 0090704. 3/ 12", "Item No. 1"]]));
    expect(pages).toHaveLength(1);
    expect(pages?.[0]?.lines).toEqual(["Copy / 26003 / 04.11.2025 / 0090704. 3/ 12", "Item No. 1"]);
  });

  it("gives every page of a longer file, in order", async () => {
    const pages = await readPdfPages(makePdf([["first"], ["second", "page"], ["third"]]));
    expect(pages?.map((p) => p.lines)).toEqual([["first"], ["second", "page"], ["third"]]);
    expect(pages?.map((p) => p.page)).toEqual([1, 2, 3]);
  });

  it("is null for a file that is not a PDF", async () => {
    expect(await readPdfPages(new TextEncoder().encode("not a pdf at all"))).toBeNull();
  });

  it("joins pieces of one height into a line, left to right", () => {
    const at = (str: string, x: number, y: number) => ({ str, transform: [1, 0, 0, 1, x, y] });
    expect(linesOf([at("b", 50, 700), at("a", 10, 700.5), at("below", 10, 650), at("top", 10, 750)])).toEqual(
      ["top", "a b", "below"],
    );
  });
});
