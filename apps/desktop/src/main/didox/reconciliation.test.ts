import { describe, expect, it } from "vitest";

import { partyFromProfile } from "./outgoing.js";
import { buildReconciliation, parseContract, readReconciliationAct } from "./reconciliation.js";

const seller = partyFromProfile("303212825", { name: "CRYSTAL WATER TRADE MCHJ" })!;
const buyer = partyFromProfile("310561634", { name: "ZARKENTRADE MAS'ULIYATI CHEKLANGAN JAMIYAT" })!;

/** The act as 1C's get_object gives it (the card of the real one: one row of the organization's side). */
function snapshot(over: Record<string, unknown> = {}, tables?: Record<string, Record<string, unknown>[]>) {
  return {
    fields: {
      Номер: "0000-000013",
      Дата: "2026-10-19T00:00:00",
      ДатаНачала: "2026-01-01T00:00:00",
      ДатаОкончания: "2026-10-19T00:00:00",
      Контрагент: { type: "Справочник.Контрагенты", ref: "x", name: '"Zarkentrade" Mchj' },
      ДоговорКонтрагента: "№85 от 30.12.2025",
      ...over,
    },
    tables: tables ?? {
      ПоДаннымОрганизации: [
        {
          ДебетРегл: 10000000,
          Дебет: 10000000,
          Представление: "Списание с расчетного счета 0000-000000000336 от 28.01.2026",
          Дата: "2026-01-28T00:00:06",
          Договор: "№85 от 30.12.2025",
        },
      ],
      ПоДаннымКонтрагента: [],
    },
  };
}

describe("contract as 1C shows it", () => {
  it("is read into number and date", () => {
    expect(parseContract("№85 от 30.12.2025")).toEqual({ number: "85", date: "2025-12-30" });
    expect(parseContract({ name: "№ ДГ-7/1 от 01.02.2026" })).toEqual({
      number: "ДГ-7/1",
      date: "2026-02-01",
    });
    expect(parseContract("без договора")).toBeNull();
  });
});

describe("the act read from 1C", () => {
  it("takes the number, date, period, contract and rows from the document", () => {
    const read = readReconciliationAct(snapshot());
    if (!read.ok) throw new Error(JSON.stringify(read.problems));
    expect(read.act).toMatchObject({
      number: "0000-000013",
      date: "2026-10-19",
      from: "2026-01-01",
      to: "2026-10-19",
      counterparty: '"Zarkentrade" Mchj',
      contract: { number: "85", date: "2025-12-30" },
    });
    expect(read.act.ownerRows).toEqual([
      {
        date: "2026-01-28",
        name: "Списание с расчетного счета 0000-000000000336 от 28.01.2026",
        debit: 1_000_000_000,
        credit: 0,
        contract: { number: "85", date: "2025-12-30" },
      },
    ]);
  });

  it("names what the act lacks", () => {
    const read = readReconciliationAct(
      snapshot({ ДатаНачала: null, ДоговорКонтрагента: "" }, { ПоДаннымОрганизации: [] }),
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems.map((p) => p.code)).toEqual(["NO_PERIOD", "NO_ROWS", "NO_CONTRACT"]);
  });
});

describe("the Didox body of the act", () => {
  const act = (() => {
    const read = readReconciliationAct(snapshot());
    if (!read.ok) throw new Error("act");
    return read.act;
  })();

  it("works every balance out itself, from the opening balance and the rows", () => {
    const built = buildReconciliation(
      act,
      seller,
      buyer,
      [{ ownerDebit: 500, partnerCredit: 20 }],
      undefined,
    );
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    const { body, preview } = built.built;
    expect(body).toMatchObject({
      VerificationActDoc: { VerificationActNo: "0000-000013", VerificationActDate: "2026-10-19" },
      OwnerTin: "303212825",
      PartnerTin: "310561634",
      OpenBalance: { OwnerDebit: 500, PartnerCredit: 20 },
      TurnoverBalance: { OwnerDebit: 10_000_000, OwnerCredit: 0 },
      // 500 + 10 000 000 on the debit side; the counterparty's side is a credit of 20 with no turnover.
      CloseBalance: { OwnerDebit: 10_000_500, OwnerCredit: 0, PartnerDebit: 0, PartnerCredit: 20 },
    });
    const contract = (body.VerificationActContracts as Record<string, unknown>[])[0];
    expect(contract).toMatchObject({ ContractNo: "85", ContractDate: "2025-12-30" });
    expect((contract?.VerificationActContractItems as Record<string, unknown>[])[0]).toMatchObject({
      OwnerOperationDate: "2026-01-28",
      OwnerDebit: 10_000_000,
      PartnerOperationName: "",
    });
    expect(preview.close).toEqual({
      ownerDebit: "10000500.00",
      ownerCredit: "0.00",
      partnerDebit: "0.00",
      partnerCredit: "20.00",
    });
    expect(preview.warnings).toEqual([expect.stringContaining("counterparty's side")]);
  });

  it("turns a negative balance into a credit", () => {
    const credit = { ...act, ownerRows: [{ ...act.ownerRows[0]!, debit: 0, credit: 30000 }] };
    const built = buildReconciliation(credit, seller, buyer, [], undefined);
    if (!built.ok) throw new Error("built");
    expect(built.built.preview.close).toMatchObject({ ownerDebit: "0.00", ownerCredit: "300.00" });
  });

  it("splits rows by contract and wants an opening balance for each contract of several", () => {
    const two = {
      ...act,
      ownerRows: [
        act.ownerRows[0]!,
        { ...act.ownerRows[0]!, contract: { number: "90", date: "2026-02-01" }, debit: 0, credit: 5000 },
      ],
    };
    const noContract = buildReconciliation(two, seller, buyer, [{ ownerDebit: 1 }], undefined);
    expect(noContract).toMatchObject({ ok: false, problems: [{ code: "OPENING_CONTRACT" }] });
    const built = buildReconciliation(two, seller, buyer, [{ contract: "90", ownerDebit: 100 }], undefined);
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    expect(
      built.built.preview.contracts.map((c) => [c.number, c.close.ownerDebit, c.close.ownerCredit]),
    ).toEqual([
      ["85", "10000000.00", "0.00"],
      ["90", "50.00", "0.00"],
    ]);
    expect(built.built.preview.close.ownerDebit).toBe("10000050.00");
    const unknown = buildReconciliation(two, seller, buyer, [{ contract: "99" }], undefined);
    expect(unknown).toMatchObject({ ok: false, problems: [{ code: "OPENING_CONTRACT" }] });
  });

  it("warns when the counterparty's name in 1C is not Didox's company", () => {
    const other = partyFromProfile("111111111", { name: "BOSHQA MCHJ" })!;
    const built = buildReconciliation(act, seller, other, [], undefined);
    if (!built.ok) throw new Error("built");
    expect(built.built.preview.warnings[0]).toContain("check the INN");
  });
});
