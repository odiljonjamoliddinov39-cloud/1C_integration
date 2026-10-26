/**
 * The reference declaration of the spec (GTD 26003 / 04.11.2025 / 0090704, regime IM 74) as the model would read it from the
 * form pages, and as its footers and back pages read as text. Every number is the spec's §2 and §8 table; what the spec does not
 * give (the gross weights, the Russian names after item 1, the settlement accounts of the test base) is made up here and
 * marked so. Used by the tests only.
 */
import type { GtdReadInput } from "@platform/shared";

import type { PdfPage } from "./pdf-text.js";

/** [no, HS, English name, net kg, value USD]: the spec's §8 table. */
export const SAMPLE_ITEMS: [number, string, string, string, string][] = [
  [1, "8514400000", "Preheating equipment", "269", "9140.00"],
  [2, "8424300100", "Sand blasting equipment", "435", "2300.00"],
  [3, "2818109100", "Sand for sand blasting equipment", "25", "25.00"],
  [4, "8514390009", "Welding rod container (oven)", "3", "30.00"],
  [5, "8467292000", "Electrical grinding tools", "2", "33.00"],
  [6, "8467292000", "Electrical grinding tools", "1.5", "20.20"],
  [7, "6804229000", "Diamond burrs", "0.5", "20.00"],
  [8, "6804229000", "Diamond burrs", "0.25", "10.00"],
  [9, "2849200000", 'Carbide burs ("Sand Burrs")', "1", "12.00"],
  [10, "8001200000", "Tungsten carbide hemisphere", "1", "80.00"],
  [11, "8001200000", "Tungsten carbide hemisphere", "1", "80.00"],
  [12, "8311200000", "Silver rod (solder)", "1", "754.00"],
  [13, "8311200000", "Silver rod (solder)", "2", "1174.00"],
  [14, "3810100000", "Flux", "3", "50.00"],
  [15, "3810100000", "Flux", "2", "55.00"],
  [16, "8311300000", "Hardfacing welding rods", "10", "600.00"],
  [17, "8311300000", "Hardfacing welding rods", "15", "900.00"],
  [18, "8311300000", "Preheating equipment (weight 15 kg)", "15", "810.00"],
  [19, "8311300000", "Hardfacing welding rods", "10", "560.00"],
  [20, "8311300000", "Hardfacing welding rods", "30", "1680.00"],
  [21, "6804210000", "Diamond grinding wheel", "10", "720.00"],
  [22, "6815190000", "Graphite products", "20", "600.00"],
  [23, "6815190000", "Graphite products", "10", "300.00"],
  [24, "6815190000", "Graphite products", "10", "500.00"],
  [25, "6815190000", "Graphite products", "13", "130.00"],
  [26, "6815190000", "Graphite products", "10", "110.00"],
  [27, "8514199000", "Cutter heating equipment", "30", "760.00"],
  [28, "8716800000", "Hydraulic lift platform", "106", "168.00"],
  [29, "8209008000", "PDC nozzles", "1", "485.00"],
  [30, "8209008000", "PDC nozzles", "1", "194.00"],
  [31, "8209008000", "PDC nozzles", "1", "414.00"],
  [32, "7228608000", "Steel bar 4145H", "2078", "2285.80"],
];

export const USED_ITEMS = new Set([29, 30]);

/** The company of the sample: «OOO "TEXMASH IMPORT"», INN 311012912. */
export const OWN_INN = "311012912";
export const DECLARATION_NO = "26003/04.11.2025/0090704";

/** Graph 46: the value over a thousand, in thousands of USD to three digits ("9140.00" → "9.140"). */
const thousand = (value: string) => {
  const [whole = "0", fraction = "00"] = value.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  // value/1000 in thousandths is the value itself in units, so cents/100 rounded.
  const milli = (cents + 50n) / 100n;
  return `${milli / 1000n}.${(milli % 1000n).toString().padStart(3, "0")}`;
};

/** What the model reads from the form pages of the sample declaration; `over` changes it for a test. */
export function sampleInput(over: Partial<GtdReadInput> = {}): GtdReadInput {
  return {
    regime: "IM 74",
    form_no: "EDN881875",
    declaration_no: "26003 / 04.11.2025 / 0090704",
    date: "2025-11-04",
    customs_post: "27001",
    exporter: { name: "SICHUAN SPARK TRADING CO.LTD", country: "CN" },
    importer: { name: 'OOO "TEXMASH IMPORT"', inn: OWN_INN },
    contract: { no: "SC20250919", date: "2025-09-19" },
    invoice: { no: "SC20250919", date: "2025-09-19", currency: "USD", amount: "25000.00" },
    fx_rate: "11972.34",
    customs_value_uzs: "299308500.00",
    items_declared: 32,
    preceding_document: "27001 / 02.11.2025 / 0160321",
    warehouse: { licence: "1701/0159", date: "2020-01-25", release_deadline: "2028-11-03" },
    charges: [
      {
        type: "10",
        base: "299308500",
        rate_text: "2.5 x 412000",
        amount: "1030000",
        payment_type: "BN",
        item_no: null,
      },
    ],
    items: SAMPLE_ITEMS.map(([no, hs, , net, value]) => ({
      no,
      hs,
      qty: no === 32 ? null : "1",
      unit_code: no === 32 ? null : "796",
      // The spec gives item 1's gross weight (278); the others are made up: a kilogram over the net weight.
      gross_kg: no === 1 ? "278" : String(Number(net) + 1),
      net_kg: net,
      value,
      procedure: "74 00",
      statistical_value: thousand(value),
    })),
    ...over,
  };
}

const footer = (sheet: number, of = 12, no = "26003 / 04.11.2025 / 0090704") =>
  `Copy / ${no}. ${sheet}/ ${of}`;

/**
 * The text of the PDF: twelve sheets, a clean footer on each, the item text of graph 31 on the back pages (three items to a
 * TD-2 sheet, as the form has them). `skip` leaves sheets out. The Russian names are made up, except item 1's.
 */
export function samplePages(skip: number[] = []): PdfPage[] {
  const pages: PdfPage[] = [];
  const text = (no: number) => {
    const row = SAMPLE_ITEMS.find((i) => i[0] === no);
    const en = `${row?.[2] ?? ""}${USED_ITEMS.has(no) ? " (Used)" : ""}`;
    const ru =
      no === 1
        ? "Оборудование для предварительного нагрева"
        : `Товар ${no}${USED_ITEMS.has(no) ? " Б/у" : ""}`;
    return [`Item No. ${no}`, `1. ${en}/${ru}`, "2. Packaging: boxes"];
  };
  for (let sheet = 1; sheet <= 12; sheet += 1) {
    if (skip.includes(sheet)) continue;
    // A sheet's back page: the items it carries (sheet 1 has item 1, a TD-2 sheet the next three).
    const numbers = sheet === 1 ? [1] : [2, 3, 4].map((n) => n + (sheet - 2) * 3);
    pages.push({ page: pages.length * 2 + 1, lines: [`╬Ж garbled form ${sheet}`, footer(sheet)] });
    pages.push({ page: pages.length * 2, lines: [...numbers.flatMap(text), footer(sheet)] });
  }
  return pages;
}

/** Rows the test base answers with. */
export const BASE = {
  contract: [["SC20250919", "2025-09-19T00:00:00", "SICHUAN SPARK TRADING CO.LTD"]],
  /** [Dt, Kt, debit subconto, credit subconto] of posted entries: payments to the customs and the supplier's receipts. */
  entries: [
    ["4730", "5110", "Республика Узбекистан Таможенный комитет", ""],
    ["4730", "5110", "Таможенный комитет", ""],
    ["2910", "6015", "", "SICHUAN SPARK TRADING CO.LTD"],
    ["4410", "6015", "", "SICHUAN SPARK TRADING CO.LTD"],
  ],
};
