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

  it("previews and issues an invoice on the basis of a sale, once per sale", async () => {
    const { client, fake } = setup();
    const sale = { number: "123", date: "2026-10-01" }; // short number: matched by its ending
    const preview = await client.previewInvoiceIssued({ sale });
    expect(preview).toMatchObject({
      sale: { number: "0000-000123", counterparty: "ООО «Покупатель»", amount: 11_200_000, posted: true },
      existing: null,
    });
    const first = await client.createInvoiceIssued({ sale: { ref: preview.sale.ref } });
    expect(first).toMatchObject({ posted: false, duplicate: false });
    expect(await client.createInvoiceIssued({ sale })).toMatchObject({ ref: first.ref, duplicate: true });
    expect((await client.previewInvoiceIssued({ sale })).existing?.ref).toBe(first.ref);
    expect(fake.issued).toHaveLength(1);

    await expect(
      client.previewInvoiceIssued({ sale: { number: "999", date: "2026-10-01" } }),
    ).rejects.toMatchObject({
      code: "SALE_NOT_FOUND",
    });
    await expect(client.createInvoiceIssued({ sale: { number: "123" } })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("previews and applies a change to any object, refusing a stale version", async () => {
    const { client } = setup();
    const create = {
      action: "create" as const,
      object: "Документ.ПоступлениеНаРасчетныйСчет",
      fields: { Номер: "1" },
      post: true,
    };
    const preview = await client.previewChange(create);
    expect(preview).toMatchObject({
      action: "create",
      ref: null,
      willPost: true,
      changes: [{ field: "Номер" }],
    });
    const created = await client.applyChange(create);
    expect(created).toMatchObject({ posted: true, deletionMark: false });

    const update = {
      action: "update" as const,
      object: create.object,
      ref: created.ref!,
      fields: { Номер: "2" },
    };
    const seen = await client.previewChange(update);
    expect(seen).toMatchObject({ posted: true, willPost: true }); // a posted document is re-posted
    await client.applyChange({ ...update, version: seen.version });
    await expect(
      client.applyChange({ ...update, fields: { Номер: "3" }, version: seen.version }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await client.getObject({ object: create.object, ref: created.ref! })).toMatchObject({
      fields: { Номер: "2" },
    });

    await expect(
      client.previewChange({ action: "update", object: create.object, fields: {} }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      client.previewChange({ action: "create", object: "РегистрСведений.Курсы", fields: { a: 1 } }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
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
  /** A stand-in for winax: V83.COMConnector.Connect() returns the given connection object. */
  const fakeWinax = (connection: object) => ({
    Object: class {
      Connect() {
        return connection;
      }
    },
    release: () => undefined,
  });

  it("says the extension is missing when the base has no PlatformAPI module or function", async () => {
    const bare = ComTransport.connect({ infobase: { file: "D:\\x" } }, fakeWinax({}));
    await expect(bare.call("Ping")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const old = ComTransport.connect(
      { infobase: { file: "D:\\x" } },
      fakeWinax({ PlatformAPI: { Ping: () => "" } }),
    );
    await expect(old.call("RunQuery", "{}")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("RunQuery"),
    });
    const ok = ComTransport.connect(
      { infobase: { file: "D:\\x" } },
      fakeWinax({ PlatformAPI: { Ping: () => '{"ok":true,"data":1}' } }),
    );
    expect(await ok.call("Ping")).toBe('{"ok":true,"data":1}');
  });

  it("uses the value when winax already ran a no-argument function on read, and calls the others", async () => {
    let pings = 0;
    const calls: unknown[] = [];
    const api = {
      get Ping() {
        pings += 1;
        return '{"ok":true,"data":"pong"}';
      },
      RunQuery: (arg: string) => {
        calls.push(arg);
        return '{"ok":true,"data":2}';
      },
    };
    const transport = ComTransport.connect({ infobase: { file: "D:\\x" } }, fakeWinax({ PlatformAPI: api }));
    expect(await transport.call("Ping")).toBe('{"ok":true,"data":"pong"}');
    expect(pings).toBe(1); // run once, not twice
    expect(await transport.call("RunQuery", '{"query":"ВЫБРАТЬ 1"}')).toBe('{"ok":true,"data":2}');
    expect(calls).toEqual(['{"query":"ВЫБРАТЬ 1"}']);
  });

  it.skipIf(process.platform === "win32")("explains that COM needs Windows", () => {
    expect(() => ComTransport.connect({ infobase: { file: "D:\\x" } })).toThrow(
      expect.objectContaining({ code: "COM_UNAVAILABLE" }),
    );
  });
});
