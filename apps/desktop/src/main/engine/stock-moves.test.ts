import { describe, expect, it } from "vitest";

import { buildMovement, planMovement } from "./stock-moves.js";

const stock = [
  { item: "Rice 25 kg", warehouse: "Main", qty: 40, amount: 4000 },
  { item: "Rice 50 kg", warehouse: "Main", qty: 10, amount: 2000 },
  { item: "Oil", warehouse: "Main", qty: 5, amount: 500 },
  { item: "Oil", warehouse: "Branch", qty: 3, amount: 330 },
];

describe("planning a movement", () => {
  it("takes what the warehouse holds and prices the lines at its average cost", () => {
    const p = planMovement("transfer", [{ item: "oil", qty: 2 }], stock, { from: "Main", to: "Branch" });
    expect(p).toEqual({ ok: true, lines: [{ item: "Oil", qty: 2, available: 5, cost: 200 }], problems: [] });
  });

  it("never takes the stock below zero, and says which line does", () => {
    const p = planMovement(
      "transfer",
      [
        { item: "Oil", qty: 4 },
        { item: "Oil", qty: 3 },
      ],
      stock,
      { from: "Main", to: "Branch" },
    );
    expect(p.ok).toBe(false);
    expect(p.problems[0]).toContain("7 asked, 5 in «Main»");
  });

  it("refuses an item the warehouse does not hold, a name that fits several, and a wrong quantity", () => {
    const p = planMovement(
      "transfer",
      [
        { item: "Salt", qty: 1 },
        { item: "Rice", qty: 1 },
        { item: "Oil", qty: 0 },
      ],
      stock,
      { from: "Main", to: "Branch" },
    );
    expect(p.problems).toEqual([
      "Salt: not in «Main».",
      "Rice: more than one item has this name; give the exact one.",
      "Oil: the quantity must be positive.",
    ]);
  });

  it("a transfer needs a different warehouse, a write-off needs its reason", () => {
    expect(
      planMovement("transfer", [{ item: "Oil", qty: 1 }], stock, { from: "Main" }).problems[0],
    ).toContain("needs the warehouse");
    expect(
      planMovement("transfer", [{ item: "Oil", qty: 1 }], stock, { from: "Main", to: "main" }).problems[0],
    ).toContain("same");
    expect(
      planMovement("write_off", [{ item: "Oil", qty: 1 }], stock, { from: "Main" }).problems[0],
    ).toContain("reason");
    expect(planMovement("write_off", [{ item: "Oil", qty: 1 }], stock, { from: "Main" }, "damaged").ok).toBe(
      true,
    );
  });
});

describe("building the document from its description", () => {
  const ref = (name: string) => ({ type: "Справочник.X", ref: name });
  const described = {
    attributes: [
      { name: "Организация" },
      { name: "СкладОтправитель" },
      { name: "СкладПолучатель" },
      { name: "Комментарий" },
    ],
    tabularSections: [{ name: "Товары", attributes: [{ name: "Номенклатура" }, { name: "Количество" }] }],
  };
  const data = {
    date: "2026-10-22",
    organization: ref("org"),
    from: ref("main"),
    to: ref("branch"),
    comment: "restock",
    lines: [{ item: ref("oil"), qty: 2 }],
  };

  it("fills the fields the base names", () => {
    const r = buildMovement("transfer", described, data);
    expect(r).toEqual({
      ok: true,
      movement: {
        object: "Документ.ПеремещениеТоваров",
        fields: {
          Дата: "2026-10-22",
          Организация: ref("org"),
          СкладОтправитель: ref("main"),
          СкладПолучатель: ref("branch"),
          Комментарий: "restock",
        },
        tables: { Товары: [{ Номенклатура: ref("oil"), Количество: 2 }] },
      },
    });
  });

  it("says what is missing, with the names the object does have", () => {
    const r = buildMovement(
      "transfer",
      { attributes: [{ name: "Организация" }, { name: "Откуда" }], tabularSections: [] },
      data,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.message).toContain(
      "no field for: sending warehouse, receiving warehouse, the goods table",
    );
    expect(r.ok ? "" : r.message).toContain("Организация, Откуда");
  });

  it("a write-off has one warehouse", () => {
    const r = buildMovement(
      "write_off",
      {
        attributes: [{ name: "Организация" }, { name: "Склад" }],
        tabularSections: described.tabularSections,
      },
      { ...data, to: undefined },
    );
    expect(r.ok && r.movement.fields).toMatchObject({ Склад: ref("main") });
    expect(r.ok && r.movement.object).toBe("Документ.СписаниеТоваров");
  });
});
