import { describe, expect, it } from "vitest";

import { lagOf, periodBefore, periodOfPurpose, taxKindOf, taxNameIs, taxPeriodFor, usualLag } from "./tax.js";

describe("taxKindOf", () => {
  it("names the tax a purpose is for", () => {
    expect(taxKindOf("Ижтимоий солиқ тўлови")).toBe("social");
    expect(taxKindOf("Социальный налог за сентябрь 2026")).toBe("social");
    expect(taxKindOf("НДФЛ за август")).toBe("ndfl");
    expect(taxKindOf("ЖШДС")).toBe("ndfl");
    expect(taxKindOf("ИНПС за сентябрь")).toBe("inps");
    expect(taxKindOf("Налог на добавленную стоимость")).toBe("vat");
    expect(taxKindOf("Налог на прибыль")).toBe("profit");
    expect(taxKindOf("Налог на имущество")).toBe("property");
  });

  it("leaves a purpose that names two taxes, or none, to the model", () => {
    expect(taxKindOf("НДФЛ и социальный налог")).toBeNull();
    expect(taxKindOf("Оплата за товар")).toBeNull();
  });

  it("knows a tax by its name in 1C", () => {
    expect(taxNameIs("ndfl", "Налог на доходы физических лиц")).toBe(true);
    expect(taxNameIs("social", "Единый социальный платеж")).toBe(true);
    expect(taxNameIs("vat", "Налог на добавленную стоимость")).toBe(true);
    expect(taxNameIs("vat", "Налог на прибыль")).toBe(false);
  });
});

describe("periodOfPurpose", () => {
  it("reads the month a purpose names", () => {
    expect(periodOfPurpose("Социальный налог за сентябрь 2026", "2026-10-19")).toBe("2026-09");
    expect(periodOfPurpose("НДФЛ за 09.2026", "2026-10-19")).toBe("2026-09");
    expect(periodOfPurpose("Август 2026 г. налог", "2026-10-19")).toBe("2026-08");
  });

  it("puts a month with no year in the latest one not after the payment", () => {
    expect(periodOfPurpose("НДФЛ за декабрь", "2026-01-15")).toBe("2025-12");
    expect(periodOfPurpose("НДФЛ за сентябрь", "2026-10-15")).toBe("2026-09");
  });

  it("does not take a date or a month in another sense for a period", () => {
    expect(periodOfPurpose("Налог по договору от 12.10.2026", "2026-10-19")).toBe("");
    expect(periodOfPurpose("Оплата по договору от 15 марта", "2026-10-19")).toBe("");
  });
});

describe("the company's habit", () => {
  const history = [
    { date: "2026-07-13", period: "2026-06-01T00:00:00" },
    { date: "2026-06-12", period: "2026-05-01T00:00:00" },
    { date: "2026-01-22", period: "2025-12-01T00:00:00" },
    { date: "2026-03-10", period: "2026-03-01T00:00:00" },
  ];

  it("takes the usual lag in months between a payment and its period", () => {
    expect(lagOf("2026-07-13", "2026-06-01")).toBe(1);
    expect(usualLag(history)).toBe(1);
  });

  it("learns nothing from no history, and ignores a period after the payment", () => {
    expect(usualLag([])).toBeNull();
    expect(usualLag([{ date: "2026-01-01", period: "2026-03-01" }])).toBeNull();
  });

  it("sets the period the month before the payment by that habit", () => {
    expect(periodBefore("2026-10-19", 1)).toBe("2026-09-01T00:00:00");
    expect(periodBefore("2026-01-05", 1)).toBe("2025-12-01T00:00:00");
    expect(taxPeriodFor("Социальный налог", "2026-10-19", history)).toEqual({
      value: "2026-09-01T00:00:00",
      source: "habit",
      lag: 1,
    });
  });

  it("prefers the period the purpose names, and gives none when nothing says it", () => {
    expect(taxPeriodFor("НДФЛ за август 2026", "2026-10-19", history)).toEqual({
      value: "2026-08-01T00:00:00",
      source: "purpose",
    });
    expect(taxPeriodFor("НДФЛ", "2026-10-19", [])).toBeNull();
  });
});
