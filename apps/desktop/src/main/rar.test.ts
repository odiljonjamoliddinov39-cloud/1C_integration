import { describe, expect, it } from "vitest";

import { readAttachments } from "./attachments.js";
import { isRar, readRar } from "./rar.js";
import { makeXlsx } from "./remote/xlsx.js";

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (data: Uint8Array) => {
  let c = 0xffffffff;
  for (const byte of data) c = (CRC[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const vint = (value: number): number[] => {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
};
const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

/** A header block: its CRC, then its size and the fields. */
function block(fields: number[]): number[] {
  const body = [...vint(fields.length), ...fields];
  return [...u32(crc32(Uint8Array.from(body))), ...body];
}

/** A RAR 5 archive whose files are stored (not compressed): enough to test the reader without the RAR program. */
function rar5(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const out: number[] = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];
  out.push(...block([...vint(1), ...vint(0), ...vint(0)]));
  for (const { name, data } of files) {
    const nameBytes = [...new TextEncoder().encode(name)];
    out.push(
      ...block([
        ...vint(2), // file header
        ...vint(0x2), // the data area is present
        ...vint(data.length), // its size
        ...vint(0x4), // file flags: the CRC is given
        ...vint(data.length), // unpacked size
        ...vint(0), // attributes
        ...u32(crc32(data)),
        ...vint(0), // compression: version 0, stored
        ...vint(1), // host OS
        ...vint(nameBytes.length),
        ...nameBytes,
      ]),
      ...data,
    );
  }
  out.push(...block([...vint(5), ...vint(0), ...vint(0)]));
  return Uint8Array.from(out);
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("rar archives", () => {
  it("are told by their first bytes", () => {
    expect(isRar(rar5([]))).toBe(true);
    expect(isRar(bytes("PK\u0003\u0004 not a rar"))).toBe(false);
  });

  it("are read in memory, entry by entry", async () => {
    const entries = await readRar(
      rar5([
        { name: "a.txt", data: bytes("hello") },
        { name: "папка/b.csv", data: bytes("x;y\n1;2\n") },
      ]),
    );
    expect(entries.map((e) => [e.name, e.size, e.directory])).toEqual([
      ["a.txt", 5, false],
      ["папка/b.csv", 8, false],
    ]);
    expect(new TextDecoder().decode(entries[1]?.read())).toBe("x;y\n1;2\n");
    expect(new TextDecoder().decode(entries[0]?.read())).toBe("hello");
  });

  it("are opened when attached, with an Excel template (.xltx) inside", async () => {
    const sheet = makeXlsx("List", [
      ["Nomi", "Summa"],
      ["Soliq", 1200],
    ]);
    const attached = await readAttachments([
      {
        name: "техмаш 2024-2026 г.rar",
        data: rar5([
          { name: "311012912_ilova.xltx", data: sheet },
          { name: "izoh.txt", data: bytes("soliq hisoboti") },
        ]) as Uint8Array<ArrayBuffer>,
      },
    ]);
    expect(attached.info).toEqual([
      { name: "техмаш 2024-2026 г.rar", kind: "archive", size: expect.any(Number) },
    ]);
    expect(JSON.stringify(attached.blocks)).toContain("311012912_ilova.xltx");
    expect(JSON.stringify(attached.blocks)).toContain("Soliq");
    expect(attached.tables).toHaveLength(1);
  });

  it("attached by itself, an .xltx is read like an .xlsx", async () => {
    const sheet = makeXlsx("List", [
      ["A", "B"],
      [1, 2],
    ]);
    const attached = await readAttachments([{ name: "ilova.xltx", data: sheet as Uint8Array<ArrayBuffer> }]);
    expect(attached.info[0]).toMatchObject({ name: "ilova.xltx", kind: "spreadsheet" });
  });
});
