/**
 * Attack: payment purposes as clients and banks really write them. The contract a purpose names, the acquiring split
 * of a card receipt, the tax a payment is for: read right out of many wordings and fillers, and never invented out of
 * text that only looks alike (an invoice date is not a contract date; a split that does not add up is no split).
 */
import { describe, expect, it } from "vitest";

import { parseAcquiring } from "../bank/acquiring.js";
import { contractMention, isTaxPayment, shapeOf } from "../bank/resolve.js";
import type { BankPayment } from "../bank/statement.js";
import { cases, Rng, seed } from "./rng.js";

const pad = (n: number) => String(n).padStart(2, "0");

describe("attack: contract mentions", () => {
  const NUMBERS = ["17", "4/28", "ABC-12", "2024/17", "№5", "12-А", "001", "17к", "М-2026/3"];
  const LEADS = [
    (n: string, d: string) => `Оплата по договору №${n} от ${d}`,
    (n: string, d: string) => `по дог. ${n} от ${d}г.`,
    (n: string, d: string) => `Договор ${n} от ${d} за услуги`,
    (n: string, d: string) => `оплата за товар согласно договору N ${n} от ${d} г., в т.ч. НДС 12%`,
    (n: string, d: string) => `shartnoma ${n} dan ${d} asosida to'lov`,
    (n: string, d: string) => `Оплата по договору номер ${n} от ${d}`,
    (n: string, d: string) => `за аренду по договору № ${n} от ${d} НДС не облагается`,
  ];

  it("read the contract's number and date out of every wording", () => {
    const rng = new Rng(seed(240));
    const bad: string[] = [];
    for (let i = 0; i < cases(5000); i++) {
      const raw = rng.pick(NUMBERS);
      const number = raw.replace(/^№/, "");
      const [d, m, y] = [rng.int(1, 28), rng.int(1, 12), rng.int(2020, 2026)];
      const text = rng.pick(LEADS)(number, `${pad(d)}.${pad(m)}.${y}`);
      const got = contractMention(text);
      if (!got) {
        bad.push(`NONE ← ${text}`);
        continue;
      }
      if (
        got.date !== `${y}-${pad(m)}-${pad(d)}` ||
        got.number.replace(/[\s№]/g, "").toLowerCase() !== number.toLowerCase()
      )
        bad.push(`${got.number}|${got.date} ← ${text}`);
    }
    expect(bad.slice(0, 10), `${bad.length} wrong`).toEqual([]);
  });

  it("do not make a contract out of another document's date", () => {
    const rng = new Rng(seed(241));
    const bad: string[] = [];
    for (let i = 0; i < cases(3000); i++) {
      const date = `${pad(rng.int(1, 28))}.${pad(rng.int(1, 12))}.${rng.int(2020, 2026)}`;
      const text = rng.pick([
        `Оплата по счету №${rng.int(1, 999)} от ${date}`,
        `Оплата по счет-фактуре ${rng.int(1, 999)} от ${date}`,
        `За товар по накладной ${rng.int(1, 999)} от ${date}`,
        `hisob-faktura ${rng.int(1, 999)} dan ${date} bo'yicha`,
        `Возврат по акту сверки от ${date}`,
        `Зарплата за ${pad(rng.int(1, 12))}.${rng.int(2024, 2026)}`,
      ]);
      const got = contractMention(text);
      if (got) bad.push(`${got.number}|${got.date} ← ${text}`);
    }
    expect(bad.slice(0, 10), `${bad.length} invented`).toEqual([]);
  });
});

describe("attack: acquiring receipts", () => {
  const comma = (n: number, style: number) => {
    const [whole, frac] = n.toFixed(2).split(".") as [string, string];
    const g = (sep: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
    return style === 0
      ? `${g(",")}.${frac}`
      : style === 1
        ? `${whole}.${frac}`
        : style === 2
          ? `${g(" ")},${frac}`
          : `${whole},${frac}`;
  };

  it("split a card receipt to the tiyin when the figures add up, in every number style", () => {
    const rng = new Rng(seed(242));
    const bad: string[] = [];
    for (let i = 0; i < cases(5000); i++) {
      const gross = rng.int(10_000, 99_999_999_00) / 100;
      const commission = Math.max(0.01, Math.round(gross * rng.pick([0.002, 0.01, 0.015]) * 100) / 100);
      const net = Math.round((gross - commission) * 100);
      const style = rng.int(0, 3);
      const tid = rng.digits(8);
      const purpose = `${rng.digits(5)}SmartVista - Выручка SHOP ${comma(net / 100, style)} сум с 12.10.2026 по 12.10.2026 ( TID ${tid}) от сумма: ${comma(gross, style)}${rng.chance(0.3) ? "(VISA)" : ""} в том числе комиссия ${rng.pick(["(0.2%)", "(Surcharge+MechantFee)", ""])} ${comma(commission, style)}`;
      const got = parseAcquiring(purpose, net);
      if (!got) {
        bad.push(`NONE ← ${purpose}`);
        continue;
      }
      if (
        got.gross !== Math.round(gross * 100) ||
        got.commission !== Math.round(commission * 100) ||
        got.terminal !== tid
      )
        bad.push(`${got.gross}/${got.commission}/${got.terminal} ← ${purpose}`);
      // Off by anything: not a split.
      if (parseAcquiring(purpose, net + rng.int(2, 500)) !== null) bad.push(`split a wrong net ← ${purpose}`);
    }
    expect(bad.slice(0, 8), `${bad.length} wrong`).toEqual([]);
  });
});

describe("attack: shapes and tax payments", () => {
  it("the same kind of payment has one shape, whatever the figures", () => {
    const rng = new Rng(seed(243));
    for (let i = 0; i < cases(3000); i++) {
      const make = () =>
        `00634SmartVista - Выручка SHOP ${rng.int(1, 9_999_999)},${rng.int(10, 99)} сум с ${pad(rng.int(1, 28))}.10.2026 TID ${rng.digits(8)}`;
      expect(shapeOf(make())).toBe(shapeOf(make()));
    }
    expect(shapeOf("Оплата за товар")).not.toBe(shapeOf("Оплата за услуги"));
  });

  it("a payment to the budget is recognised by receiver or by tax, never an ordinary supplier", () => {
    const rng = new Rng(seed(244));
    const payment = (counterparty: string, purpose: string): BankPayment => ({
      row: 1,
      date: "2026-09-10",
      number: "1",
      direction: "out",
      amount: 100,
      counterparty,
      inn: "",
      account: "",
      mfo: "",
      purpose,
    });
    for (let i = 0; i < cases(2000); i++) {
      const tax = rng.pick([
        "НДС",
        "налог на прибыль",
        "ИНПС",
        "НДФЛ",
        "soliq to'lovi",
        "Солиқ",
        "налог на имущество",
      ]);
      expect(isTaxPayment(payment("ГНК", `Оплата ${tax} за ${rng.int(1, 12)}.2026`)), tax).toBe(true);
      expect(isTaxPayment(payment("Государственное казначейство", "Перечисление по ПП")), "treasury").toBe(
        true,
      );
      const supplier = rng.pick(["Texmash MCHJ", "ООО Ромашка", "Kapital Savdo"]);
      expect(isTaxPayment(payment(supplier, `Оплата по договору №${rng.int(1, 99)} за товар`))).toBe(false);
      // An incoming payment is never a payment to the budget.
      expect(isTaxPayment({ ...payment("ГНК", `${tax}`), direction: "in" })).toBe(false);
    }
  });
});
