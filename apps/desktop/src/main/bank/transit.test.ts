import { describe, expect, it } from "vitest";

import type { BankDeps } from "./resolve.js";
import type { BankPayment, BankStatement } from "./statement.js";
import { isEntrepreneur, matchTransit, personIn, personKey } from "./transit.js";

describe("the person a payment through the bank's transit account names", () => {
  it.each([
    [
      "00634 Оплата по договору TI-FB-05 от 18.12.2024г с Qodirov Farruh Bozorovich на поставку бур.инструм",
      "Qodirov Farruh Bozorovich",
    ],
    [
      "00634 оплата Qodirov Farruh Bozorovich по договору TI-FB-05 от 29.11.2024г. на бур инструментов",
      "Qodirov Farruh Bozorovich",
    ],
    [
      "Оплата по договору RG-TI-15/05 от 15.05.2025г. с RAYIMOV GULOM GOPUROVICH на поставку",
      "RAYIMOV GULOM GOPUROVICH",
    ],
  ])("%s", (purpose, name) => {
    expect(personIn(purpose)).toBe(name);
  });

  it("is null when the text names nobody, and an entrepreneur is the same person with or without his form", () => {
    expect(personIn("Оплата таможенных пошлин юридических лиц")).toBeNull();
    expect(personKey("YTT QODIROV FARRUH BOZOROVICH")).toBe(personKey("Qodirov Farruh Bozorovich"));
    expect(personKey("ИП Qodirov Farruh Bozorovich")).toBe(personKey("QODIROV FARRUH BOZOROVICH"));
    expect(isEntrepreneur("YTT RAXMATOVA OLMA")).toBe(true);
    expect(isEntrepreneur("Person")).toBe(false);
  });
});

const payment = (over: Partial<BankPayment>): BankPayment => ({
  row: 1,
  date: "2024-12-18",
  number: "1",
  direction: "out",
  amount: 100_000_000,
  counterparty: "транзитный счет для зач на ПК физ лиц налич ср-в",
  inn: "207275139",
  account: "29898000900000000001",
  mfo: "00634",
  purpose:
    "00634 Оплата по договору TI-FB-05 от 18.12.2024г с Qodirov Farruh Bozorovich на поставку бур.инструм",
  ...over,
});

const statement = (payments: BankPayment[]): BankStatement =>
  ({
    fileName: "main.xlsx",
    account: "20208000705733821001",
    payments,
    issues: [],
  }) as unknown as BankStatement;

const deps = (names: Record<string, string[]>): BankDeps => ({
  async query(input) {
    const word = String(Object.values(input.params ?? {})[0] ?? "")
      .replace(/%/g, "")
      .toLowerCase();
    const found = Object.entries(names).flatMap(([key, list]) => (word.includes(key) ? list : []));
    return { ok: true, data: { rows: found.map((n) => [n]) } };
  },
  async describe() {
    return { ok: true, data: [] };
  },
  async getObject() {
    return { ok: false, code: "X", message: "none" };
  },
});

describe("payments through a transit account written to their real payee", () => {
  it("writes the person to the counterparty 1C has, by his letters, and the customs to its counterparty", async () => {
    const out = await matchTransit(
      deps({ qodirov: ["ИП QODIROV FARRUH BOZOROVICH"], божхон: ["Давлат божхона қўмитаси"] }),
      statement([
        payment({ row: 1 }),
        payment({
          row: 2,
          counterparty: "Транзитный счёт МУНИС для юридических лиц",
          inn: "207117389",
          purpose: "Оплата таможенных пошлин юридических лиц и индивидуальных предпринимат, 311012912,0127",
        }),
        payment({ row: 3, counterparty: "OOO Romashka", inn: "301122334", purpose: "Оплата по договору 5" }),
      ]),
      [],
    );
    expect(out.persons).toEqual({ found: 1, unknown: [], rows: 1 });
    expect(out.statement.payments[0]).toMatchObject({
      counterparty: "ИП QODIROV FARRUH BOZOROVICH",
      inn: "",
      innZero: true,
    });
    expect(out.customs).toEqual({ rows: 1, counterparty: "Давлат божхона қўмитаси", problem: null });
    expect(out.statement.payments[1]).toMatchObject({
      counterparty: "Давлат божхона қўмитаси",
      innZero: true,
    });
    // an ordinary payment is not touched
    expect(out.statement.payments[2]?.counterparty).toBe("OOO Romashka");
  });

  it("takes the person from his other rows when 1C lacks him, and says the customs is missing instead of making one up", async () => {
    const other = statement([
      payment({
        row: 9,
        direction: "in",
        counterparty: "YTT QODIROV FARRUH BOZOROVICH",
        inn: "31601925300011",
        purpose: "оплата",
      }),
    ]);
    const out = await matchTransit(
      deps({}),
      statement([
        payment({ row: 1 }),
        payment({
          row: 2,
          counterparty: "Транзитный счёт МУНИС для юридических лиц",
          purpose: "Оплата таможенных пошлин",
        }),
      ]),
      [other],
    );
    expect(out.persons.unknown).toEqual(["Qodirov Farruh Bozorovich"]);
    expect(out.statement.payments[0]).toMatchObject({
      counterparty: "YTT QODIROV FARRUH BOZOROVICH",
      innZero: true,
    });
    expect(out.customs.counterparty).toBeNull();
    expect(out.customs.problem).toContain("1C has no counterparty for the customs");
    expect(out.statement.payments[1]?.counterparty).toContain("МУНИС");
  });

  it("changes nothing in a statement with no such payment", async () => {
    const s = statement([payment({ counterparty: "OOO Romashka", inn: "301122334", purpose: "Оплата" })]);
    expect((await matchTransit(deps({}), s, [])).statement).toBe(s);
  });
});
