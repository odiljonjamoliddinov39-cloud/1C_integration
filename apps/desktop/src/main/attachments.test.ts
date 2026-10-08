import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AttachmentError, decodeText, readAttachments } from "./attachments.js";

const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures", name)));
const bytes = (text: string) => new TextEncoder().encode(text);
const textOf = (block: unknown) => (block as { source: { data: string } }).source.data;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe("attachments", () => {
  it("reads an Excel file as tab-separated text, one block per sheet", async () => {
    const { blocks, info } = await readAttachments([
      { name: "Выписка.xlsx", data: fixture("statement.xlsx") },
    ]);
    expect(info).toEqual([{ name: "Выписка.xlsx", kind: "spreadsheet", size: expect.any(Number) }]);
    expect(blocks[0]).toMatchObject({ type: "document", title: "Выписка.xlsx", source: { type: "text" } });
    const text = textOf(blocks[0]);
    expect(text).toBe(
      "### Выписка (3 rows, columns A–B)\nrow\tA\tB\n1\tКонтрагент\tСумма\n2\tООО Тест\t1500000\n3\tИП Каримов\t250000.5",
    );
  });

  it("reads the text of a Word file", async () => {
    const { blocks } = await readAttachments([{ name: "contract.docx", data: fixture("contract.docx") }]);
    const text = textOf(blocks[0]);
    expect(text).toContain("Договор поставки № 15");
    expect(text).toContain("Сумма договора: 12 000 000 сум");
  });

  it("reads CSV files saved by 1C in Windows-1251 as well as UTF-8", async () => {
    // "Сумма;100" in Windows-1251
    const cp1251 = new Uint8Array([0xd1, 0xf3, 0xec, 0xec, 0xe0, 0x3b, 0x31, 0x30, 0x30]);
    expect(decodeText(cp1251)).toBe("Сумма;100");
    expect(decodeText(bytes("Сумма;100"))).toBe("Сумма;100");
    const { blocks, info } = await readAttachments([{ name: "oborot.csv", data: cp1251 }]);
    expect(info[0]?.kind).toBe("text");
    expect(blocks[0]).toMatchObject({
      source: {
        type: "text",
        media_type: "text/plain",
        data: "### oborot.csv (1 rows, columns A–B)\nrow\tA\tB\n1\tСумма\t100",
      },
    });
  });

  it("sends PDFs and images as they are, by their content rather than their name", async () => {
    const pdf = bytes("%PDF-1.7 test");
    const { blocks, info } = await readAttachments([
      { name: "invoice.pdf", data: pdf },
      { name: "photo.jpg", data: PNG }, // a PNG named .jpg
    ]);
    expect(blocks[0]).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: Buffer.from(pdf).toString("base64") },
      title: "invoice.pdf",
    });
    expect(blocks[1]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
    expect(info.map((f) => f.kind)).toEqual(["pdf", "image"]);
  });

  it("scales large photos down to JPEG, and keeps the original when that is not smaller", async () => {
    const calls: number[] = [];
    const small = new Uint8Array([0xff, 0xd8, 0xff, 9]);
    const shrunk = await readAttachments([{ name: "scan.png", data: PNG }], (_data, side) => {
      calls.push(side);
      return small;
    });
    expect(calls).toEqual([1568]);
    expect(shrunk.blocks[0]).toMatchObject({ source: { media_type: "image/jpeg", data: "/9j/CQ==" } });

    const kept = await readAttachments([{ name: "scan.png", data: PNG }], () => new Uint8Array(100));
    expect(kept.blocks[0]).toMatchObject({ source: { media_type: "image/png" } });
  });

  it("refuses files it cannot read, saying what to do", async () => {
    const refused = async (name: string, data = bytes("x")) => {
      const error = await readAttachments([{ name, data }]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AttachmentError);
      return error as AttachmentError;
    };
    expect(await refused("old.xls")).toMatchObject({
      code: "FILE_TYPE",
      message: expect.stringContaining(".xlsx"),
    });
    expect(await refused("setup.exe")).toMatchObject({ code: "FILE_TYPE" });
    expect(await refused("fake.pdf")).toMatchObject({ code: "FILE_UNREADABLE" });
    expect(await refused("broken.xlsx")).toMatchObject({ code: "FILE_UNREADABLE" });
  });
});
