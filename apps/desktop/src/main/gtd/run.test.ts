import type { RunQueryInput } from "@platform/shared";
import { describe, expect, it } from "vitest";

import { BASE, DECLARATION_NO, OWN_INN, SAMPLE_ITEMS, sampleInput, samplePages } from "./fixture.js";
import { type DeclarationPages, readPages } from "./pages.js";
import { type GtdOutcome, type GtdRunContext, readDeclaration } from "./run.js";
import type { GtdRecord } from "./registry.js";

/** A 1C that answers the contract query and the register query from the test base. */
function world(over: { contract?: unknown[][]; entries?: unknown[][]; down?: boolean } = {}) {
  const calls: string[] = [];
  const deps = {
    query: async (input: RunQueryInput) => {
      calls.push(input.query);
      if (over.down) return { ok: false as const, code: "ONEC", message: "down" };
      if (input.query.includes("Справочник.ДоговорыКонтрагентов"))
        return { ok: true as const, data: { rows: over.contract ?? BASE.contract } };
      return { ok: true as const, data: { rows: over.entries ?? BASE.entries } };
    },
  };
  return { deps, calls };
}

function context(
  over: Partial<GtdRunContext> = {},
  pages: DeclarationPages | null = readPages(samplePages()),
): GtdRunContext {
  return {
    deps: world().deps,
    companyInn: OWN_INN,
    registry: [],
    pages,
    today: "2026-10-26",
    ...over,
  };
}

const proposal = (o: GtdOutcome) => {
  if (o.status !== "proposal")
    throw new Error(`not a proposal: ${o.status} ${JSON.stringify("message" in o ? o.message : o)}`);
  return o;
};

describe("acceptance 1 — the happy path", () => {
  it("parses to the 32 items of the table and the JSON of §5; V1–V12 pass; the regime is a customs warehouse", async () => {
    const outcome = proposal(await readDeclaration(sampleInput(), context()));
    expect(outcome.checks).toHaveLength(12);
    expect(outcome.checks.every((c) => c.ok)).toBe(true);
    expect(outcome.checks.map((c) => c.id)).toEqual([
      "V1",
      "V2",
      "V3",
      "V4",
      "V5",
      "V6",
      "V7",
      "V8",
      "V9",
      "V10",
      "V11",
      "V12",
    ]);
    const json = outcome.declaration as {
      declaration_no: string;
      date: string;
      regime: { type: string; code: string; kind: string };
      customs_value_uzs: string;
      fx_rate: string;
      warehouse: { licence: string; release_deadline: string };
      items: {
        no: number;
        hs: string;
        name_en: string;
        name_ru: string;
        net_kg: string;
        value: string;
        condition: string;
      }[];
      checks: { rule: string; ok: boolean }[];
    };
    expect(json.declaration_no).toBe(DECLARATION_NO);
    expect(json.date).toBe("2025-11-04");
    expect(json.regime).toEqual({ type: "IM", code: "74", kind: "customs_warehouse" });
    expect(json.customs_value_uzs).toBe("299308500.00");
    expect(json.fx_rate).toBe("11972.34");
    expect(json.warehouse).toMatchObject({ licence: "1701/0159", release_deadline: "2028-11-03" });
    expect(json.items).toHaveLength(32);
    for (const [no, hs, name, net, value] of SAMPLE_ITEMS) {
      const item = json.items[no - 1];
      expect(item).toMatchObject({ no, hs, net_kg: net, value });
      // The names are the text layer's (English split from Russian), never the model's.
      expect(item?.name_en).toBe(no === 29 || no === 30 ? `${name} (Used)` : name);
    }
    expect(json.items[0]?.name_ru).toBe("Оборудование для предварительного нагрева");
    expect(json.items.filter((i) => i.condition === "used").map((i) => i.no)).toEqual([29, 30]);
    expect(json.checks).toContainEqual({ rule: "sum_item_values_equals_invoice", ok: true });
  });

  it("the warnings of the sample: W1 (items 9–11 and 18), W2 (29, 30), W3 (repeated descriptions)", async () => {
    const outcome = proposal(await readDeclaration(sampleInput(), context()));
    const w = (id: string) => outcome.warnings.find((x) => x.id === id);
    expect(w("W1")?.items).toEqual(expect.arrayContaining([9, 10, 11, 18, 1]));
    expect(w("W1")?.items).not.toContain(7);
    expect(w("W1")?.message).toMatch(/8001 is unwrought tin/);
    expect(w("W1")?.message).toMatch(/item 18: same description as item 1/);
    expect(w("W2")?.items).toEqual([29, 30]);
    expect(w("W2")?.message).toMatch(/separate nomenclature/);
    expect(w("W3")?.items).toEqual(expect.arrayContaining([16, 17, 19, 20, 22, 23, 24, 25, 26]));
    expect(w("W4")).toBeUndefined();
  });
});

describe("acceptance 2 — no VAT on IM 74", () => {
  it("the proposal for the sample is the fee posting only; step 4 is no posting", async () => {
    const { proposal: p } = proposal(await readDeclaration(sampleInput(), context()));
    expect(p.kind).toBe("customs_warehouse");
    expect(p.entries.map((e) => e.step)).toEqual([1, 2, 3, 4]);
    const none = p.entries.find((e) => e.step === 4);
    expect(none).toMatchObject({ status: "none", amount: "0.00", debit: null, credit: null });
    // Only step 4 mentions VAT and duty, to say that nothing is posted for them.
    expect(JSON.stringify(p.entries.filter((e) => e.step !== 4)).toLowerCase()).not.toMatch(/vat|duty|4410/);
    expect(p.entries.find((e) => e.step === 2)?.amount).toBe("1030000.00");
  });

  it("a VAT or duty line on an IM 74 declaration is left out of the proposal, and said", async () => {
    const input = sampleInput({
      charges: [
        {
          type: "10",
          base: "299308500",
          rate_text: "2.5 x 412000",
          amount: "1030000",
          payment_type: "BN",
          item_no: null,
        },
        {
          type: "50",
          base: "299308500",
          rate_text: "12%",
          amount: "35917020",
          payment_type: "BN",
          item_no: null,
        },
        {
          type: "20",
          base: "299308500",
          rate_text: "5%",
          amount: "14965425",
          payment_type: "BN",
          item_no: null,
        },
      ],
    });
    const { proposal: p } = proposal(await readDeclaration(input, context()));
    expect(p.excluded).toHaveLength(2);
    expect(p.entries.find((e) => e.step === 2)?.amount).toBe("1030000.00");
    expect(JSON.stringify(p.entries)).not.toMatch(/35917020|14965425/);
  });
});

describe("acceptance 3 — allocation of the fee", () => {
  it("the 32 shares add up to exactly 1,030,000.00; item 1 gets 376,568.00 and item 2 94,760.00", async () => {
    const { proposal: p } = proposal(await readDeclaration(sampleInput(), context()));
    const step = p.entries.find((e) => e.step === 2);
    expect(step?.perItem).toHaveLength(32);
    expect(step?.perItem?.[0]).toEqual({ no: 1, amount: "376568.00" });
    expect(step?.perItem?.[1]).toEqual({ no: 2, amount: "94760.00" });
    const cents = (step?.perItem ?? []).reduce((total, s) => total + BigInt(s.amount.replace(".", "")), 0n);
    expect(cents).toBe(103_000_000n);
    expect(p.fee).toEqual({ total: "1030000.00", allocated: "1030000.00" });
  });
});

describe("acceptance 4 — an OCR slip", () => {
  it("item 13 read as 1,147 instead of 1,174: V3 fails and names the difference of 27; the sheet is asked for again, once", async () => {
    const input = sampleInput();
    const slipped = {
      ...input,
      items: input.items.map((i) =>
        i.no === 13 ? { ...i, value: "1147.00", statistical_value: "1.147" } : i,
      ),
    };
    const first = await readDeclaration(slipped, context());
    expect(first.status).toBe("checks_failed");
    if (first.status !== "checks_failed") return;
    const v3 = first.checks.find((c) => c.id === "V3");
    expect(v3?.ok).toBe(false);
    expect(v3?.message).toMatch(/difference is 27\.00/);
    expect(v3?.expected).toBe("25000.00");
    expect(v3?.actual).toBe("24973.00");
    // Item 13 is on sheet 5 (sheet 1 has item 1, each TD-2 sheet three more).
    expect(first.reread).toContain(5);
    // The second reading is the last: a failure again goes to the accountant.
    const second = await readDeclaration({ ...slipped, retry: true }, context());
    expect(second.status).toBe("needs_user");
    expect(second.status === "needs_user" && second.message).toMatch(/Nothing is posted on a failed check/);
  });
});

describe("acceptance 5 — wrong company", () => {
  it("another INN: V8 fails before anything is shown, and nothing of the declaration comes back", async () => {
    const outcome = await readDeclaration(sampleInput(), context({ companyInn: "200000001" }));
    expect(outcome.status).toBe("needs_user");
    if (outcome.status !== "needs_user") return;
    expect(outcome.checks.map((c) => c.id)).toEqual(["V8"]);
    expect(outcome.message).toMatch(/another company's/);
    expect(JSON.stringify(outcome)).not.toMatch(/SICHUAN|1030000|8514400000/);
  });
});

describe("acceptance 6 — a missing sheet", () => {
  it("sheet 7 of 12 removed: V1 fails and names it; only the accountant can settle it", async () => {
    const outcome = await readDeclaration(sampleInput(), context({}, readPages(samplePages([7]))));
    expect(outcome.status).toBe("needs_user");
    if (outcome.status !== "needs_user") return;
    const v1 = outcome.checks.find((c) => c.id === "V1");
    expect(v1?.ok).toBe(false);
    expect(v1?.message).toMatch(/sheet 7 of 12 is missing/);
    expect(outcome.reread).toEqual([]);
  });
});

describe("acceptance 7 — an unsupported regime", () => {
  it("graph 1 outside 40 and 74 stops the flow with a question, before any amount", async () => {
    const outcome = await readDeclaration(sampleInput({ regime: "IM 51" }), context());
    expect(outcome.status).toBe("unsupported_regime");
    if (outcome.status !== "unsupported_regime") return;
    expect(outcome.regime).toMatchObject({ type: "IM", code: "51", kind: "unsupported" });
    expect(outcome.question).toMatch(/temporary import/);
    expect(JSON.stringify(outcome)).not.toMatch(/1030000|376568/);
  });
});

describe("the rules in detail", () => {
  const failing = async (over: Parameters<typeof sampleInput>[0], pages?: DeclarationPages | null) => {
    const outcome = await readDeclaration(
      sampleInput(over),
      context({}, pages === undefined ? readPages(samplePages()) : pages),
    );
    if (outcome.status === "proposal") throw new Error("should have failed");
    return outcome;
  };
  const rule = (o: GtdOutcome, id: string) => ("checks" in o ? o.checks.find((c) => c.id === id) : undefined);

  it("V2: graph 5 says 33 and 32 items were read", async () => {
    expect(rule(await failing({ items_declared: 33 }), "V2")?.message).toMatch(/graph 5 says 33/);
  });

  it("V2: a repeated item number and a gap are both named", async () => {
    const items = sampleInput()
      .items.filter((i) => i.no !== 4)
      .concat({ ...sampleInput().items[0]!, value: "0.00" });
    expect(rule(await failing({ items }), "V2")?.message).toMatch(/item 1 repeats.*item 4 is missing/);
  });

  it("V4: a wrong rate, and a missing rate (the central bank's is never used)", async () => {
    expect(rule(await failing({ fx_rate: "11927.34" }), "V4")?.message).toMatch(/299308500\.00/);
    const missing = await failing({ fx_rate: null });
    expect(rule(missing, "V4")?.message).toMatch(/central bank's rate is not used/);
    expect(missing.status).toBe("needs_user");
  });

  it("V5: an HS code of nine digits", async () => {
    const items = sampleInput().items.map((i) => (i.no === 3 ? { ...i, hs: "281810910" } : i));
    expect(rule(await failing({ items }), "V5")?.message).toMatch(/item 3 is not ten digits/);
  });

  it("V6: net above gross", async () => {
    const items = sampleInput().items.map((i) => (i.no === 2 ? { ...i, net_kg: "500", gross_kg: "450" } : i));
    expect(rule(await failing({ items }), "V6")?.message).toMatch(/item 2 \(net 500 > gross 450\)/);
  });

  it("V7: an item with another procedure", async () => {
    const items = sampleInput().items.map((i) => (i.no === 5 ? { ...i, procedure: "40 00" } : i));
    expect(rule(await failing({ items }), "V7")?.message).toMatch(/item 5/);
  });

  it("V9: the fee is the multiplier times the base value, and the base value is the one in force on the date", async () => {
    const wrongAmount = [
      {
        type: "10",
        base: "299308500",
        rate_text: "2.5 x 412000",
        amount: "1030100",
        payment_type: "BN",
        item_no: null,
      },
    ];
    expect(rule(await failing({ charges: wrongAmount }), "V9")?.message).toMatch(
      /2\.5 × 412000 = 1030000\.00 but the fee line says 1030100\.00/,
    );
    const wrongBase = [
      {
        type: "10",
        base: "299308500",
        rate_text: "2.5 x 375000",
        amount: "937500",
        payment_type: "BN",
        item_no: null,
      },
    ];
    expect(rule(await failing({ charges: wrongBase }), "V9")?.message).toMatch(
      /in force on 2025-11-04 is 412000/,
    );
  });

  it("V9: other spellings of the rate are read", async () => {
    for (const text of ["2.5 UZS (412000)", "2,5 × 412 000", "2.5 х 412000"]) {
      const charges = [
        {
          type: "10",
          base: "299308500",
          rate_text: text,
          amount: "1030000",
          payment_type: "BN",
          item_no: null,
        },
      ];
      const outcome = await readDeclaration(sampleInput({ charges }), context());
      expect(outcome.status, text).toBe("proposal");
    }
  });

  it("V9: no fee line on an IM 74 declaration fails", async () => {
    expect(rule(await failing({ charges: [] }), "V9")?.message).toMatch(/only charge/);
  });

  it("V10: a statistical value that is not the value over a thousand", async () => {
    const items = sampleInput().items.map((i) => (i.no === 1 ? { ...i, statistical_value: "91.40" } : i));
    expect(rule(await failing({ items }), "V10")?.message).toMatch(/item 1/);
  });

  it("V10 is skipped for an invoice not in USD", async () => {
    const outcome = await readDeclaration(
      sampleInput({ invoice: { no: "SC20250919", date: "2025-09-19", currency: "EUR", amount: "25000.00" } }),
      context(),
    );
    const v10 = "checks" in outcome ? outcome.checks.find((c) => c.id === "V10") : undefined;
    expect(v10).toMatchObject({ ok: true, skipped: true });
  });

  it("V11: the warehouse and its deadline", async () => {
    expect(
      rule(await failing({ warehouse: { licence: null, date: null, release_deadline: null } }), "V11")
        ?.message,
    ).toMatch(/graph 49.*graph 50/);
    expect(
      rule(
        await failing({
          warehouse: { licence: "1701/0159", date: "2020-01-25", release_deadline: "2024-11-03" },
        }),
        "V11",
      )?.message,
    ).toMatch(/not after the declaration date/);
  });

  it("V12: a contract 1C does not have, one under another supplier, and a 1C that cannot be asked", async () => {
    const none = await readDeclaration(sampleInput(), context({ deps: world({ contract: [] }).deps }));
    expect(none.status).toBe("needs_user");
    expect(rule(none, "V12")?.message).toMatch(/no contract SC20250919/);
    const other = await readDeclaration(
      sampleInput(),
      context({ deps: world({ contract: [["SC20250919", "2025-09-19T00:00:00", "ANOTHER LTD"]] }).deps }),
    );
    expect(rule(other, "V12")?.message).toMatch(/only under another counterparty \(ANOTHER LTD\)/);
    const down = await readDeclaration(sampleInput(), context({ deps: world({ down: true }).deps }));
    expect(rule(down, "V12")?.message).toMatch(/could not be asked/);
  });

  it("V12 accepts the number written with other punctuation", async () => {
    const outcome = await readDeclaration(
      sampleInput(),
      context({
        deps: world({ contract: [["SC-2025 0919", "2025-09-19T00:00:00", "Sichuan Spark Trading Co. Ltd"]] })
          .deps,
      }),
    );
    expect(outcome.status).toBe("proposal");
  });

  it("numbers that are not numbers are said, and fail the rule that needs them", async () => {
    const items = sampleInput().items.map((i) => (i.no === 13 ? { ...i, value: "11 7 4,00x" } : i));
    const outcome = await failing({ items });
    expect(rule(outcome, "V3")?.message).toMatch(/item 13 was not read/);
  });

  it("without a text layer the model's footers and names are used, and said", async () => {
    const items = sampleInput().items.map((i) => ({ ...i, name_en: `Thing ${i.no}`, name_ru: "Вещь" }));
    const outcome = proposal(
      await readDeclaration(
        sampleInput({ items, sheets_seen: { present: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], total: 12 } }),
        context({}, null),
      ),
    );
    const json = outcome.declaration as {
      items: { name_en: string; name_ru: string }[];
      declaration_no: string;
    };
    expect(json.items[0]).toMatchObject({ name_en: "Thing 1", name_ru: "Вещь" });
    // No footer: the number and the date are the model's reading of the form.
    expect(json.declaration_no).toBe(DECLARATION_NO);
    const noPages = await readDeclaration(sampleInput(), context({}, null));
    expect(rule(noPages, "V1")?.message).toMatch(/no footer/);
  });

  it("the footer wins over a misread header, and the conflict is said", async () => {
    const outcome = proposal(
      await readDeclaration(
        sampleInput({ declaration_no: "26003/04.11.2025/0090740", date: "2025-11-05" }),
        context(),
      ),
    );
    expect((outcome.declaration as { declaration_no: string }).declaration_no).toBe(DECLARATION_NO);
    expect(outcome.warnings.find((w) => w.id === "W5")?.message).toMatch(
      /the footer says 26003\/04\.11\.2025\/0090704, the form was read as 26003\/04\.11\.2025\/0090740/,
    );
  });
});

describe("the accounts of the postings come from the base, never from the spec", () => {
  it("customs payments and the supplier's receipts in the base fill the roles; the fee entry is ready", async () => {
    const { proposal: p, accountNotes } = proposal(await readDeclaration(sampleInput(), context()));
    const step2 = p.entries.find((e) => e.step === 2);
    expect(step2).toMatchObject({ status: "ready" });
    expect(step2?.debit).toMatchObject({ code: "2910", source: "base" });
    expect(step2?.credit).toMatchObject({ code: "4730", source: "base" });
    expect(p.entries.find((e) => e.step === 3)?.credit).toMatchObject({ code: "5110", source: "base" });
    expect(accountNotes).toEqual([]);
  });

  it("a base with no example leaves the accounts open: the entry needs confirming and the spec's 2910 is only a suggestion", async () => {
    const { proposal: p, accountNotes } = proposal(
      await readDeclaration(sampleInput(), context({ deps: world({ entries: [] }).deps })),
    );
    const step2 = p.entries.find((e) => e.step === 2);
    expect(step2?.status).toBe("confirm");
    expect(step2?.debit).toMatchObject({ code: null, suggested: "2910" });
    expect(step2?.credit?.code).toBeNull();
    expect(accountNotes.join(" ")).toMatch(/no posted payment to the customs/);
    expect(accountNotes.join(" ")).toMatch(/no earlier receipt from SICHUAN/);
  });

  it("a 1C that cannot be asked for its entries leaves every account open and says so", async () => {
    const ctx = context({
      deps: {
        query: async (input: RunQueryInput) =>
          input.query.includes("Справочник.ДоговорыКонтрагентов")
            ? { ok: true as const, data: { rows: BASE.contract } }
            : { ok: false as const, code: "ONEC", message: "down" },
      },
    });
    const { proposal: p, accountNotes } = proposal(await readDeclaration(sampleInput(), ctx));
    expect(p.entries.find((e) => e.step === 2)?.status).toBe("confirm");
    expect(accountNotes.join(" ")).toMatch(/could not be asked for its entries/);
  });
});

describe("a release declaration", () => {
  const im40 = () =>
    sampleInput({
      regime: "IM 40",
      declaration_no: "26003/10.01.2026/0100001",
      date: "2026-01-10",
      preceding_document: "26003 / 04.11.2025 / 0090704",
      warehouse: null,
      charges: [
        {
          type: "10",
          base: "299308500",
          rate_text: "2.5 x 412000",
          amount: "1030000",
          payment_type: "BN",
          item_no: null,
        },
        {
          type: "20",
          base: "299308500",
          rate_text: "5%",
          amount: "14965425",
          payment_type: "BN",
          item_no: null,
        },
      ],
      items: sampleInput().items.map((i) => ({ ...i, procedure: "40 00" })),
    });
  const footerless = null;

  it("an IM 40 naming a warehouse declaration the company has read is the release from that warehouse; it is checked, not posted", async () => {
    const record = { declarationNo: DECLARATION_NO, kind: "customs_warehouse" } as GtdRecord;
    const outcome = proposal(
      await readDeclaration(im40(), context({ registry: [record] }, footerless)).then((o) => {
        // Without a text layer V1 cannot be judged: give the model's footers.
        return o.status === "proposal"
          ? o
          : readDeclaration(
              { ...im40(), sheets_seen: { present: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], total: 12 } },
              context({ registry: [record] }, footerless),
            );
      }),
    );
    expect(outcome.proposal.kind).toBe("release_from_warehouse");
    expect(outcome.proposal.entries).toEqual([]);
    expect(outcome.proposal.excluded.join(" ")).toMatch(/second sample/);
  });

  it("the same IM 40 with no such declaration known is a release for consumption", async () => {
    const outcome = proposal(
      await readDeclaration(
        { ...im40(), sheets_seen: { present: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], total: 12 } },
        context({}, footerless),
      ),
    );
    expect(outcome.proposal.kind).toBe("release_for_consumption");
    expect(outcome.record?.kind).toBe("release_for_consumption");
  });
});

describe("the record kept for a later release", () => {
  it("the sample is remembered by its number with its items and its fee", async () => {
    const outcome = proposal(await readDeclaration(sampleInput(), context()));
    expect(outcome.record).toMatchObject({
      declarationNo: DECLARATION_NO,
      kind: "customs_warehouse",
      fee: "1030000.00",
      releaseDeadline: "2028-11-03",
      currency: "USD",
      amount: "25000.00",
    });
    expect(outcome.record?.items).toHaveLength(32);
  });
});
