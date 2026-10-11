import { describe, expect, it } from "vitest";

import { TraceBuilder } from "./trace.js";

const TODAY = new Date("2026-10-07T10:00:00Z");
const query = (name: string) =>
  `ВЫБРАТЬ Реализация ИЗ Документ.РеализацияТоваровУслуг ГДЕ Контрагент.Наименование ПОДОБНО "%${name}%"`;

/** A question answered by one query on a counterparty, then a confirmed card for exactly its rows. */
const confirmedInvoices = (question: string, name: string) => {
  const trace = new TraceBuilder();
  const rows = [
    [{ type: "Документ.РеализацияТоваровУслуг", ref: "ref-1", name: "1" }],
    [{ type: "Документ.РеализацияТоваровУслуг", ref: "ref-2", name: "2" }],
  ];
  trace.read(
    "run_query",
    { query: query(name), refs: true },
    { ok: true, data: { columns: ["Реализация"], rows, truncated: false } },
  );
  trace.propose(
    "propose_invoices_issued",
    { title: "t", sales: [{ ref: "ref-1" }, { ref: "ref-2" }] },
    { ok: true, data: { status: "done", applied: [1, 2] } },
  );
  return trace.build("Crystal", question, { ok: true }, TODAY);
};

describe("traces of questions about a counterparty", () => {
  it("carry the query with the name as a parameter, the same for every counterparty", () => {
    const a = confirmedInvoices("Texmash ga hisob-faktura yoz", "TEXMASH");
    const b = confirmedInvoices("Kapital uchun hisob-faktura yoz", "KAPITAL");
    expect(a.outcome).toBe("card_confirmed");
    expect(a.learnable).toMatchObject({
      phrase: "hisob faktura yoz",
      params: [{ name: "Контрагент", type: "counterparty" }],
      action: { tool: "propose_invoices_issued", refsColumn: 0 },
    });
    expect(a.learnable?.query).toContain("ПОДОБНО &Контрагент");
    // What was run is kept as it was; what the template will run is the same for both.
    expect(a.steps[0]?.query).toContain("TEXMASH");
    expect(a.learnable?.query).toBe(b.learnable?.query);
  });
});
