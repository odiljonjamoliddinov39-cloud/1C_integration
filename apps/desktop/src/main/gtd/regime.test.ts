import { describe, expect, it } from "vitest";

import { declarationKey, detectRegime, parseRegimeText, procedureCode } from "./regime.js";

const none = () => false;

describe("graph 1", () => {
  it.each([
    ["IM 74", "IM", "74"],
    ["IM74", "IM", "74"],
    ["ИМ-40", "IM", "40"],
    ["im 40 / 00", "IM", "40"],
    ["ЭК 10", "EX", "10"],
  ])("%s", (text, type, code) => expect(parseRegimeText(text)).toEqual({ type, code }));
  it.each(["", null, undefined, "import", "IM"])("%s is not a regime", (text) =>
    expect(parseRegimeText(text)).toBeNull(),
  );
  it("graph 37 gives the first two digits", () => {
    expect(procedureCode("74 00 (000 extra)")).toBe("74");
    expect(procedureCode("7400")).toBe("74");
    expect(procedureCode("7")).toBeNull();
    expect(procedureCode(null)).toBeNull();
  });
  it("graph 40 is a declaration number written with or without spaces", () => {
    expect(declarationKey("27001 / 02.11.2025 / 0160321")).toBe("27001/02.11.2025/0160321");
    expect(declarationKey("some storage document")).toBeNull();
  });
});

describe("the regime of a declaration", () => {
  it("IM 74 is a customs warehouse", () => {
    expect(
      detectRegime({
        text: "IM 74",
        procedures: ["74 00"],
        preceding: "27001/02.11.2025/0160321",
        warehouse: none,
      }),
    ).toEqual({
      type: "IM",
      code: "74",
      kind: "customs_warehouse",
    });
  });
  it("IM 40 is a release for consumption", () => {
    expect(
      detectRegime({ text: "IM 40", procedures: ["40 00"], preceding: null, warehouse: none }).kind,
    ).toBe("release_for_consumption");
  });
  it("IM 40 whose graph 40 names a warehouse declaration the company has read is the release from that warehouse", () => {
    const known = (no: string) => no === "26003/04.11.2025/0090704";
    expect(
      detectRegime({
        text: "IM 40",
        procedures: ["40 00"],
        preceding: "26003 / 04.11.2025 / 0090704",
        warehouse: known,
      }).kind,
    ).toBe("release_from_warehouse");
    expect(
      detectRegime({
        text: "IM 40",
        procedures: ["40 00"],
        preceding: "27001/02.11.2025/0160321",
        warehouse: known,
      }).kind,
    ).toBe("release_for_consumption");
  });
  it("a code outside 40 and 74 stops the flow and says why", () => {
    const r = detectRegime({ text: "IM 51", procedures: ["51 00"], preceding: null, warehouse: none });
    expect(r.kind).toBe("unsupported");
    expect(r.reason).toMatch(/temporary import/);
    expect(detectRegime({ text: "IM 99", procedures: [], preceding: null, warehouse: none }).kind).toBe(
      "unsupported",
    );
  });
  it("an export is not handled", () => {
    expect(detectRegime({ text: "EX 10", procedures: [], preceding: null, warehouse: none }).kind).toBe(
      "unsupported",
    );
  });
  it("graph 37 decides when graph 1 cannot be read, if every item says the same", () => {
    expect(
      detectRegime({ text: null, procedures: ["74 00", "74 00"], preceding: null, warehouse: none }).kind,
    ).toBe("customs_warehouse");
    expect(
      detectRegime({ text: null, procedures: ["74 00", "40 00"], preceding: null, warehouse: none }).kind,
    ).toBe("unsupported");
    expect(detectRegime({ text: null, procedures: [], preceding: null, warehouse: none }).kind).toBe(
      "unsupported",
    );
  });
});
