import { describe, expect, it } from "vitest";
import readXlsxFile from "read-excel-file/node";

import { readZip } from "../zip.js";
import { makeXlsx } from "./xlsx.js";

describe("makeXlsx", () => {
  it("makes a file Excel's readers open, with text and numbers kept", async () => {
    const bytes = makeXlsx("Balance", [["Assets & <more>", 1200.5], ["Кредит", null], [""]]);
    expect(readZip(bytes).map((e) => e.name)).toContain("xl/worksheets/sheet1.xml");
    const [sheet] = await readXlsxFile(Buffer.from(bytes));
    const rows = sheet?.data ?? [];
    expect(rows[0]).toEqual(["Assets & <more>", 1200.5]);
    expect(rows[1]?.[0]).toBe("Кредит");
  });
});
