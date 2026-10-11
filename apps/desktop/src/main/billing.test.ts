import type { EntitlementsResponse } from "@platform/shared";
import { describe, expect, it } from "vitest";

import { BillingState } from "./billing.js";
import { ControlError } from "./control-client.js";

const view = (over: Partial<EntitlementsResponse> = {}): EntitlementsResponse => ({
  entitlements: {
    plan: "free",
    status: "free",
    periodEnd: null,
    companies: 1,
    users: 1,
    importsPerMonth: 30,
    auditsPerMonth: 1,
    aiQuestionsPerMonth: 10,
    features: { excelExport: false, prioritySupport: false },
  },
  usage: {
    periodStart: "2026-10-01T00:00:00.000Z",
    companies: 1,
    users: 1,
    imports: 0,
    audits: 0,
    aiQuestions: 0,
  },
  readOnlyCompanies: [],
  canStartTrial: true,
  pendingPlan: null,
  cancelAtPeriodEnd: false,
  cabinetUrl: "https://site.example/cabinet",
  ...over,
});

function fixture(options: { limit?: string; offline?: boolean } = {}) {
  const calls: string[] = [];
  const client = {
    async registerCompany(_t: string, c: { inn: string }) {
      calls.push(`register:${c.inn}`);
      if (options.offline) throw new ControlError("OFFLINE", "no network");
      if (options.limit && c.inn !== "1")
        throw new ControlError("COMPANY_LIMIT", "Plan allows 1 company", 402);
    },
    async entitlements() {
      if (options.offline) throw new ControlError("OFFLINE", "no network");
      return view({ readOnlyCompanies: options.limit ? ["9"] : [] });
    },
    async countImport(_t: string, input: { count: number }) {
      calls.push(`import:${input.count}`);
      if (options.offline) throw new ControlError("OFFLINE", "no network");
      if (options.limit === "IMPORT_LIMIT")
        throw new ControlError("IMPORT_LIMIT", "Free plan allows 30", 402);
      return view();
    },
    async countAudit() {
      if (options.limit === "AUDIT_LIMIT") throw new ControlError("AUDIT_LIMIT", "One audit a month", 402);
      return view();
    },
  };
  const billing = new BillingState({
    session: { authorized: async () => ({ client: client as never, accessToken: "t" }) },
    companies: () => [
      { inn: "1", name: "Alfa" },
      { inn: "2", name: "Beta" },
    ],
  });
  return { billing, calls };
}

describe("BillingState", () => {
  it("connects the PC's companies and keeps the ones the server refused read-only", async () => {
    const { billing, calls } = fixture({ limit: "COMPANY_LIMIT" });
    const result = await billing.refresh();
    expect(calls).toEqual(["register:1", "register:2"]);
    expect(result?.readOnlyCompanies.sort()).toEqual(["2", "9"]);
    expect(billing.isReadOnly("2")).toBe(true);
    expect(billing.isReadOnly("1")).toBe(false);
  });

  it("refuses a document import the plan has no room for, and lets work go on offline", async () => {
    const limited = fixture({ limit: "IMPORT_LIMIT" });
    expect(await limited.billing.countImport(3, "1")).toMatchObject({ ok: false, code: "IMPORT_LIMIT" });
    const offline = fixture({ offline: true });
    expect(await offline.billing.countImport(3, "1")).toEqual({ ok: true, data: null });
    expect(await offline.billing.refresh()).toBeNull();
  });

  it("refuses a second audit in the month", async () => {
    const { billing } = fixture({ limit: "AUDIT_LIMIT" });
    expect(await billing.countAudit("1")).toMatchObject({ ok: false, code: "AUDIT_LIMIT" });
  });

  it("refuses a company the plan has no room for when it is connected", async () => {
    const { billing } = fixture({ limit: "COMPANY_LIMIT" });
    expect(await billing.registerCompany({ inn: "2", name: "Beta" })).toMatchObject({
      ok: false,
      code: "COMPANY_LIMIT",
    });
    expect(await billing.registerCompany({ inn: "1", name: "Alfa" })).toEqual({ ok: true, data: null });
  });
});
