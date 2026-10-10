import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { AttachmentError, decodeText, dropPages, readAttachments } from "./attachments.js";
import { readTable } from "./tables.js";

const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures", name)));
const bytes = (text: string) => new TextEncoder().encode(text);
const noteOf = (block: unknown) => (block as { text: string }).text;
const textOf = (block: unknown) => (block as { source: { data: string } }).source.data;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

interface ZipFile {
  /** A string is written as UTF-8; bytes are written as they are (a DOS code page name). */
  name: string | Uint8Array;
  data: Uint8Array;
  stored?: boolean;
  encrypted?: boolean;
  /** What the archive says the unpacked size is, when it is to be wrong. */
  declaredSize?: number;
}

/** Builds a .zip the way archivers do: local headers and data, then the central directory. */
function zip(files: ZipFile[]): Uint8Array<ArrayBuffer> {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = typeof file.name === "string" ? Buffer.from(file.name, "utf8") : Buffer.from(file.name);
    const utf8 = typeof file.name === "string" ? 0x800 : 0;
    const flags = utf8 | (file.encrypted ? 1 : 0);
    const packed = file.stored ? Buffer.from(file.data) : deflateRawSync(file.data);
    const method = file.stored ? 0 : 8;
    const size = file.declaredSize ?? file.data.byteLength;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(file.data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc32(file.data), 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, directory, end]));
}

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

  it("keeps only the names of pages and pictures from earlier questions", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "document",
            title: "a.pdf",
            source: { type: "base64", media_type: "application/pdf", data: "AAAA" },
          },
          {
            type: "document",
            title: "t.xlsx",
            source: { type: "text", media_type: "text/plain", data: "table" },
          },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } },
          { type: "text", text: "question" },
        ],
      },
      { role: "assistant", content: "answer" },
      { role: "user", content: "plain" },
    ];
    const kept = dropPages(messages);
    expect(kept[0]?.content).toEqual([
      { type: "text", text: expect.stringContaining("a.pdf was attached earlier") },
      {
        type: "document",
        title: "t.xlsx",
        source: { type: "text", media_type: "text/plain", data: "table" },
      },
      { type: "text", text: expect.stringContaining("A picture was attached earlier") },
      { type: "text", text: "question" },
    ]);
    expect(kept[1]).toBe(messages[1]);
    expect(kept[2]).toBe(messages[2]);
  });

  describe("zip archives", () => {
    it("reads each supported file in it, named after the archive, and notes what it skipped", async () => {
      const { blocks, info, tables } = await readAttachments([
        {
          name: "Документы.zip",
          data: zip([
            { name: "Выписка.xlsx", data: fixture("statement.xlsx") },
            { name: "акты/oborot.csv", data: bytes("Сумма;100") },
            { name: "акты/", data: new Uint8Array(), stored: true },
            { name: "readme.txt", data: bytes("Привет"), stored: true },
            { name: "__MACOSX/._readme.txt", data: bytes("x") },
            { name: "Thumbs.db", data: bytes("x") },
            { name: "setup.exe", data: bytes("MZ") },
          ]),
        },
      ]);
      expect(info).toEqual([{ name: "Документы.zip", kind: "archive", size: expect.any(Number) }]);
      expect(blocks).toHaveLength(4);
      expect(noteOf(blocks[0])).toBe(
        "Archive Документы.zip: 3 file(s) read: Выписка.xlsx, акты/oborot.csv, readme.txt.\n" +
          "Not read: setup.exe (not a supported kind of file).",
      );
      expect(blocks[1]).toMatchObject({ title: "Документы.zip/Выписка.xlsx" });
      expect(textOf(blocks[1])).toContain("ООО Тест");
      expect(textOf(blocks[2])).toContain("Сумма");
      expect(textOf(blocks[3])).toBe("Привет");
      // Spreadsheets in it can be read whole with read_attachment, by their name in the archive.
      expect(tables.map((t) => t.name)).toEqual([
        "Документы.zip/Выписка.xlsx",
        "Документы.zip/акты/oborot.csv",
      ]);
      expect(readTable(tables, { file: "документы.zip/акты/OBOROT.csv" })).toMatchObject({ ok: true });
    });

    it("opens archives inside the archive, as services that zip every document separately make them", async () => {
      const document = (n: number) =>
        zip([
          { name: `Счёт-${n}.xml`, data: bytes(`<doc>${n}</doc>`) },
          { name: `Счёт-${n}.pdf`, data: bytes("%PDF-1.7 x") },
          { name: `Счёт-${n}.p7s`, data: bytes("sig") },
        ]);
      const { blocks, tables } = await readAttachments([
        {
          name: "Архив.zip",
          data: zip([
            { name: "1.zip", data: document(1), stored: true },
            { name: "папка/2.zip", data: document(2), stored: true },
            { name: "broken.zip", data: bytes("PK nothing"), stored: true },
          ]),
        },
      ]);
      const note = noteOf(blocks[0]);
      expect(note).toContain("2 file(s) read: 1.zip/Счёт-1.xml, папка/2.zip/Счёт-2.xml.");
      expect(note).toContain("1.zip/Счёт-1.pdf (the XML of the same document is read instead)");
      expect(note).toContain("1.zip/Счёт-1.p7s (not a supported kind of file)");
      expect(note).toContain("broken.zip (the archive is damaged)");
      expect(blocks[1]).toMatchObject({ title: "Архив.zip/1.zip/Счёт-1.xml" });
      expect(textOf(blocks[1])).toBe("<doc>1</doc>");
      expect(tables).toHaveLength(0);
    });

    it("reads a PDF that has no XML, and keeps the pages of a question within what the API takes", async () => {
      const page = (n: number) => bytes(`%PDF-1.7 ${"x".repeat(4_000_000)}${n}`);
      const { blocks } = await readAttachments([
        {
          name: "scans.zip",
          data: zip([
            { name: "a.pdf", data: page(1) },
            { name: "b.pdf", data: page(2) },
            { name: "c.pdf", data: page(3) },
          ]),
        },
      ]);
      const note = noteOf(blocks[0]);
      expect(note).toContain("2 file(s) read: a.pdf, b.pdf.");
      expect(note).toContain("c.pdf (too many pages and pictures for one question)");
      expect(blocks).toHaveLength(3);
    });

    it("stops opening archives inside archives after three levels", async () => {
      const level4 = zip([{ name: "a.txt", data: bytes("deep") }]);
      const level3 = zip([
        { name: "d.zip", data: level4, stored: true },
        { name: "c.txt", data: bytes("ok") },
      ]);
      const level2 = zip([{ name: "c.zip", data: level3, stored: true }]);
      const { blocks } = await readAttachments([
        { name: "top.zip", data: zip([{ name: "b.zip", data: level2, stored: true }]) },
      ]);
      expect(noteOf(blocks[0])).toContain("b.zip/c.zip/c.txt");
      expect(noteOf(blocks[0])).toContain("b.zip/c.zip/d.zip (archives are opened only 3 levels deep)");
    });

    it("reads names written in the DOS Cyrillic code page", async () => {
      // "Акт.txt" in CP866
      const name = new Uint8Array([0x80, 0xaa, 0xe2, 0x2e, 0x74, 0x78, 0x74]);
      const { blocks } = await readAttachments([
        { name: "old.zip", data: zip([{ name, data: bytes("текст") }]) },
      ]);
      expect(noteOf(blocks[0])).toContain("Акт.txt");
      expect(blocks[1]).toMatchObject({ title: "old.zip/Акт.txt" });
    });

    it("keeps the rest when one file in it is damaged", async () => {
      const { blocks } = await readAttachments([
        {
          name: "mix.zip",
          data: zip([
            { name: "broken.xlsx", data: bytes("not a spreadsheet") },
            { name: "note.txt", data: bytes("ok") },
          ]),
        },
      ]);
      expect(noteOf(blocks[0])).toContain("Not read: broken.xlsx (could not be read)");
      expect(textOf(blocks[1])).toBe("ok");
    });

    it("refuses archives it can not use, saying why", async () => {
      const refused = async (data: Uint8Array<ArrayBuffer>) => {
        const error = await readAttachments([{ name: "a.zip", data }]).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AttachmentError);
        return error as AttachmentError;
      };
      expect(await refused(bytes("this is not a zip"))).toMatchObject({ code: "FILE_UNREADABLE" });
      expect(await refused(zip([]))).toMatchObject({ code: "FILE_TYPE" });
      expect(await refused(zip([{ name: "setup.exe", data: bytes("MZ") }]))).toMatchObject({
        code: "FILE_TYPE",
        message: expect.stringContaining("Found: setup.exe (not a supported kind of file)"),
      });
      expect(await refused(zip([{ name: "a.txt", data: bytes("x"), encrypted: true }]))).toMatchObject({
        code: "FILE_UNREADABLE",
        message: expect.stringContaining("password"),
      });
      // The end of a real archive cut off
      expect(await refused(zip([{ name: "a.txt", data: bytes("x") }]).subarray(0, 40))).toMatchObject({
        code: "FILE_UNREADABLE",
      });
    });

    it("does not unpack more than the archive declares", async () => {
      const bomb = zip([
        { name: "big.txt", data: new Uint8Array(5_000_000), declaredSize: 10 },
        { name: "ok.txt", data: bytes("ok") },
      ]);
      const { blocks } = await readAttachments([{ name: "bomb.zip", data: bomb }]);
      expect(noteOf(blocks[0])).toContain("Not read: big.txt (could not be read)");
      expect(textOf(blocks[1])).toBe("ok");
    });

    it("skips what is larger than a file may be, and what is past the limit of files", async () => {
      const many = Array.from({ length: 62 }, (_, i) => ({ name: `f${i}.txt`, data: bytes(`n${i}`) }));
      const { blocks } = await readAttachments([
        {
          name: "many.zip",
          data: zip([{ name: "huge.txt", data: bytes("x"), declaredSize: 11 * 1024 * 1024 }, ...many]),
        },
      ]);
      const note = noteOf(blocks[0]);
      expect(note).toContain("60 file(s) read");
      expect(note).toContain("huge.txt (larger than 10 MB)");
      expect(note).toContain("f61.txt (the archive has more than is read at once)");
      expect(blocks).toHaveLength(61);
    });
  });
});
