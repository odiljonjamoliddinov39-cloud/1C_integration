import { describe, expect, it } from "vitest";

import { parseDidoxDocument } from "./document.js";
import {
  type QueryOutcome,
  type ResolverDeps,
  matchItem,
  resolveDocuments,
  similarity,
  tokens,
} from "./resolve.js";

const c = (name: string, ref = `ref-${name}`) => ({ ref, name });

describe("matching the supplier's name to an item", () => {
  it("reads words and numbers, ignoring quotes and case", () => {
    expect(tokens('Подгузники детские "Kippers" active baby - размер 2 Mini (40 шт.)')).toEqual([
      "подгузники",
      "детские",
      "kippers",
      "active",
      "baby",
      "размер",
      "2",
      "mini",
      "40",
      "шт",
    ]);
  });

  it("treats a one-letter spelling difference as the same word", () => {
    expect(similarity("Жидкое мыло CRISTAL", "Жидкое мыло CRYSTAL")).toBe(1);
    expect(similarity("Мыло", "Порошок")).toBe(0);
  });

  it("takes the item whose name is the same", () => {
    expect(
      matchItem("Жидкое мыло CRISTAL 480 мл", [c("Жидкое мыло CRISTAL 480 мл"), c("Жидкое мыло 5 л")], false),
    ).toEqual({
      kind: "match",
      ref: "ref-Жидкое мыло CRISTAL 480 мл",
    });
  });

  it("tells diapers of one IKPU code apart by their size", () => {
    const sizes = [
      c("Подгузники Kippers active baby размер 2 Mini 40 шт"),
      c("Подгузники Kippers active baby размер 3 Midi 34 шт"),
      c("Подгузники Kippers active baby размер 4 Maxi 30 шт"),
    ];
    expect(
      matchItem('Подгузники детские "Kippers" active baby - размер 3 Midi (34 шт.) (0,637)', sizes, false),
    ).toEqual({
      kind: "match",
      ref: "ref-Подгузники Kippers active baby размер 3 Midi 34 шт",
    });
  });

  it("does not take the only item of the code when its volume is another one", () => {
    const result = matchItem("Пенка мыло CRYSTAL 500 мл", [c("Жидкое мыло CRISTAL 480 мл")], false);
    expect(result.kind).toBe("choose");
  });

  it("takes the only item of a service's category code whatever the free text says", () => {
    expect(matchItem("За документ №541256 S=2 500 000,00 Тариф", [c("Банковские услуги")], true)).toEqual({
      kind: "match",
      ref: "ref-Банковские услуги",
    });
    expect(matchItem("За документ №1", [c("Банковские услуги"), c("Комиссия")], true).kind).toBe("choose");
  });

  it("says none when no item has the code", () => {
    expect(matchItem("x", [], false)).toEqual({ kind: "none" });
  });
});

const invoice = (number: string, lines: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({
  facturaid: `id-${number}`,
  facturadoc: { facturano: number, facturadate: "2026-10-13" },
  contractdoc: { contractno: "17", contractdate: "2026-01-08" },
  sellertin: "201607534",
  seller: { name: '"NAVRO\'Z-PTK" MCHJ' },
  buyertin: "303212825",
  buyer: { name: '"CRYSTAL WATER TRADE" MCHJ' },
  productlist: { products: lines },
  ...over,
});
const goods = (ordno: number, name: string, code: string, count: string, price: string) => {
  const amount = String(Number(count) * Number(price));
  const vat = String((Number(amount) * 12) / 100);
  return {
    ordno,
    name,
    catalogcode: code,
    catalogname: "Товары",
    packagename: "шт.",
    count,
    summa: price,
    deliverysum: amount,
    vatrate: 12,
    vatsum: vat,
    deliverysumwithvat: String(Number(amount) + Number(vat)),
  };
};

interface World {
  counterparties?: [string, string, string][];
  contracts?: [string, string, string, string][];
  items?: [string, string, string][];
  /** Items by name only: [name, ref]. */
  describe?: { name: string; synonym: string }[];
  /** The VAT rates the base has, as it names them ("Без НДС", "15%"). */
  vatRates?: string[];
}

function deps(world: World, calls: string[] = []): ResolverDeps {
  const ok = (rows: unknown[][]): QueryOutcome => ({
    ok: true,
    data: { columns: [], rows, truncated: false },
  });
  return {
    async describe() {
      return {
        ok: true,
        data: [{ attributes: world.describe ?? [{ name: "КодИКПУ", synonym: "Код из классификатора" }] }],
      };
    },
    async query({ query, params }) {
      calls.push(query);
      const values = Object.values(params ?? {}).map(String);
      if (query.includes("Перечисление.СтавкиНДС")) return ok((world.vatRates ?? []).map((name) => [name]));
      if (query.includes("Справочник.Контрагенты"))
        return ok(
          (world.counterparties ?? [])
            .filter(([inn]) => values.includes(inn))
            .map(([inn, ref, name]) => [inn, { type: "Справочник.Контрагенты", ref, name }, name]),
        );
      if (query.includes("ДоговорыКонтрагентов"))
        return ok(
          (world.contracts ?? [])
            .filter(([inn]) => values.includes(inn))
            .map(([inn, ref, number, date]) => [
              inn,
              { type: "Справочник.ДоговорыКонтрагентов", ref, name: number },
              number,
              date,
            ]),
        );
      if (query.includes("Т.Наименование В"))
        return ok(
          (world.items ?? [])
            .filter(([, , name]) => values.includes(name))
            .map(([, ref, name]) => [name, { type: "Справочник.Номенклатура", ref, name }]),
        );
      return ok(
        (world.items ?? [])
          .filter(([code]) => values.includes(code))
          .map(([code, ref, name]) => [code, { type: "Справочник.Номенклатура", ref, name }, name]),
      );
    },
  };
}

const NAVROZ = ["201607534", "00000001-0000-4000-8000-000000000001", '"NAVRO\'Z-PTK" MCHJ'] as [
  string,
  string,
  string,
];
const CONTRACT = ["201607534", "00000002-0000-4000-8000-000000000002", "17", "2026-01-08T00:00:00"] as [
  string,
  string,
  string,
  string,
];

describe("resolveDocuments", () => {
  const doc = (number: string, lines: Record<string, unknown>[], over: Record<string, unknown> = {}) =>
    parseDidoxDocument(invoice(number, lines, over))!;

  it("turns a document whose counterparty, contract and items are certain into a draft, and asks 1C in few queries", async () => {
    const calls: string[] = [];
    const resolved = await resolveDocuments(
      [
        doc("663", [
          goods(1, "Жидкое мыло CRISTAL 480 мл", "03401001002241001", "270", "6800"),
          goods(2, "Подгузники Kippers размер 3 Midi 34 шт", "09619002001000000", "80", "46000"),
        ]),
      ],
      { companyInn: "303212825" },
      deps(
        {
          counterparties: [NAVROZ],
          contracts: [CONTRACT],
          items: [
            ["03401001002241001", "00000003-0000-4000-8000-000000000003", "Жидкое мыло CRISTAL 480 мл"],
            [
              "09619002001000000",
              "00000004-0000-4000-8000-000000000004",
              "Подгузники Kippers размер 2 Mini 40 шт",
            ],
            [
              "09619002001000000",
              "00000005-0000-4000-8000-000000000005",
              "Подгузники Kippers размер 3 Midi 34 шт",
            ],
          ],
        },
        calls,
      ),
    );
    expect(resolved.problems).toEqual([]);
    expect(resolved.ready).toHaveLength(1);
    const { draft } = resolved.ready[0]!;
    expect(draft).toMatchObject({
      number: "663",
      date: "2026-10-13",
      counterparty: { ref: "00000001-0000-4000-8000-000000000001" },
      contract: { ref: "00000002-0000-4000-8000-000000000002" },
    });
    expect(draft.lines.map((l) => l.item.ref)).toEqual([
      "00000003-0000-4000-8000-000000000003",
      "00000005-0000-4000-8000-000000000005",
    ]);
    expect(draft.lines[0]).toMatchObject({
      quantity: 270,
      price: 6800,
      amount: 1836000,
      vatRate: 12,
      vatAmount: 220320,
      total: 2056320,
      kind: "goods",
    });
    // counterparties, contracts, VAT rates, names, codes: five queries for the whole batch, not one per line.
    expect(calls).toHaveLength(5);
  });

  describe("VAT rates, accounts and acts", () => {
    const world = (): World => ({
      counterparties: [NAVROZ],
      contracts: [CONTRACT],
      items: [["03401001002241001", "00000003-0000-4000-8000-000000000003", "Жидкое мыло CRISTAL 480 мл"]],
      vatRates: ["Без НДС", "15%"],
    });
    const soap = () => [goods(1, "Жидкое мыло CRISTAL 480 мл", "03401001002241001", "270", "6800")];

    it("asks once when the base lacks the rate on the lines, naming the rates it has", async () => {
      const resolved = await resolveDocuments([doc("1", soap())], { companyInn: "303212825" }, deps(world()));
      expect(resolved.ready).toEqual([]);
      expect(resolved.problems).toEqual([
        expect.objectContaining({
          document: "201607534/1",
          code: "VAT_RATE_MISSING",
          message: expect.stringContaining("which this 1C does not have (it has 0%, 15%)"),
        }),
      ]);
    });

    it("writes a rate the base lacks under the rate the accountant chose, keeping the supplier's VAT amount", async () => {
      const resolved = await resolveDocuments(
        [doc("1", soap())],
        { companyInn: "303212825", rules: { vatRateMap: { 12: 15 } } },
        deps(world()),
      );
      expect(resolved.problems).toEqual([]);
      expect(resolved.ready[0]?.draft.lines[0]).toMatchObject({
        vatRate: 15,
        vatAmount: 220_320,
        total: 2_056_320,
      });
    });

    it("books a line to the account its name or its kind asks for, and keeps the supplier's unit", async () => {
      const lines = [
        goods(1, "Жидкое мыло CRISTAL 480 мл", "03401001002241001", "270", "6800"),
        { ...goods(2, "Аренда склада за ноябрь", "03401001002241001", "1", "100000"), packagename: "услуга" },
      ];
      const w = world();
      w.items = [
        ["03401001002241001", "00000003-0000-4000-8000-000000000003", "Жидкое мыло CRISTAL 480 мл"],
        ["03401001002241001", "00000006-0000-4000-8000-000000000006", "Аренда склада за ноябрь"],
      ];
      const resolved = await resolveDocuments(
        [doc("1", lines)],
        {
          companyInn: "303212825",
          rules: {
            vatRateMap: { 12: 15 },
            accounts: { goods: "2910", service: "9430" },
            accountRules: [{ match: "аренд|ижара|rent", account: "9410" }],
          },
        },
        deps(w),
      );
      expect(resolved.problems).toEqual([]);
      const [soapLine, rentLine] = resolved.ready[0]!.draft.lines;
      expect(soapLine).toMatchObject({ kind: "goods", account: "2910", unit: "шт." });
      expect(rentLine).toMatchObject({ kind: "service", account: "9410", unit: "услуга" });
    });

    it("takes an act with no invoice as a receipt of services without a received invoice", async () => {
      const act = parseDidoxDocument({
        actdoc: { actno: "7510", actdate: "2024-08-31" },
        sellertin: "201607534",
        sellername: "AIRPORTS CARGO",
        buyertin: "303212825",
        buyername: "CRYSTAL",
        productlist: {
          products: [
            {
              ordno: 1,
              name: "Услуги по хранению",
              count: "1",
              summa: "1000",
              totalsumwithoutvat: "1000",
              vatrate: 0,
              vatsum: 0,
              totalsum: "1000",
              catalogcode: "10701001001000000",
            },
          ],
        },
      })!;
      const w = world();
      w.items = [["10701001001000000", "00000007-0000-4000-8000-000000000007", "Услуги хранения"]];
      const resolved = await resolveDocuments([act], { companyInn: "303212825" }, deps(w));
      expect(resolved.problems).toEqual([]);
      expect(resolved.ready[0]?.draft).toMatchObject({ withoutInvoice: true });
      expect(resolved.ready[0]?.draft.lines[0]).toMatchObject({ kind: "service", vatRate: 0 });
    });
  });

  it("leaves the documents of another company's base, with the reason", async () => {
    const resolved = await resolveDocuments(
      [doc("1", [goods(1, "x", "1", "1", "100")])],
      { companyInn: "311012912" },
      deps({}),
    );
    expect(resolved.ready).toEqual([]);
    expect(resolved.problems[0]).toMatchObject({ document: "201607534/1", code: "NOT_THIS_COMPANY" });
  });

  it("stops a document whose own figures do not add up", async () => {
    const bad = goods(1, "x", "1", "2", "100");
    bad.deliverysum = "250";
    const resolved = await resolveDocuments([doc("2", [bad])], {}, deps({ counterparties: [NAVROZ] }));
    expect(resolved.problems[0]).toMatchObject({ code: "CHECK" });
    expect(resolved.problems[0]?.message).toContain("2 × 100.00 = 200.00");
  });

  it("names a counterparty that is missing or doubled", async () => {
    const missing = await resolveDocuments([doc("3", [goods(1, "x", "1", "1", "100")])], {}, deps({}));
    expect(missing.problems[0]).toMatchObject({ code: "COUNTERPARTY_NOT_FOUND" });
    const twice = await resolveDocuments(
      [doc("3", [goods(1, "x", "1", "1", "100")])],
      {},
      deps({ counterparties: [NAVROZ, ["201607534", "00000006-0000-4000-8000-000000000006", "NAVROZ PTK"]] }),
    );
    expect(twice.problems[0]).toMatchObject({ code: "COUNTERPARTY_AMBIGUOUS" });
    expect(twice.problems[0]?.candidates).toHaveLength(2);
    // The model's choice settles it.
    const chosen = await resolveDocuments(
      [doc("3", [goods(1, "x", "01", "1", "100")])],
      {
        overrides: {
          counterparties: [{ document: "201607534/3", ref: "00000006-0000-4000-8000-000000000006" }],
          items: [{ document: "201607534/3", line: 1, ref: "00000007-0000-4000-8000-000000000007" }],
        },
      },
      deps({
        counterparties: [NAVROZ, ["201607534", "00000006-0000-4000-8000-000000000006", "NAVROZ PTK"]],
        contracts: [CONTRACT],
      }),
    );
    expect(chosen.ready[0]?.draft).toMatchObject({
      counterparty: { ref: "00000006-0000-4000-8000-000000000006" },
    });
  });

  it("lists the contracts of the counterparty when the number is not among them", async () => {
    const resolved = await resolveDocuments(
      [
        doc("4", [goods(1, "x", "1", "1", "100")], {
          contractdoc: { contractno: "99", contractdate: "2026-02-02" },
        }),
      ],
      {},
      deps({ counterparties: [NAVROZ], contracts: [CONTRACT] }),
    );
    expect(resolved.problems[0]).toMatchObject({
      code: "CONTRACT_NOT_FOUND",
      candidates: [{ ref: "00000002-0000-4000-8000-000000000002", name: "№17 от 08.01.2026" }],
    });
  });

  it("hands over only the lines it cannot settle, with the candidates, and a document waits for all its lines", async () => {
    const resolved = await resolveDocuments(
      [
        doc("5", [
          goods(1, "Жидкое мыло CRISTAL 480 мл", "03401001002241001", "1", "100"),
          goods(2, "Пенка мыло CRYSTAL 500 мл", "03401001002241001", "1", "100"),
          goods(3, "Совсем новый товар", "99999999999999999", "1", "100"),
        ]),
      ],
      {},
      deps({
        counterparties: [NAVROZ],
        contracts: [CONTRACT],
        items: [["03401001002241001", "00000003-0000-4000-8000-000000000003", "Жидкое мыло CRISTAL 480 мл"]],
      }),
    );
    expect(resolved.ready).toEqual([]);
    expect(resolved.problems.map((p) => [p.line, p.code])).toEqual([
      [2, "ITEM_CHOOSE"],
      [3, "ITEM_NOT_FOUND"],
    ]);
    expect(resolved.problems[0]?.candidates).toEqual([
      { ref: "00000003-0000-4000-8000-000000000003", name: "Жидкое мыло CRISTAL 480 мл" },
    ]);
  });

  it("finds the IKPU attribute by its title, and looks up only exact names when there is none", async () => {
    const cache = {};
    const world = {
      counterparties: [NAVROZ],
      contracts: [CONTRACT],
      items: [
        ["03401001002241001", "00000003-0000-4000-8000-000000000003", "Мыло"] as [string, string, string],
      ],
      describe: [{ name: "Артикул", synonym: "Артикул" }],
    };
    const resolved = await resolveDocuments(
      [doc("6", [goods(1, "Мыло", "03401001002241001", "1", "100")])],
      { cache },
      deps(world),
    );
    // The exact name still finds it.
    expect(resolved.ready).toHaveLength(1);
    expect(cache).toEqual({ ikpuAttribute: null });
    const other = await resolveDocuments(
      [doc("7", [goods(1, "Другое", "03401001002241001", "1", "100")])],
      { cache },
      deps(world),
    );
    expect(other.problems[0]).toMatchObject({ code: "ITEM_NOT_FOUND" });
    expect(other.problems[0]?.message).toContain("IKPU attribute");
  });

  it("goes on to the extension's own lookup when 1C cannot be queried", async () => {
    const down: ResolverDeps = {
      describe: async () => ({ ok: false, code: "BASE_BUSY", message: "busy" }),
      query: async () => ({ ok: false, code: "BASE_BUSY", message: "busy" }),
    };
    const resolved = await resolveDocuments([doc("8", [goods(1, "x", "1", "1", "100")])], {}, down);
    // Items cannot be settled without 1C, so the line is left to the model.
    expect(resolved.problems[0]).toMatchObject({ code: "ITEM_NOT_FOUND" });
  });
});
