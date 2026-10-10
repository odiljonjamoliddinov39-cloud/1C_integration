import { describe, expect, it } from "vitest";

import { Envelope, InvoiceReceivedInput } from "./platform-api.js";

const line = {
  item: { ikpu: "10202001001000000" },
  quantity: 2,
  price: 10000,
  amount: 20000,
  vatRate: 12,
  vatAmount: 2400,
  total: 22400,
};
const invoice = {
  externalId: "didox-123",
  source: "didox",
  number: "45",
  date: "2026-10-01",
  counterparty: { inn: "123456789" },
  lines: [line],
};

describe("InvoiceReceivedInput", () => {
  it("accepts a consistent invoice", () => {
    expect(InvoiceReceivedInput.parse(invoice).lines).toHaveLength(1);
  });

  it("takes service lines, and refuses another kind", () => {
    expect(
      InvoiceReceivedInput.parse({ ...invoice, lines: [{ ...line, kind: "service" }] }).lines[0]?.kind,
    ).toBe("service");
    expect(InvoiceReceivedInput.safeParse({ ...invoice, lines: [{ ...line, kind: "work" }] }).success).toBe(
      false,
    );
  });

  it("rejects arithmetic that does not add up", () => {
    const bad = { ...invoice, lines: [{ ...line, total: 22000 }] };
    const result = InvoiceReceivedInput.safeParse(bad);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["lines", 0, "total"]);
  });

  it("needs a way to find the counterparty and each item", () => {
    expect(InvoiceReceivedInput.safeParse({ ...invoice, counterparty: {} }).success).toBe(false);
    expect(InvoiceReceivedInput.safeParse({ ...invoice, lines: [{ ...line, item: {} }] }).success).toBe(
      false,
    );
    expect(InvoiceReceivedInput.safeParse({ ...invoice, counterparty: { inn: "12345" } }).success).toBe(
      false,
    );
  });
});

describe("Envelope", () => {
  it("is either data or a structured error", () => {
    expect(Envelope.parse({ ok: true, data: { a: 1 } }).ok).toBe(true);
    const err = Envelope.parse({ ok: false, error: { code: "CLOSED_PERIOD", message: "closed" } });
    expect(err.ok === false && err.error.code).toBe("CLOSED_PERIOD");
    expect(Envelope.safeParse({ ok: false }).success).toBe(false);
  });
});
