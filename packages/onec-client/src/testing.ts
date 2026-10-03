/**
 * An in-memory stand-in for a 1C base with the PlatformAPI extension, following the same rules
 * as onec/extension (envelopes, error codes, ExternalID deduplication). Used by tests and by the
 * desktop app's demo connector on machines without 1C.
 */
import { randomUUID } from "node:crypto";

import type { InvoiceReceivedInput, Organization, PlatformFunction } from "@platform/shared";

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
          extensionVersion: "0.1.0",
          infobase: 'File="FAKE";',
        };
      case "GetOrganizations":
        return this.organizations;
      case "GetMetadata":
        return [];
      case "CreateInvoiceReceived":
        return this.createInvoiceReceived(parse(arg) as InvoiceReceivedInput);
    }
  }

  private createInvoiceReceived(input: InvoiceReceivedInput) {
    if (!input?.externalId || !Array.isArray(input.lines) || input.lines.length === 0) {
      throw new Failure("VALIDATION", "externalId and at least one line are required");
    }
    const existing = this.documents.find((d) => d.externalId === input.externalId);
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
