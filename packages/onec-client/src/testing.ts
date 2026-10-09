/**
 * An in-memory stand-in for a 1C base with the PlatformAPI extension, following the same rules
 * as onec/extension (envelopes, error codes, ExternalID deduplication). Used by tests and by the
 * desktop app's demo connector on machines without 1C.
 */
import { randomUUID } from "node:crypto";

import {
  type ApplyChangeInput,
  type ChangeInput,
  type DeleteMarkedInput,
  type DeleteMarkedPreview,
  type DeleteMarkedResult,
  EXTENSION_VERSION,
  type GetObjectInput,
  type InvoiceIssuedInput,
  type InvoiceReceivedInput,
  type Organization,
  type OtherSession,
  type PlatformFunction,
  type QueryResult,
  type RunQueryInput,
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
  /** Sales (Реализация товаров и услуг) and the invoices issued on them. */
  sales: {
    ref: string;
    number: string;
    date: string;
    counterparty: string;
    amount: number;
    posted: boolean;
  }[] = [
    {
      ref: randomUUID(),
      number: "0000-000123",
      date: "2026-10-01T15:20:00",
      counterparty: "ООО «Покупатель»",
      amount: 11_200_000,
      posted: true,
    },
  ];
  issued: { ref: string; number: string; date: string; saleRef: string }[] = [];
  /**
   * Any other document or directory item, for GetObject / PreviewChange / ApplyChange. Keyed by
   * ref; a counter stands in for 1C's data version.
   */
  objects = new Map<
    string,
    {
      object: string;
      fields: Record<string, unknown>;
      posted: boolean;
      deletionMark: boolean;
      version: number;
    }
  >();
  /** Other 1C sessions on the base: while there are any, removing marked objects answers BASE_BUSY. */
  otherSessions: OtherSession[] = [];
  /** Refs of objects other objects still refer to: removing them is refused (1C's reference control). */
  referenced = new Set<string>();
  calls: { fn: PlatformFunction; arg?: string }[] = [];
  /** Fields 1C's filling check wants, per object: empty ones come back as warnings in a preview. */
  required: Record<string, string[]> = {};
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
          extensionVersion: EXTENSION_VERSION,
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
      case "PreviewInvoiceIssued": {
        const sale = this.findSale(parse(arg) as InvoiceIssuedInput);
        const existing = this.issued.find((i) => i.saleRef === sale.ref);
        return {
          sale: { ...sale, organization: this.organizations[0]?.name ?? null },
          existing: existing ? { ref: existing.ref, number: existing.number, date: existing.date } : null,
        };
      }
      case "GetObject": {
        const input = parse(arg) as GetObjectInput;
        const found = this.objects.get(input.ref);
        if (!found || found.object !== input.object)
          throw new Failure("NOT_FOUND", `${input.object} not found`);
        return { ...this.state(input.ref), fields: found.fields, tables: {} };
      }
      case "PreviewChange":
        return this.prepareChange(parse(arg) as ChangeInput).preview;
      case "ApplyChange": {
        const input = parse(arg) as ApplyChangeInput;
        const { preview, apply } = this.prepareChange(input);
        if (input.action !== "create" && preview.version !== input.version) {
          throw new Failure("CONFLICT", "The object changed after the preview");
        }
        return this.state(apply());
      }
      case "PreviewDeleteMarked":
        return this.previewDeleteMarked(parse(arg) as DeleteMarkedInput);
      case "DeleteMarked":
        return this.deleteMarked(parse(arg) as DeleteMarkedInput);
      case "CreateInvoiceIssued": {
        const sale = this.findSale(parse(arg) as InvoiceIssuedInput);
        const existing = this.issued.find((i) => i.saleRef === sale.ref);
        if (existing) return { ...existing, saleRef: undefined, posted: false, duplicate: true };
        if (this.closedUntil && sale.date.slice(0, 10) <= this.closedUntil) {
          throw new Failure("CLOSED_PERIOD", `Period is closed until ${this.closedUntil}`);
        }
        const doc = {
          ref: randomUUID(),
          number: String(this.issued.length + 1).padStart(10, "0"),
          date: sale.date,
          saleRef: sale.ref,
        };
        this.issued.push(doc);
        return { ref: doc.ref, number: doc.number, date: doc.date, posted: false, duplicate: false };
      }
    }
  }

  /** The marked objects, by type, apart from the audit log. */
  private marked(input: DeleteMarkedInput) {
    const only = input.types ? new Set(input.types) : null;
    return [...this.objects.entries()].filter(
      ([, o]) => o.deletionMark && o.object !== "Справочник.PlatformLog" && (!only || only.has(o.object)),
    );
  }

  private groups(entries: [string, { object: string }][]) {
    const counts = new Map<string, number>();
    for (const [, o] of entries) counts.set(o.object, (counts.get(o.object) ?? 0) + 1);
    return [...counts.entries()].map(([type, count]) => ({
      type,
      presentation: type.split(".").slice(1).join("."),
      count,
    }));
  }

  private previewDeleteMarked(input: DeleteMarkedInput): DeleteMarkedPreview {
    const entries = this.marked(input);
    return { total: entries.length, types: this.groups(entries), otherSessions: this.otherSessions };
  }

  private deleteMarked(input: DeleteMarkedInput): DeleteMarkedResult {
    const entries = this.marked(input);
    if (entries.length > 0 && this.otherSessions.length > 0) {
      throw new Failure("BASE_BUSY", "Another 1C session has the base open", {
        sessions: this.otherSessions,
      });
    }
    const kept = entries.filter(([ref]) => this.referenced.has(ref));
    for (const [ref] of entries) if (!this.referenced.has(ref)) this.objects.delete(ref);
    return {
      total: entries.length,
      deleted: entries.length - kept.length,
      kept: kept.length,
      keptTypes: this.groups(kept),
      reasons: kept.length > 0 ? ["Объект используется в других объектах"] : [],
    };
  }

  private state(ref: string) {
    const o = this.objects.get(ref);
    if (!o) throw new Failure("NOT_FOUND", "Object not found");
    const name = String(o.fields["Наименование"] ?? o.fields["Номер"] ?? ref);
    return {
      object: o.object,
      ref,
      presentation: name,
      posted: o.posted,
      deletionMark: o.deletionMark,
      version: String(o.version),
    };
  }

  /** Like the extension's ПодготовитьИзменение, for plain fields only. */
  private prepareChange(input: ChangeInput) {
    if (!/^(Справочник|Документ)\./.test(input?.object ?? "")) {
      throw new Failure("VALIDATION", "Only documents and directories can be changed");
    }
    const isDocument = input.object.startsWith("Документ.");
    const existing = input.action === "create" ? undefined : this.objects.get(input.ref ?? "");
    if (input.action !== "create" && (!existing || existing.object !== input.object)) {
      throw new Failure("NOT_FOUND", `${input.object} ${input.ref} not found`);
    }
    const fields = { ...(existing?.fields ?? {}) };
    const changes = Object.entries(input.fields ?? {})
      .filter(([field, value]) => fields[field] !== value)
      .map(([field, value]) => ({ field, before: fields[field] ?? null, after: value }));
    for (const change of changes) fields[change.field] = change.after;
    const wasPosted = existing?.posted ?? false;
    const willPost =
      isDocument && (input.action === "create" || input.action === "update")
        ? (input.post ?? wasPosted)
        : false;
    const preview = {
      action: input.action,
      object: input.object,
      ref: input.ref ?? null,
      presentation: String(fields["Наименование"] ?? fields["Номер"] ?? input.object),
      posted: wasPosted,
      deletionMark: existing?.deletionMark ?? false,
      version: existing ? String(existing.version) : "",
      willPost,
      changes,
      tables: [],
      warnings:
        input.action === "create" || input.action === "update"
          ? (this.required[input.object] ?? [])
              .filter((field) => fields[field] === undefined || fields[field] === "")
              .map((field) => `Поле "${field}" не заполнено`)
          : [],
    };
    const apply = () => {
      const ref = input.ref ?? randomUUID();
      const deletionMark =
        input.action === "delete"
          ? true
          : input.action === "undelete"
            ? false
            : (existing?.deletionMark ?? false);
      this.objects.set(ref, {
        object: input.object,
        fields,
        posted: input.action === "delete" ? false : input.action === "undelete" ? wasPosted : willPost,
        deletionMark,
        version: (existing?.version ?? 0) + 1,
      });
      return ref;
    };
    return { preview, apply };
  }

  /** Like the extension: by ref, or by number (also its last digits) and day. */
  private findSale(input: InvoiceIssuedInput) {
    const sale = input?.sale;
    if (!sale) throw new Failure("VALIDATION", "sale is required");
    const found = sale.ref
      ? this.sales.filter((s) => s.ref === sale.ref)
      : this.sales.filter(
          (s) =>
            s.date.startsWith(sale.date ?? "-") &&
            (s.number === sale.number || s.number.endsWith(sale.number ?? "-")),
        );
    if (found.length !== 1 || !found[0]) {
      throw new Failure("SALE_NOT_FOUND", `Sale ${sale.number ?? sale.ref} not found`, {
        number: sale.number ?? null,
        date: sale.date ?? null,
      });
    }
    return found[0];
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
