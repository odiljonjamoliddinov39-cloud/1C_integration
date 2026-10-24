import { describe, expect, it } from "vitest";

import { ownAccountAttribute, ownAccountKey, ownAccountOf } from "./roles.js";

const account = (ref = "r") => ({ type: "Справочник.БанковскиеСчета", ref, name: "20208…" });

describe("the attribute that holds the company's own bank account", () => {
  it("is found by the usual names of two configurations", () => {
    expect(ownAccountKey({ БанковскийСчет: account(), Контрагент: null })).toBe("БанковскийСчет");
    expect(ownAccountKey({ СчетОрганизации: account(), Контрагент: null })).toBe("СчетОрганизации");
  });

  it("is found by the type when the name is one nobody expected, and never the counterparty's", () => {
    expect(ownAccountKey({ РасчетныйСчетФирмы: account(), СчетКонтрагента: account() })).toBe(
      "РасчетныйСчетФирмы",
    );
    expect(ownAccountKey({ СчетКонтрагента: account(), СчетПолучатель: account() })).toBeNull();
  });

  it("is read from 1C's description of the object", () => {
    const attributes = [
      { name: "СчетОрганизации", types: ["Справочник.БанковскиеСчета"] },
      { name: "СчетПолучатель", types: ["Справочник.БанковскиеСчета"] },
      { name: "Контрагент", types: ["Справочник.Контрагенты"] },
    ];
    expect(ownAccountOf(attributes)).toBe("СчетОрганизации");
    // two accounts and no usual name: the one of the organization
    expect(
      ownAccountOf([
        { name: "СчетОтправителя", types: ["Справочник.БанковскиеСчета"] },
        { name: "СчетОрганизации", types: ["Справочник.БанковскиеСчета"] },
      ]),
    ).toBe("СчетОрганизации");
    expect(ownAccountOf([{ name: "Контрагент", types: [] }])).toBeNull();
  });

  it("is asked of 1C once per object, and falls back to the usual name when 1C cannot describe it", async () => {
    let asked = 0;
    const deps = {
      describe: async () => {
        asked += 1;
        return {
          ok: true as const,
          data: [{ attributes: [{ name: "СчетОрганизации", types: ["Справочник.БанковскиеСчета"] }] }],
        };
      },
    };
    const cache: { roles?: Map<string, string> } = {};
    expect(await ownAccountAttribute(deps, cache, "Документ.СписаниеСРасчетногоСчета")).toBe(
      "СчетОрганизации",
    );
    expect(await ownAccountAttribute(deps, cache, "Документ.СписаниеСРасчетногоСчета")).toBe(
      "СчетОрганизации",
    );
    expect(asked).toBe(1);
    const blind = { describe: async () => ({ ok: false as const, code: "X", message: "no" }) };
    expect(await ownAccountAttribute(blind, {}, "Документ.Любой")).toBe("БанковскийСчет");
  });
});
