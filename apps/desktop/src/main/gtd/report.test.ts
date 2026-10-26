import { describe, expect, it } from "vitest";

import { OWN_INN, sampleInput, samplePages } from "./fixture.js";
import { readPages } from "./pages.js";
import { gtdReport } from "./report.js";
import { readDeclaration } from "./run.js";

const deps = {
  query: async (input: { query: string }) => ({
    ok: true as const,
    data: {
      rows: input.query.includes("ДоговорыКонтрагентов")
        ? [["SC20250919", "2025-09-19T00:00:00", "SICHUAN SPARK TRADING CO.LTD"]]
        : [],
    },
  }),
};
const run = (input = sampleInput(), inn = OWN_INN) =>
  readDeclaration(input, {
    deps,
    companyInn: inn,
    registry: [],
    pages: readPages(samplePages()),
    today: "2026-10-26",
  });

describe("the report the accountant reads", () => {
  it("a proposal: the header, the checks, the warnings, the entries with their status, and the open decisions", async () => {
    const text = gtdReport(await run());
    expect(text).toMatch(
      /^GTD 26003\/04\.11\.2025\/0090704 of 2025-11-04: regime IM 74 \(customs warehouse\), 32 items\./,
    );
    expect(text).toContain("invoice SC20250919 USD 25000.00 at 11972.34 = customs value 299308500.00 UZS");
    expect(text).toContain("Checks V1–V12: all passed");
    expect(text).toContain("W2: used goods");
    // The accounts are open (the base has no example): the spec's 2910 is named as an expectation, not used.
    expect(text).toMatch(
      /Dt \? \(cost of the goods; the spec expects 2910, not used without a posted example\)/,
    );
    expect(text).toContain("needs the accountant to name the open account");
    expect(text).toContain("4. IM 74: import VAT and duty, 0.00 UZS — no posting: deferred");
    expect(text).toContain("Open decisions for the accountant:");
    expect(text).toContain("1030000.00 UZS is shared over the items by value");
  });

  it("a failed rule: the message with the two numbers", async () => {
    const input = sampleInput();
    const slipped = {
      ...input,
      items: input.items.map((i) => (i.no === 13 ? { ...i, value: "1147.00" } : i)),
    };
    const text = gtdReport(await run(slipped));
    expect(text).toMatch(
      /V3 sum_item_values_equals_invoice: the items add up to 24973\.00 but the invoice is 25000\.00/,
    );
    expect(text).toContain("expected 25000.00, read 24973.00");
    expect(text).toContain("Read sheet");
  });

  it("an unsupported regime: the question only", async () => {
    const text = gtdReport(await run(sampleInput({ regime: "IM 31" })));
    expect(text).toMatch(/^Regime IM 31: regime IM 31 \(re-export\) is not handled/);
  });

  it("another company's declaration shows nothing of it", async () => {
    const text = gtdReport(await run(sampleInput(), "200000001"));
    expect(text).toContain("another company's");
    expect(text).not.toContain("SICHUAN");
  });
});
