import {
  CreateInvoiceResult,
  Envelope,
  InvoiceReceivedInput,
  MetadataObject,
  Organization,
  PingResult,
  type PlatformFunction,
  QueryResult,
  RunQueryInput,
} from "@platform/shared";
import { z } from "zod";

import { OneCError } from "./errors.js";
import type { PlatformTransport } from "./transport.js";

/** Typed calls to the PlatformAPI extension. Validates what goes in and what comes back. */
export class PlatformApiClient {
  constructor(private readonly transport: PlatformTransport) {}

  ping(): Promise<PingResult> {
    return this.invoke("Ping", PingResult);
  }

  getOrganizations(): Promise<Organization[]> {
    return this.invoke("GetOrganizations", z.array(Organization));
  }

  /** Attributes and tabular sections of the given objects, e.g. ["Документ.СчетФактураПолученный"]. */
  getMetadata(fullNames: string[]): Promise<MetadataObject[]> {
    return this.invoke("GetMetadata", z.array(MetadataObject), { objects: fullNames });
  }

  /** Runs a read-only 1C query with the 1C user's rights; at most `limit` rows come back. */
  async runQuery(input: RunQueryInput): Promise<QueryResult> {
    const parsed = RunQueryInput.safeParse(input);
    if (!parsed.success) {
      throw new OneCError("VALIDATION", "Query does not pass validation", { issues: parsed.error.issues });
    }
    return this.invoke("RunQuery", QueryResult, parsed.data);
  }

  /** Writes one unposted Счет-фактура полученный. A repeated externalId returns the existing one. */
  async createInvoiceReceived(input: InvoiceReceivedInput): Promise<CreateInvoiceResult> {
    const parsed = InvoiceReceivedInput.safeParse(input);
    if (!parsed.success) {
      throw new OneCError("VALIDATION", "Invoice does not pass validation", { issues: parsed.error.issues });
    }
    return this.invoke("CreateInvoiceReceived", CreateInvoiceResult, parsed.data);
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  private async invoke<T>(fn: PlatformFunction, schema: z.ZodType<T>, arg?: unknown): Promise<T> {
    const raw = await this.transport.call(fn, arg === undefined ? undefined : JSON.stringify(arg));
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new OneCError("BAD_RESPONSE", `${fn} did not return JSON`, { raw: raw.slice(0, 500) });
    }
    const envelope = Envelope.safeParse(json);
    if (!envelope.success) {
      throw new OneCError("BAD_RESPONSE", `${fn} returned an unexpected shape`, { raw: raw.slice(0, 500) });
    }
    if (!envelope.data.ok) {
      const { code, message, details } = envelope.data.error;
      throw new OneCError(code, message, details);
    }
    const data = schema.safeParse(envelope.data.data);
    if (!data.success) {
      throw new OneCError("BAD_RESPONSE", `${fn} returned data that does not match the contract`, {
        issues: data.error.issues,
      });
    }
    return data.data;
  }
}
