import { describe, expect, it } from "vitest";

import { isAcquiringFee, parseAcquiring } from "./acquiring.js";

const purpose =
  "00634SmartVista - Выручка CRYSTAL WATER TRADE 483,610.84 сум с 12.10.2026 по 12.10.2026 ( TID 30061802) от сумма: 484,580.00 в том числе комиссия (0.2%) 969.16";

describe("acquiring receipts", () => {
  it("reads the gross and the commission when they add up to the net", () => {
    expect(parseAcquiring(purpose, 48_361_084)).toEqual({
      gross: 48_458_000,
      commission: 96_916,
      terminal: "30061802",
    });
    // Another wording of the commission, a card scheme in brackets.
    expect(
      parseAcquiring(
        "00634SmartVista - Выручка CRYSTAL WATER TRADE 741,510.00 сум с 13.10.2026 по 13.10.2026 ( TID 30071361) от сумма: 749,000.00(VISA) в том числе комиссия (Surcharge+MechantFee) 7,490.00",
        74_151_000,
      ),
    ).toEqual({ gross: 74_900_000, commission: 749_000, terminal: "30071361" });
  });

  it("does not split what does not add up, or what is not an acquiring receipt", () => {
    expect(parseAcquiring(purpose, 48_361_085 + 100)).toBeNull();
    expect(parseAcquiring("Оплата по договору 17", 100_000)).toBeNull();
    expect(parseAcquiring("от сумма: 100 комиссия 5", 100)).toBeNull();
  });

  it("tells an acquiring bank-fee document from an ordinary one", () => {
    expect(isAcquiringFee("Комиссия эквайринга SmartVista 0.2% за 12.10.2026")).toBe(true);
    expect(isAcquiringFee("комиссия по терминалу 30061802")).toBe(true);
    expect(isAcquiringFee("00667 BC 13.10.2026 погашение Дебетовый оборот (внеш) -17262.50")).toBe(false);
    expect(isAcquiringFee("оплата за товары")).toBe(false);
  });
});
