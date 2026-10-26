/**
 * Attack: whole bank statements against a generated 1C base. However the statement and the base are made up, every
 * payment lands in exactly one place (a document, "already in 1C", a counterparty to create, or a problem with its
 * reason); a document carries the payment's own date, amount and direction, the counterparty its INN names and a
 * contract of that counterparty — never another's; the breakdown adds up to the amount.
 */
import { describe, expect, it } from "vitest";

import type { RunQueryInput } from "@platform/shared";

import { type BankDeps, resolvePayments } from "../bank/resolve.js";
import type { BankPayment, BankStatement } from "../bank/statement.js";
import { cases, Rng, seed } from "./rng.js";

const ref = (type: string, id: string, name: string) => ({ type, ref: id, name });
const uuid = (rng: Rng) => {
  const h = () => Array.from({ length: 4 }, () => rng.int(0, 65535).toString(16).padStart(4, "0")).join("");
  const s = h() + h();
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-8${s.slice(17, 20)}-${s.slice(20, 32)}`;
};
const OWN = "11111111-1111-4111-8111-111111111111";

interface Party {
  inn: string;
  ref: string;
  name: string;
  contract: string;
  docs: { object: string; ref: string }[];
}

function world(rng: Rng) {
  const parties: Party[] = Array.from({ length: rng.int(2, 8) }, (_, k) => ({
    inn: String(300_000_000 + k * 17 + 5),
    ref: uuid(rng),
    name: `Party ${k}`,
    contract: uuid(rng),
    docs: [],
  }));
  const docs = new Map<string, { object: string; owner: Party; total: number }>();
  for (const p of parties) {
    for (const object of ["Документ.ПоступлениеНаРасчетныйСчет", "Документ.СписаниеСРасчетногоСчета"]) {
      if (rng.chance(0.75)) {
        const id = uuid(rng);
        p.docs.push({ object, ref: id });
        docs.set(id, { object, owner: p, total: rng.int(10, 9_999_999) });
      }
    }
  }
  const snapshot = (id: string) => {
    const d = docs.get(id)!;
    return {
      fields: {
        Номер: "0001",
        Дата: "2026-08-01T00:00:00",
        Проведен: true,
        Организация: ref("Справочник.Организации", uuid(rng), "ORG"),
        БанковскийСчет: ref("Справочник.БанковскиеСчета", uuid(rng), "old"),
        Контрагент: ref("Справочник.Контрагенты", d.owner.ref, d.owner.name),
        ДоговорКонтрагента: ref("Справочник.ДоговорыКонтрагентов", d.owner.contract, "№1"),
        СуммаДокумента: d.total,
        НазначениеПлатежа: "старое",
      },
      tables: {
        РасшифровкаПлатежа: [
          {
            ДоговорКонтрагента: ref("Справочник.ДоговорыКонтрагентов", d.owner.contract, "№1"),
            СуммаПлатежа: d.total,
            КурсВзаиморасчетов: 1,
            СуммаВзаиморасчетов: d.total,
            СуммаНДС: 0,
          },
        ],
      },
    };
  };
  return { parties, docs, snapshot };
}

function deps(w: ReturnType<typeof world>, existing: [string, string, number][]): BankDeps {
  return {
    async query(input: RunQueryInput) {
      const q = input.query;
      const params = Object.values(input.params ?? {});
      const rows = (list: unknown[][]) => ({ ok: true as const, data: { rows: list } });
      if (q.includes("Справочник.БанковскиеСчета") && q.includes("НомерСчета В"))
        return rows([[ref("Справочник.БанковскиеСчета", OWN, "р/с")]]);
      if (q.includes("Справочник.БанковскиеСчета")) return rows([]);
      if (q.includes("Справочник.ДоговорыКонтрагентов"))
        return rows(
          w.parties
            .filter((p) => params.includes(p.inn))
            .map((p) => [
              p.inn,
              ref("Справочник.ДоговорыКонтрагентов", p.contract, "№1"),
              "1",
              "2026-01-01T00:00:00",
            ]),
        );
      if (q.includes("Справочник.Контрагенты"))
        return rows(
          w.parties
            .filter((p) => params.includes(p.inn))
            .map((p) => [p.inn, ref("Справочник.Контрагенты", p.ref, p.name), p.name]),
        );
      if (q.includes("ПЕРВЫЕ")) {
        const object = q.includes("СписаниеС")
          ? "Документ.СписаниеСРасчетногоСчета"
          : "Документ.ПоступлениеНаРасчетныйСчет";
        const inn = input.params?.инн;
        return rows(
          w.parties
            .filter((p) => !inn || p.inn === inn)
            .flatMap((p) =>
              p.docs.filter((d) => d.object === object).map((d) => [ref(d.object, d.ref, "док"), "старое"]),
            ),
        );
      }
      if (q.includes("Т.Дата МЕЖДУ")) {
        const object = q.includes("СписаниеС")
          ? "Документ.СписаниеСРасчетногоСчета"
          : "Документ.ПоступлениеНаРасчетныйСчет";
        return rows(
          existing
            .filter(([o]) => o === object)
            .map(([, who, sum]) => [
              null,
              ref("Справочник.Контрагенты", who, "x"),
              "2026-09-10T00:00:00",
              sum,
              "",
            ]),
        );
      }
      return rows([]);
    },
    async describe() {
      return { ok: true, data: [] };
    },
    async getObject(object, id) {
      return w.docs.has(id)
        ? { ok: true, data: { object, ref: id, ...w.snapshot(id) } }
        : { ok: false, code: "NOT_FOUND", message: "none" };
    },
  };
}

describe("attack: a statement against a base", () => {
  it("every payment lands in one place; documents carry the payment's own figures and the right counterparty's contract", async () => {
    const rng = new Rng(seed(270));
    const bad: string[] = [];
    const tally = { ready: 0, already: 0, problems: 0, missing: 0 };
    const n = cases(500);
    for (let i = 0; i < n; i++) {
      const w = world(rng);
      const unknownInn = "999999999";
      const payments: BankPayment[] = Array.from({ length: rng.int(1, 25) }, (_, k) => {
        const party = rng.chance(0.8) ? rng.pick(w.parties) : null;
        return {
          row: k + 5,
          date: "2026-09-10",
          number: String(100 + k),
          direction: rng.pick(["in", "out"] as const),
          amount: rng.int(1000, 99_999_999),
          counterparty: party?.name ?? "Unknown LLC",
          inn: party?.inn ?? (rng.chance(0.7) ? unknownInn : ""),
          account: "",
          mfo: "",
          purpose: rng.pick(["Оплата по договору", "За товар", "Услуги по акту"]),
          ...(party || rng.chance(0.5) ? {} : { innZero: true as const }),
        };
      });
      const statement: BankStatement = {
        fileName: "s.xlsx",
        sheet: "s",
        account: "20208000100438330001",
        payments,
        issues: [],
        columns: {},
        convention: "",
      };
      // Some payments are already in 1C.
      const existing: [string, string, number][] = [];
      for (const p of payments) {
        const party = w.parties.find((x) => x.inn === p.inn);
        if (party && rng.chance(0.15))
          existing.push([
            p.direction === "in"
              ? "Документ.ПоступлениеНаРасчетныйСчет"
              : "Документ.СписаниеСРасчетногоСчета",
            party.ref,
            p.amount / 100,
          ]);
      }
      const out = await resolvePayments(statement, { createMissing: true }, deps(w, existing));

      tally.ready += out.ready.length;
      tally.already += out.alreadyIn1c.length;
      tally.problems += out.problems.length;
      tally.missing += out.missing.length;
      const where = new Map<number, string[]>();
      const put = (row: number, what: string) => where.set(row, [...(where.get(row) ?? []), what]);
      for (const r of out.ready) put(r.payment.row, r.part === "commission" ? "commission" : "ready");
      for (const r of out.alreadyIn1c) put(r, "already");
      for (const p of out.problems) for (const r of p.rows) put(r, "problem");
      for (const m of out.missing) for (const r of m.rows) put(r, "missing");
      for (const c of out.contractsToCreate) for (const r of c.rows) put(r, "contract");
      for (const p of payments) {
        const got = (where.get(p.row) ?? []).filter((x) => x !== "commission");
        if (got.length !== 1) bad.push(`#${i} row ${p.row}: ${got.join("+") || "nowhere"}`);
      }
      for (const r of out.ready) {
        const p = r.payment;
        const f = r.change.fields ?? {};
        const object =
          p.direction === "in" ? "Документ.ПоступлениеНаРасчетныйСчет" : "Документ.СписаниеСРасчетногоСчета";
        if (r.change.object !== object)
          bad.push(`#${i} row ${p.row}: wrong kind of document ${r.change.object}`);
        if (f["Дата"] !== p.date) bad.push(`#${i} row ${p.row}: date ${String(f["Дата"])}`);
        if (r.part !== "commission" && f["СуммаДокумента"] !== p.amount / 100)
          bad.push(`#${i} row ${p.row}: amount ${String(f["СуммаДокумента"])} for ${p.amount / 100}`);
        const party = w.parties.find((x) => x.inn === p.inn);
        const who = (f["Контрагент"] as { ref?: string } | undefined)?.ref;
        const contract = (f["ДоговорКонтрагента"] as { ref?: string } | undefined)?.ref;
        if (party && who !== party.ref)
          bad.push(`#${i} row ${p.row}: counterparty ${String(who)} not ${party.ref}`);
        if (party && contract && contract !== party.contract)
          bad.push(`#${i} row ${p.row}: another counterparty's contract`);
        const rowsOf = (r.change.tables?.["РасшифровкаПлатежа"] ?? []) as Record<string, number>[];
        const sum = rowsOf.reduce((s, x) => s + (x["СуммаПлатежа"] ?? 0), 0);
        if (r.part !== "commission" && rowsOf.length > 0 && Math.abs(sum - p.amount / 100) > 0.005)
          bad.push(`#${i} row ${p.row}: breakdown ${sum} for ${p.amount / 100}`);
      }
      if (bad.length > 12) break;
    }
    expect(bad.slice(0, 10), `${bad.length} problems`).toEqual([]);
    // The generator really exercises every outcome.
    for (const [what, count] of Object.entries(tally)) expect(count, what).toBeGreaterThan(0);
  });
});
