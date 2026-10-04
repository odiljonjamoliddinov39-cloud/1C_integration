import { describe, expect, it } from "vitest";

import { PlatformApiClient } from "./client.js";
import { ComTransport } from "./com-transport.js";
import { OneCError } from "./errors.js";
import { FakePlatform } from "./testing.js";
import type { PlatformTransport } from "./transport.js";

const invoice = {
  externalId: "didox-1",
  source: "didox" as const,
  number: "45",
  date: "2026-10-01",
  counterparty: { inn: "123456789" },
  lines: [
    {
      item: { ikpu: "10202001001000000" },
      quantity: 2,
      price: 10000,
      amount: 20000,
      vatRate: 12,
      vatAmount: 2400,
      total: 22400,
    },
  ],
};

function setup() {
  const fake = new FakePlatform();
  return { fake, client: new PlatformApiClient(fake) };
}

describe("PlatformApiClient", () => {
  it("pings and lists organizations", async () => {
    const { client } = setup();
    expect((await client.ping()).configuration.version).toBe("3.0.0.0");
    expect((await client.getOrganizations())[0]?.inn).toBe("300000001");
  });

  it("writes an unposted invoice once; the same externalId returns the same document", async () => {
    const { client, fake } = setup();
    const first = await client.createInvoiceReceived(invoice);
    expect(first).toMatchObject({ posted: false, duplicate: false });
    const again = await client.createInvoiceReceived(invoice);
    expect(again).toMatchObject({ ref: first.ref, duplicate: true });
    expect(fake.documents).toHaveLength(1);
  });

  it("turns 1C errors into structured OneCErrors", async () => {
    const { client, fake } = setup();
    await expect(
      client.createInvoiceReceived({ ...invoice, counterparty: { inn: "999999999" } }),
    ).rejects.toMatchObject({
      code: "COUNTERPARTY_NOT_FOUND",
      details: { inn: "999999999" },
    });
    fake.closedUntil = "2026-10-31";
    await expect(client.createInvoiceReceived(invoice)).rejects.toMatchObject({ code: "CLOSED_PERIOD" });
  });

  it("runs read-only queries with a row limit, and reports query errors", async () => {
    const { client } = setup();
    const balances = await client.runQuery({
      query: "ВЫБРАТЬ Счет, СуммаОстатокДт ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки",
      limit: 2,
    });
    expect(balances.columns).toContain("Счет");
    expect(balances).toMatchObject({ truncated: true });
    expect(balances.rows).toHaveLength(2);
    await expect(client.runQuery({ query: "УДАЛИТЬ ВСЁ" })).rejects.toMatchObject({ code: "QUERY_ERROR" });
    await expect(client.runQuery({ query: "  " })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("validates before calling 1C", async () => {
    const { client, fake } = setup();
    const bad = { ...invoice, lines: [{ ...invoice.lines[0]!, total: 1 }] };
    await expect(client.createInvoiceReceived(bad)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects answers that are not the agreed envelope", async () => {
    const answers = ["not json", '{"something": 1}', '{"ok": true, "data": {"configuration": 1}}'];
    for (const answer of answers) {
      const transport: PlatformTransport = { call: async () => answer, close: async () => {} };
      const error = await new PlatformApiClient(transport).ping().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OneCError);
      expect((error as OneCError).code).toBe("BAD_RESPONSE");
    }
  });
});

describe("ComTransport", () => {
  it.skipIf(process.platform === "win32")("explains that COM needs Windows", () => {
    expect(() => ComTransport.connect({ infobase: { file: "D:\\x" } })).toThrow(
      expect.objectContaining({ code: "COM_UNAVAILABLE" }),
    );
  });
});
