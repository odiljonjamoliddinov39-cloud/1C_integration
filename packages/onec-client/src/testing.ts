/**
 * An in-memory stand-in for a 1C base with the PlatformAPI extension, following the same rules
 * as onec/extension (envelopes, error codes, ExternalID deduplication). Used by tests and by the
 * desktop app's demo connector on machines without 1C.
 */
import { randomUUID } from "node:crypto";

import type {
  InvoiceReceivedInput,
  Organization,
  PlatformFunction,
  QueryResult,
  RunQueryInput,
} from "@platform/shared";

import type { PlatformTransport } from "./transport.js";

interface FakeDocument {
  ref: string;
  number: string;
  date: string;
  externalId: string;
  source: string;
  organizationRef: string;
  counterpartyRef: string;
  contractRef?: string;
  supplierNumber: string;
  lines: {
    itemRef: string;
    quantity: number;
    price: number;
    amount: number;
    vatRate: number;
    vatAmount: number;
  }[];
  posted: false;
}

class Failure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class FakePlatform implements PlatformTransport {
  organizations: Organization[] = [{ ref: randomUUID(), name: "ООО «Тест»", inn: "300000001" }];
  counterparties: { ref: string; inn: string; name: string }[] = [
    { ref: randomUUID(), inn: "123456789", name: "ООО Поставщик" },
  ];
  items: { ref: string; name: string; ikpu: string }[] = [
    { ref: randomUUID(), name: "Вода питьевая 19л", ikpu: "10202001001000000" },
  ];
  contracts: { ref: string; ownerRef: string }[] = [];
  /** Change-prohibition date (YYYY-MM-DD); documents on or before it are refused. */
  closedUntil: string | null = null;
  documents: FakeDocument[] = [];
  /**
   * Demo answers to RunQuery, picked by what the query reads (first match wins). A real 1C runs
   * the query itself; this only lets the assistant be tried without 1C.
   */
  queryAnswers: { match: RegExp; answer: () => QueryResult }[] = [
    {
      match: /Хозрасчетный/i,
      answer: () => ({
        columns: ["Счет", "СальдоДт", "СальдоКт"],
        rows: [
          ["5110 Расчетный счет", 125_000_000, 0],
          ["4010 Счета к получению от покупателей", 48_000_000, 0],
          ["6010 Счета к оплате поставщикам", 0, 36_500_000],
          ["6410 Задолженность по платежам в бюджет", 0, 9_200_000],
        ],
        truncated: false,
      }),
    },
    {
      match: /СчетФактураПолученный/i,
      answer: () => ({
        columns: ["Номер", "Дата", "Контрагент", "ExternalID"],
        rows: this.documents.map((d) => [
          d.number,
          d.date,
          this.counterparties.find((c) => c.ref === d.counterpartyRef)?.name ?? null,
          d.externalId,
        ]),
        truncated: false,
      }),
    },
    {
      match: /Контрагенты/i,
      answer: () => ({
        columns: ["Наименование", "ИНН"],
        rows: this.counterparties.map((c) => [c.name, c.inn]),
        truncated: false,
      }),
    },
    {
      match: /Номенклатура/i,
      answer: () => ({
        columns: ["Наименование", "ИКПУ"],
        rows: this.items.map((i) => [i.name, i.ikpu]),
        truncated: false,
      }),
    },
  ];
  calls: { fn: PlatformFunction; arg?: string }[] = [];
  closed = false;

  async call(fn: PlatformFunction, arg?: string): Promise<string> {
    this.calls.push({ fn, arg });
    try {
      return JSON.stringify({ ok: true, data: this.dispatch(fn, arg) });
    } catch (e) {
      if (e instanceof Failure) {
        return JSON.stringify({ ok: false, error: { code: e.code, message: e.message, details: e.details } });
      }
      throw e;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private dispatch(fn: PlatformFunction, arg?: string): unknown {
    switch (fn) {
      case "Ping":
        return {
          configuration: {
            name: "БухгалтерияДляУзбекистана",
            synonym: "Бухгалтерия для Узбекистана",
            version: "3.0.0.0",
          },
          platformVersion: "8.3.24.1342",
          extensionVersion: "0.2.0",
          infobase: 'File="FAKE";',
        };
      case "GetOrganizations":
        return this.organizations;
      case "GetMetadata":
        return [];
      case "RunQuery":
        return this.runQuery(parse(arg) as RunQueryInput);
      case "CreateInvoiceReceived":
        return this.createInvoiceReceived(parse(arg) as InvoiceReceivedInput);
    }
  }

  private runQuery(input: RunQueryInput): QueryResult {
    if (typeof input?.query !== "string" || !input.query.trim()) {
      throw new Failure("VALIDATION", "query is required");
    }
    if (!/^\s*ВЫБРАТЬ|^\s*SELECT/i.test(input.query)) {
      throw new Failure("QUERY_ERROR", "{(1, 1)}: Ожидается ключевое слово ВЫБРАТЬ");
    }
    const found = this.queryAnswers.find((q) => q.match.test(input.query));
    const result = found ? found.answer() : { columns: [], rows: [], truncated: false };
    const limit = input.limit ?? 200;
    return { ...result, rows: result.rows.slice(0, limit), truncated: result.rows.length > limit };
  }

  private createInvoiceReceived(input: InvoiceReceivedInput) {
    if (!input?.externalId || !Array.isArray(input.lines) || input.lines.length === 0) {
      throw new Failure("VALIDATION", "externalId and at least one line are required");
    }
    // Like PlatformLog in 1C: one document per source and external id.
    const existing = this.documents.find(
      (d) => d.source === input.source && d.externalId === input.externalId,
    );
    if (existing) {
      return {
        ref: existing.ref,
        number: existing.number,
        date: existing.date,
        posted: false,
        duplicate: true,
      };
    }
    const org = input.organization?.ref
      ? this.organizations.find((o) => o.ref === input.organization?.ref)
      : input.organization?.inn
        ? this.organizations.find((o) => o.inn === input.organization?.inn)
        : this.organizations.length === 1
          ? this.organizations[0]
          : undefined;
    if (!org)
      throw new Failure("ORGANIZATION_NOT_FOUND", "Organization not found; pass organization.ref or inn");
    const cp = this.counterparties.find((c) =>
      input.counterparty.ref ? c.ref === input.counterparty.ref : c.inn === input.counterparty.inn,
    );
    if (!cp) {
      throw new Failure("COUNTERPARTY_NOT_FOUND", "Counterparty not found", {
        inn: input.counterparty.inn ?? null,
      });
    }
    if (
      input.contract &&
      !this.contracts.some((c) => c.ref === input.contract?.ref && c.ownerRef === cp.ref)
    ) {
      throw new Failure("CONTRACT_NOT_FOUND", "Contract not found for this counterparty");
    }
    if (this.closedUntil && input.date <= this.closedUntil) {
      throw new Failure("CLOSED_PERIOD", `Period is closed until ${this.closedUntil}`);
    }
    const lines = input.lines.map((line, i) => {
      const item = this.items.find((it) =>
        line.item.ref
          ? it.ref === line.item.ref
          : line.item.ikpu
            ? it.ikpu === line.item.ikpu
            : it.name === line.item.name,
      );
      if (!item) throw new Failure("ITEM_NOT_FOUND", `Item of line ${i + 1} not found`, { line: i + 1 });
      return {
        itemRef: item.ref,
        quantity: line.quantity,
        price: line.price,
        amount: line.amount,
        vatRate: line.vatRate,
        vatAmount: line.vatAmount,
      };
    });
    const doc: FakeDocument = {
      ref: randomUUID(),
      number: String(this.documents.length + 1).padStart(10, "0"),
      date: `${input.date}T00:00:00`,
      externalId: input.externalId,
      source: input.source,
      organizationRef: org.ref,
      counterpartyRef: cp.ref,
      contractRef: input.contract?.ref,
      supplierNumber: input.number,
      lines,
      posted: false,
    };
    this.documents.push(doc);
    return { ref: doc.ref, number: doc.number, date: doc.date, posted: false, duplicate: false };
  }
}

function parse(arg?: string): unknown {
  try {
    return JSON.parse(arg ?? "");
  } catch {
    throw new Failure("BAD_JSON", "Argument is not valid JSON");
  }
}
