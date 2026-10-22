import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROFILE,
  type TaxBenefit,
  type TaxRate,
  benefitApplies,
  rateOn,
  rateWithBenefits,
  unapproved,
  vatOn,
} from "./tax-tables.js";

describe("rates by date", () => {
  it("gives the VAT rate in force on the day, from the table", () => {
    expect(rateOn("vat", "2018-06-01")?.rate).toBe(20);
    expect(rateOn("vat", "2022-12-31")?.rate).toBe(15);
    expect(rateOn("vat", "2023-01-01")?.rate).toBe(12);
    expect(rateOn("vat", "2026-10-22")?.rate).toBe(12);
  });

  it("an activity's row beats the general one", () => {
    expect(rateOn("profit", "2026-01-01")?.rate).toBe(15);
    expect(rateOn("profit", "2026-01-01", "bank")?.rate).toBe(20);
    expect(rateOn("profit", "2026-01-01", "trade")?.rate).toBe(15);
  });

  it("says nothing rather than guess when the table has no row", () => {
    expect(rateOn("turnover", "2026-01-01")).toBeNull();
    expect(rateOn("profit", "2010-01-01")).toBeNull();
  });

  it("every seeded row waits for the adviser's approval and the answer says so", () => {
    expect(rateOn("vat", "2026-01-01")?.approved).toBe(false);
    expect(unapproved().length).toBeGreaterThan(5);
  });
});

describe("VAT", () => {
  it("works out the VAT of a net and of a gross amount, at the rate of the date", () => {
    expect(vatOn(1000, "exclusive", "2026-03-01", DEFAULT_PROFILE)).toMatchObject({
      rate: 12,
      net: 1000,
      vat: 120,
      gross: 1120,
    });
    expect(vatOn(1120, "inclusive", "2026-03-01", DEFAULT_PROFILE)).toMatchObject({
      net: 1000,
      vat: 120,
      gross: 1120,
    });
    expect(vatOn(1150, "exclusive", "2022-03-01", DEFAULT_PROFILE)).toMatchObject({ rate: 15, vat: 172.5 });
  });

  it("is zero for a company that is not a payer (or not yet), and for exempt and zero-rated supplies", () => {
    const not = { ...DEFAULT_PROFILE, vatPayer: false };
    expect(vatOn(1000, "exclusive", "2026-03-01", not)).toMatchObject({ vat: 0, gross: 1000 });
    const later = { ...DEFAULT_PROFILE, vatFrom: "2026-07-01" };
    expect(vatOn(1000, "exclusive", "2026-03-01", later)).toMatchObject({ vat: 0 });
    expect(vatOn(1000, "exclusive", "2026-08-01", later)).toMatchObject({ vat: 120 });
    expect(vatOn(1000, "exclusive", "2026-03-01", DEFAULT_PROFILE, { exempt: true })).toMatchObject({
      vat: 0,
    });
    expect(vatOn(1000, "exclusive", "2026-03-01", DEFAULT_PROFILE, { zeroRated: true })).toMatchObject({
      vat: 0,
    });
  });

  it("asks for the table to be filled when the date has no rate", () => {
    expect(vatOn(1000, "exclusive", "1890-01-01", DEFAULT_PROFILE)).toEqual({
      error: expect.stringContaining("not in the tax table"),
    });
  });
});

describe("benefits", () => {
  const benefit: TaxBenefit = {
    code: "IT-PARK",
    type: "profit",
    conditions: { resident: true },
    effect: { kind: "zero" },
    from: "2026-01-01",
    to: "2030-12-31",
    source: "test",
    approved: true,
  };
  const rates: TaxRate[] = [{ type: "profit", rate: 15, from: "2020-01-01", source: "test", approved: true }];

  it("applies only while its conditions and dates hold", () => {
    expect(benefitApplies(benefit, { resident: true }, "2027-01-01")).toBe(true);
    expect(benefitApplies(benefit, { resident: false }, "2027-01-01")).toBe(false);
    expect(benefitApplies(benefit, { resident: true }, "2031-01-01")).toBe(false);
  });

  it("lowers the rate of a company that holds it, and names it", () => {
    const profile = { ...DEFAULT_PROFILE, benefits: [{ code: "IT-PARK", basis: "certificate 1" }] };
    const got = rateWithBenefits(
      "profit",
      "2027-01-01",
      profile,
      { resident: true },
      { rates, benefits: [benefit] },
    );
    expect(got).toMatchObject({ rate: 0, benefit: "IT-PARK" });
    const without = rateWithBenefits(
      "profit",
      "2027-01-01",
      DEFAULT_PROFILE,
      { resident: true },
      { rates, benefits: [benefit] },
    );
    expect(without?.rate).toBe(15);
    const expired = { ...DEFAULT_PROFILE, benefits: [{ code: "IT-PARK", basis: "c", until: "2026-12-31" }] };
    expect(
      rateWithBenefits("profit", "2027-01-01", expired, { resident: true }, { rates, benefits: [benefit] })
        ?.rate,
    ).toBe(15);
  });
});
