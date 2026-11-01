import { describe, expect, it } from "vitest";

import { leadsWorkbook, reportWorkbook } from "./export.js";
import { sheetIdOf } from "./google-sheets.js";
import { mapColumns } from "./import.js";
import { normalizePhone } from "./phone.js";
import { readXlsx, writeXlsx } from "./xlsx.js";

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
