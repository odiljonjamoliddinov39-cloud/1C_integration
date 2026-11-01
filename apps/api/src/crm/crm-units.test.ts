import { describe, expect, it } from "vitest";

import { leadsWorkbook, reportWorkbook } from "./export.js";
import { sheetIdOf } from "./google-sheets.js";
import { findHeader, mapColumns } from "./import.js";
import { readCsv } from "./csv.js";
import { firstPhone, normalizePhone } from "./phone.js";
import { readSheetFile, readXlsx, writeXlsx } from "./xlsx.js";

describe("phone numbers", () => {
  it("makes one key of every writing of one number", () => {
    const keys = ["+998 90 123-45-67", "90 123 45 67", "998901234567", "(90) 123.45.67", "0901234567"].map(
      (p) => normalizePhone(p)?.key,
    );
    expect(new Set(keys)).toEqual(new Set(["998901234567"]));
    expect(normalizePhone("90 123 45 67")?.display).toBe("+998901234567");
  });

  it("takes an international number as it is", () => {
    expect(normalizePhone("+7 495 123-45-67")?.key).toBe("74951234567");
  });

  it("refuses a broken number instead of guessing", () => {
    for (const bad of ["", "abc", "90 12", "90-123-45-6x", "9.98E11", "1234567890123456", "+++"])
      expect(normalizePhone(bad), bad).toBeNull();
  });
});

describe("xlsx", () => {
  it("reads back what it wrote, with text, numbers, empty cells and special characters", () => {
    const rows = [
      ["Ism", "Telefon", "Izoh"],
      ['Ali <&> "Valiyev"', 998901234567, "o'zbek, русский, 日本"],
      ["", "90 123 45 67", null],
    ];
    const read = readXlsx(writeXlsx([{ name: "Test", rows }]));
    expect(read).toEqual([
      ["Ism", "Telefon", "Izoh"],
      ['Ali <&> "Valiyev"', "998901234567", "o'zbek, русский, 日本"],
      ["", "90 123 45 67"],
    ]);
  });

  it("reads only the first sheet", () => {
    const data = writeXlsx([
      { name: "A", rows: [["x"], ["1"]] },
      { name: "B", rows: [["y"], ["2"]] },
    ]);
    expect(readXlsx(data)).toEqual([["x"], ["1"]]);
  });

  it("answers 400 for a file that is not a workbook", () => {
    expect(() => readXlsx(new TextEncoder().encode("name,phone\nAli,901234567"))).toThrow(/xlsx/);
  });

  it("builds the exports", () => {
    expect(readXlsx(leadsWorkbook("uz", []))[0]?.[0]).toBe("Ism");
    const empty = {
      period: { from: null, to: null },
      totalLeads: 0,
      conversionPct: 0,
      won: 0,
      lost: 0,
      funnel: [],
      lostStages: [],
      timeInStage: [],
      bySource: [],
      byManager: [],
    };
    expect(readXlsx(reportWorkbook("ru", empty))[0]?.[0]).toBe("Этап");
  });
});

describe("import columns", () => {
  it("matches the headers in Uzbek, Russian and English and leaves the rest out", () => {
    const { fields, mapped, ignored } = mapColumns([
      "Ism familiya",
      "Телефон",
      "Manba",
      "Kompaniya",
      "Izoh",
      "Yosh",
      "",
    ]);
    expect([...fields.keys()].sort()).toEqual(["company", "name", "note", "phone", "source"]);
    expect(mapped).toHaveLength(5);
    expect(ignored).toEqual(["Yosh"]);
  });

  it("uses the first of two columns for one field", () => {
    const { fields, ignored } = mapColumns(["Phone", "Telefon"]);
    expect(fields.get("phone")).toBe(0);
    expect(ignored).toEqual(["Telefon"]);
  });
});

describe("Google Sheets links", () => {
  it("takes the id and the tab", () => {
    expect(sheetIdOf("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUv/edit#gid=123")).toEqual({
      id: "1AbCdEfGhIjKlMnOpQrStUv",
      gid: "123",
    });
    expect(sheetIdOf("https://evil.example/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUv")).toBeNull();
  });
});

describe("import columns in the words people really use", () => {
  it("reads Cyrillic Uzbek, Russian and decorated titles", () => {
    const { fields } = mapColumns([
      "№",
      "ким ",
      "Telefon",
      "жарайонда",
      "Ф.И.О.",
      "Номер телефона",
      "Tel. raqami",
      "Kompaniya nomi",
    ]);
    expect(fields.get("name")).toBe(1);
    expect(fields.get("phone")).toBe(2);
    expect(fields.get("company")).toBe(7);
    expect(mapColumns(["Mijoz F.I.Sh", "Tel. raqami", "Eslatma"]).mapped.map((m) => m.field)).toEqual([
      "name",
      "phone",
      "note",
    ]);
    expect(mapColumns(["Ф.И.О.", "Номер телефона", "Источник"]).mapped.map((m) => m.field)).toEqual([
      "name",
      "phone",
      "source",
    ]);
  });

  it("does not take a column for a phone because its title starts with the same letters", () => {
    expect(mapColumns(["Telegram", "Ism"]).fields.has("phone")).toBe(false);
    // A title that could be two fields is the first of the two: the customer's phone, the company's name.
    expect(mapColumns(["Mijoz telefoni"]).mapped[0]?.field).toBe("phone");
    expect(mapColumns(["Company name"]).mapped[0]?.field).toBe("company");
  });

  it("takes an untitled column with data for the notes, and ignores an empty one", () => {
    const body = [
      ["a", "1", "", "tel olmadi"],
      ["b", "2", "", ""],
    ];
    const withNotes = mapColumns(["Ism", "Telefon", "", ""], body);
    expect(withNotes.fields.get("note")).toBe(3);
    // The header can be shorter than the rows under it.
    expect(mapColumns(["Ism", "Telefon"], [["a", "1", "", "x"]]).fields.get("note")).toBe(3);
    expect(mapColumns(["Ism", "Telefon", ""], [["a", "1", ""]]).fields.has("note")).toBe(false);
  });

  it("finds the header below an empty row or a title", () => {
    const rows = [[], ["Mijozlar 2026"], [], ["№", "Ism", "Telefon"], ["1", "Ali", "901234567"]];
    const { index, columns } = findHeader(rows);
    expect(index).toBe(3);
    expect(columns.fields.get("phone")).toBe(2);
    // Nothing with a phone: the first row with anything in it is the one reported.
    expect(findHeader([[], ["Ism", "Yosh"], ["Ali", "30"]]).index).toBe(1);
  });
});

describe("phones in a cell", () => {
  it("takes the first valid one of several, and drops the marks a spreadsheet leaves", () => {
    expect(firstPhone("90 123 45 67, 91 222 33 44")?.key).toBe("998901234567");
    expect(firstPhone("abc; 71 200 10 10")?.key).toBe("998712001010");
    expect(firstPhone("'901234567")?.key).toBe("998901234567");
    expect(firstPhone("\u00a0+998 90 123 45 67\u00a0")?.key).toBe("998901234567");
    expect(firstPhone("no number here")).toBeNull();
  });
});

describe("CSV", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("reads the delimiter Excel here writes (;), quotes, line breaks inside quotes and a byte-order mark", () => {
    const rows = readCsv(
      bytes('\uFEFFIsm;Telefon;Izoh\r\nAli;901234567;"a; b ""c"""\r\n"Va\nli";902222222;\r\n'),
    );
    expect(rows).toEqual([
      ["Ism", "Telefon", "Izoh"],
      ["Ali", "901234567", 'a; b "c"'],
      ["Va\nli", "902222222", ""],
    ]);
  });

  it("detects commas and tabs", () => {
    expect(readCsv(bytes("Ism,Telefon\nAli,901234567"))[1]).toEqual(["Ali", "901234567"]);
    expect(readCsv(bytes("Ism\tTelefon\nAli\t901234567"))[1]).toEqual(["Ali", "901234567"]);
  });

  it("reads Windows-1251 (Russian Excel) when the file is not UTF-8", () => {
    const cp1251 = Uint8Array.from([0xd0, 0xe0, 0xe1, 0xee, 0xf2, 0xe0, 0x3b, 0x39, 0x30, 0x31]); // "Работа;901"
    expect(readCsv(cp1251)).toEqual([["Работа", "901"]]);
  });
});

describe("sheet files", () => {
  it("tells a person with an old .xls how to save it, and reads CSV by its content", () => {
    const ole = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(() => readSheetFile(ole)).toThrow(/\.xls/);
    expect(readSheetFile(new TextEncoder().encode("Ism;Telefon\nAli;901234567"))).toHaveLength(2);
    expect(readSheetFile(writeXlsx([{ name: "A", rows: [["x"], ["1"]] }]))).toEqual([["x"], ["1"]]);
  });
});
