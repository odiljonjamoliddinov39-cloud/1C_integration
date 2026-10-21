/**
 * Simulation: thousands of generated companies with several bank accounts. The money that moves between their own
 * accounts, the fees passed through a transit account, and the payments to outsiders are known by construction; the
 * plan must hand the resolver exactly the outsiders' payments and the fees, report each own transfer once, and lose
 * or double nothing.
 */
import { describe, expect, it } from "vitest";

import { planLedger } from "../bank/ledger.js";
import type { BankPayment, BankStatement } from "../bank/statement.js";
import { cases, Rng, seed } from "./rng.js";

const account = (n: number) => `20208000${String(100438330000 + n * 7).padStart(12, "0")}`.slice(0, 20);

describe("simulation: a company's accounts read together", () => {
  it("outsiders' payments and fees are entered, own transfers once, nothing twice, nothing lost", () => {
    const rng = new Rng(seed(70));
    const bad: string[] = [];
    const n = cases(2500);
    for (let i = 0; i < n; i++) {
      const settlements = Array.from({ length: rng.int(1, 4) }, (_, k) => account(k + 1));
      const transit = rng.chance(0.6) ? account(90) : null;
      const rows = new Map<string, BankPayment[]>();
      for (const a of [...settlements, ...(transit ? [transit] : [])]) rows.set(a, []);
      const add = (a: string, p: Omit<BankPayment, "row" | "number" | "mfo" | "inn"> & { inn?: string }) => {
        const list = rows.get(a)!;
        list.push({
          row: list.length + 2,
          number: String(list.length + 1),
          mfo: "00444",
          inn: p.inn ?? "",
          ...p,
        });
      };
      const date = () => `2026-09-${String(rng.int(1, 28)).padStart(2, "0")}`;
      const expectedRows = new Map<string, Set<number>>();
      const expectedFees = new Map<string, Set<number>>();
      for (const a of settlements) {
        expectedRows.set(a, new Set());
        expectedFees.set(a, new Set());
      }
      let outside = 0;
      let pairs = 0;

      for (const a of settlements) {
        for (let k = 0; k < rng.int(0, 12); k++) {
          const d = rng.chance(0.1) ? "2026-08-15" : date();
          if (d < "2026-09-01") outside++;
          const before = rows.get(a)!.length;
          add(a, {
            date: d,
            direction: rng.chance(0.5) ? "in" : "out",
            amount: rng.int(1, 9e9),
            counterparty: "Texmash MCHJ",
            inn: "312318957",
            account: "20208000900000000009",
            purpose: "Оплата по договору №17",
          });
          if (d >= "2026-09-01") expectedRows.get(a)!.add(before + 2);
        }
      }
      // Own transfers: two legs, the same day and amount.
      if (settlements.length > 1) {
        for (let k = 0; k < rng.int(0, 6); k++) {
          const [a, b] = rng.shuffle(settlements);
          const d = date();
          const amount = rng.int(100, 9e9);
          add(a!, {
            date: d,
            direction: "out",
            amount,
            counterparty: "Own",
            account: b!,
            purpose: "Перевод между своими счетами",
          });
          add(b!, {
            date: d,
            direction: "in",
            amount,
            counterparty: "Own",
            account: a!,
            purpose: "Перевод между своими счетами",
          });
          pairs++;
        }
      }
      // Fees through a transit account: the settlement pays it, it pays the bank the same.
      if (transit) {
        let fees = 0;
        for (const a of settlements) {
          for (let k = 0; k < rng.int(0, 5); k++) {
            const d = date();
            const amount = rng.int(100, 500_000);
            const before = rows.get(a)!.length;
            add(a, {
              date: d,
              direction: "out",
              amount,
              counterparty: "Транзит",
              account: transit,
              purpose: "Комиссия банка",
            });
            add(transit, {
              date: d,
              direction: "in",
              amount,
              counterparty: "Own",
              account: a,
              purpose: "Комиссия",
            });
            add(transit, {
              date: d,
              direction: "out",
              amount,
              counterparty: "Bank",
              account: "10101000100000000001",
              purpose: "Комиссия банка за документы",
            });
            expectedRows.get(a)!.add(before + 2);
            expectedFees.get(a)!.add(before + 2);
            fees++;
          }
        }
        if (fees === 0) {
          // A transit account must have something to pass; without fees there is nothing to check here.
          rows.delete(transit);
        }
      }
      const statements: BankStatement[] = [...rows].map(([a, payments]) => ({
        fileName: `${a}.xlsx`,
        sheet: "s",
        account: a,
        ...(a === transit ? { balances: { opening: 0, closing: 0 } } : {}),
        payments,
        issues: [],
        columns: {},
        convention: "",
      }));
      const plan = planLedger(
        statements.sort(() => rng.next() - 0.5),
        { from: "2026-09-01", to: "2026-09-30" },
      );

      for (const a of settlements) {
        const got = new Set(plan.rows.get(`${a}.xlsx`) ?? []);
        const want = expectedRows.get(a)!;
        if (got.size !== (plan.rows.get(`${a}.xlsx`) ?? []).length)
          bad.push(`#${i} ${a}: a row handed on twice`);
        if (got.size !== want.size || [...want].some((r) => !got.has(r)))
          bad.push(`#${i} ${a}: rows ${[...got].join(",")} ≠ ${[...want].join(",")}`);
        const fees = plan.fees.get(`${a}.xlsx`) ?? new Set();
        const wantFees = expectedFees.get(a)!;
        if (fees.size !== wantFees.size || [...wantFees].some((r) => !fees.has(r)))
          bad.push(`#${i} ${a}: fees ${[...fees].join(",")} ≠ ${[...wantFees].join(",")}`);
      }
      // A transfer inside the period, reported once; out-of-period external payments counted as left out.
      if (plan.transfers.length !== pairs)
        bad.push(`#${i}: ${plan.transfers.length} transfers, expected ${pairs}`);
      if (plan.transfers.some((t) => !t.in || !t.out)) bad.push(`#${i}: a transfer has no second leg`);
      if (plan.outsidePeriod !== outside)
        bad.push(`#${i}: outside period ${plan.outsidePeriod} ≠ ${outside}`);
    }
    expect(bad.slice(0, 12), `${bad.length} problems in ${n} companies`).toEqual([]);
  });
});
