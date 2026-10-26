/**
 * One declaration, from what was read to what is shown. The order is the spec's:
 *
 *   1. the regime, before any amount: an unsupported one stops here with a question, and an IM 74 is never given VAT or duty;
 *   2. the importer's INN (V8) before anything else is shown: another company's declaration is not shown at all;
 *   3. every rule V1–V12, with the two numbers that disagree; a failed rule stops the run (one re-reading of the sheet is
 *      allowed when the slip may be the scan's, none when only the accountant can settle it);
 *   4. the cost allocation and the proposal of postings, which nothing writes until the accountant confirms.
 */
import type { GtdReadInput } from "@platform/shared";

import { buildDeclaration, declarationJson } from "./declaration.js";
import type { Declaration } from "./declaration.js";
import { fixed, sum } from "./decimal.js";
import type { DeclarationPages } from "./pages.js";
import { type GtdDeps, lookupContract, resolveAccounts } from "./onec.js";
import { type Proposal, emptyAccounts, propose } from "./proposal.js";
import { type GtdRecord, hasWarehouse, recordOf } from "./registry.js";
import { type Check, type ContractLookup, type Warning, knownBrv, validate, FEE } from "./validate.js";

export interface GtdRunContext {
  deps: GtdDeps;
  /** The INN of the company selected in the app. */
  companyInn: string | null;
  /** The declarations this company has read before. */
  registry: GtdRecord[];
  /** The pages of the attached PDF the declaration is in, when it has a text layer. */
  pages: DeclarationPages | null;
  /** ISO date of today. */
  today: string;
}

export type GtdOutcome =
  | { status: "unsupported_regime"; regime: Declaration["regime"]; question: string }
  | {
      status: "checks_failed" | "needs_user";
      checks: Check[];
      /** Sheets to read again as pictures, once; empty when only the accountant can settle it. */
      reread: number[];
      message: string;
    }
  | {
      status: "proposal";
      declaration: Record<string, unknown>;
      checks: Check[];
      warnings: Warning[];
      proposal: Proposal;
      accountNotes: string[];
      record: GtdRecord | null;
      message: string;
    };

const failures = (checks: Check[]) => checks.filter((c) => !c.ok);

export async function readDeclaration(input: GtdReadInput, ctx: GtdRunContext): Promise<GtdOutcome> {
  const { declaration: d, notes } = buildDeclaration(input, ctx.pages, {
    warehouse: hasWarehouse(ctx.registry),
  });

  // 1. The regime comes first.
  if (d.regime.kind === "unsupported")
    return {
      status: "unsupported_regime",
      regime: d.regime,
      question: `${d.regime.reason ?? "this regime is not handled"}. Nothing is calculated or posted: ask the accountant how this declaration is to be handled.`,
    };

  const validationContext = (contract: ContractLookup) => ({
    pages: ctx.pages,
    sheetsSeen: input.sheets_seen,
    companyInn: ctx.companyInn,
    contract,
    brv: knownBrv,
    notes,
    today: ctx.today,
  });

  // 2. Another company's declaration is not shown at all.
  {
    const first = validate(
      d,
      validationContext({ status: "unknown", detail: "not checked yet" }),
    ).checks.find((c) => c.id === "V8");
    if (first && !first.ok)
      return {
        status: "needs_user",
        checks: [first],
        reread: first.needsUser ? [] : (first.sheets ?? []),
        message: `${first.message}. Nothing from this declaration is shown or posted.`,
      };
  }

  // 3. All the rules.
  const contract = await lookupContract(ctx.deps, d.contract.no, d.exporter.name);
  const { checks, warnings } = validate(d, validationContext(contract));
  const failed = failures(checks);
  if (failed.length > 0) {
    const reread = [...new Set(failed.flatMap((c) => (c.needsUser ? [] : (c.sheets ?? []))))].sort(
      (a, b) => a - b,
    );
    const needsUser = failed.some((c) => c.needsUser) || reread.length === 0 || input.retry === true;
    return {
      status: needsUser ? "needs_user" : "checks_failed",
      checks,
      reread: needsUser ? [] : reread,
      message: needsUser
        ? `Stop: ${failed.map((c) => `${c.id} ${c.message}`).join("; ")}. Nothing is posted on a failed check: ask the accountant.`
        : `${failed.map((c) => `${c.id} ${c.message}`).join("; ")}. Read sheet ${reread.join(", ")} again as a picture, once, and call gtd_declaration again with retry true; if it fails again the accountant is asked.`,
    };
  }

  // 4. The proposal.
  const accounted =
    d.regime.kind === "customs_warehouse"
      ? await resolveAccounts(ctx.deps, { exporter: d.exporter.name, today: ctx.today })
      : { accounts: emptyAccounts(), notes: [] as string[] };
  const proposal = propose(d, accounted.accounts);
  const feeAmounts = d.charges.flatMap((c) => (c.type === FEE && c.amount ? [c.amount] : []));
  const fee = feeAmounts.length > 0 ? fixed(sum(feeAmounts), 2) : null;
  const record = recordOf(d, proposal.fee?.total ?? fee);
  return {
    status: "proposal",
    declaration: declarationJson(
      d,
      checks.map((c) => ({ rule: c.rule, ok: c.ok })),
    ),
    checks,
    warnings,
    proposal,
    accountNotes: accounted.notes,
    record,
    message:
      "All rules V1–V12 passed. The proposal is for the accountant to confirm; nothing is written to 1C.",
  };
}
