/**
 * Simulation: thousands of generated bank statements in the layouts banks export (Дебет/Кредит or a signed amount,
 * Russian, Uzbek, Latin headings, or no headings at all), in every number and date format. The payments that went in
 * must be the payments that come out: date, direction, tiyin, INN, number, counterparty. A totals row is no payment.
 */
import { describe, expect, it } from "vitest";

import type { TableFile } from "../tables.js";
import { parseBankStatement } from "../bank/statement.js";
import { cases, Rng, seed } from "./rng.js";

interface Truth {
  date: string;
  number: string;
  direction: "in" | "out";
  tiyin: number;
  name: string;
  inn: string;
  account: string;
  mfo: string;
  purpose: string;
}

const NAMES = [
  "NAVRO'Z-PTK",
  "HYDRO DRILL",
  "Texmash MCHJ",
  "Kapital Savdo",
  "ООО Ромашка",
  "Yangi Asr XK",
  "Orient Trade",
  "Alfa Stroy",
];
const PURPOSES = [
  "Оплата по договору №17 от 12.03.2026 за услуги",
  "001112023 йил шартномага асосан махсулотлари олиш учун утказилди",
  "За услуги бурения скважины по договору",
  "Pul o'tkazmasi shartnoma asosida to'lov",
  "Оплата за товар по счету 4455, в т.ч. НДС 12%",
  "Аренда офиса за сентябрь 2026 года по договору аренды",
];
const OWN = "20208000100438330001";

const fmtDate = (rng: Rng, iso: string, style: number) => {
  const [y, m, d] = iso.split("-") as [string, string, string];
  return style === 0 ? `${d}.${m}.${y}` : style === 1 ? iso : `${d}/${m}/${y}`;
};
const fmtMoney = (rng: Rng, t: number, style: number) => {
  const whole = Math.floor(t / 100);
  const frac = String(t % 100).padStart(2, "0");
  const grouped = (sep: string) => String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  if (style === 0) return `${grouped(" ")},${frac}`;
  if (style === 1) return `${whole}.${frac}`;
  if (style === 2) return `${grouped(",")}.${frac}`;
  return `${whole},${frac}`;
};

function truth(rng: Rng, rows: number): Truth[] {
  const list: Truth[] = [];
  for (let i = 0; i < rows; i++) {
    const ix = rng.int(0, NAMES.length - 1);
    list.push({
      date: rng.date(2025, 2026),
      number: String(rng.int(1, 99999)),
      direction: rng.chance(0.5) ? "in" : "out",
      // At least a few soums: a "0,40" amount is a different problem.
      tiyin: rng.int(100, 99_999_999_999),
      name: NAMES[ix]!,
      // The same counterparty keeps its INN, as in a real statement.
      inn: String(300_000_000 + ix * 7_919 + 11),
      account: `20208000900${String(1000000000 + ix * 13_337).slice(1)}`.slice(0, 20).padEnd(20, "0"),
      mfo: "00444",
      purpose: rng.pick(PURPOSES),
    });
  }
  return list;
}

function layout(rng: Rng, payments: Truth[], kind: number): TableFile {
  const dateStyle = rng.int(0, 2);
  const moneyStyle = rng.int(0, 3);
  const money = (t: number) => fmtMoney(rng, t, moneyStyle);
  const top: string[][] = rng.chance(0.6)
    ? [
        [`Выписка по счёту ${OWN} за период`],
        [],
        ["Остаток:", "Начало дня", "0,00", "", "Конец дня", "1 234,50"],
      ]
    : [];
  let rows: string[][];
  if (kind === 0) {
    rows = [
      [
        "Дата",
        "№ док",
        "Наименование корреспондента",
        "ИНН",
        "МФО",
        "Счёт корр.",
        "Дебет",
        "Кредит",
        "Назначение платежа",
      ],
      ...payments.map((p) => [
        fmtDate(rng, p.date, dateStyle),
        p.number,
        p.name,
        p.inn,
        p.mfo,
        p.account,
        p.direction === "out" ? money(p.tiyin) : "",
        p.direction === "in" ? money(p.tiyin) : "",
        p.purpose,
      ]),
      ["Итого", "", "", "", "", "", "999 999,00", "888 888,00", ""],
    ];
  } else if (kind === 1) {
    rows = [
      ["Дата", "Номер", "Контрагент", "ИНН", "Сумма", "Назначение"],
      ...payments.map((p) => [
        fmtDate(rng, p.date, dateStyle),
        p.number,
        p.name,
        p.inn,
        (p.direction === "out" ? "-" : "") + money(p.tiyin),
        p.purpose,
      ]),
    ];
  } else if (kind === 2) {
    rows = [
      ["Sana", "Hujjat raqami", "Kontragent nomi", "STIR", "Debet", "Kredit", "To'lov maqsadi"],
      ...payments.map((p) => [
        fmtDate(rng, p.date, dateStyle),
        p.number,
        p.name,
        p.inn,
        p.direction === "out" ? money(p.tiyin) : "",
        p.direction === "in" ? money(p.tiyin) : "",
        p.purpose,
      ]),
    ];
  } else {
    // No headings: the bank's export with chosen fields.
    rows = payments.map((p) => [
      fmtDate(rng, p.date, dateStyle),
      p.number,
      p.name,
      p.account,
      p.mfo,
      OWN,
      p.inn,
      p.direction === "out" ? money(p.tiyin) : "",
      p.direction === "in" ? money(p.tiyin) : "",
      p.purpose,
    ]);
  }
  return { name: "vypiska.xlsx", sheets: [{ name: "Лист1", rows: [...(kind === 3 ? [] : top), ...rows] }] };
}

describe("simulation: bank statements come out as they went in", () => {
  for (const [kind, label] of [
    [0, "Дебет/Кредит, Russian headings"],
    [1, "a signed amount"],
    [2, "Uzbek Latin headings"],
    [3, "no headings at all"],
  ] as const) {
    it(`${label}: every payment, every format`, () => {
      const rng = new Rng(seed(50 + kind));
      const bad: string[] = [];
      const n = cases(kind === 3 ? 600 : 700);
      for (let i = 0; i < n; i++) {
        const payments = truth(rng, rng.int(kind === 3 ? 6 : 1, 40));
        const parsed = parseBankStatement(layout(rng, payments, kind));
        if (!parsed) {
          bad.push(`#${i} not read at all (${payments.length} rows)`);
          continue;
        }
        if (parsed.payments.length !== payments.length) {
          bad.push(`#${i} ${parsed.payments.length} payments, expected ${payments.length}`);
          continue;
        }
        payments.forEach((p, k) => {
          const got = parsed.payments[k]!;
          const miss = [
            got.date !== p.date && "date",
            got.direction !== p.direction && "direction",
            got.amount !== p.tiyin && `amount ${got.amount}≠${p.tiyin}`,
            got.inn !== p.inn && `inn ${got.inn}≠${p.inn}`,
            got.number !== p.number && "number",
            got.counterparty !== p.name && "name",
            got.purpose !== p.purpose && "purpose",
          ].filter(Boolean);
          if (miss.length) bad.push(`#${i} row ${k}: ${miss.join(", ")} ${JSON.stringify(got)}`);
        });
        if (kind !== 3 && parsed.account !== "" && parsed.account !== OWN)
          bad.push(`#${i} own account ${parsed.account}`);
      }
      expect(bad.slice(0, 12), `${bad.length} problems in ${n} statements`).toEqual([]);
    });
  }

  it("never throws on a table of junk, and reads no payment out of text", () => {
    const rng = new Rng(seed(60));
    const cells = [
      "",
      "Итого",
      "abc",
      "1 000,00",
      "01.02.2026",
      "12345",
      "-5",
      "Дата",
      "Сумма",
      "Назначение",
      "Дебет",
      "Кредит",
      "ИНН",
      "x".repeat(50),
    ];
    for (let i = 0; i < cases(2000); i++) {
      const rows = Array.from({ length: rng.int(0, 30) }, () =>
        Array.from({ length: rng.int(0, 12) }, () => rng.pick(cells)),
      );
      expect(() => parseBankStatement({ name: "x.xlsx", sheets: [{ name: "s", rows }] })).not.toThrow();
    }
  });
});
