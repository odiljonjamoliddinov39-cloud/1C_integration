/**
 * What the assistant relays to the accountant about a declaration: one plain text, made by the program from the checked data,
 * so the numbers in the answer are the program's and the model only translates and explains. English; the model answers in the
 * accountant's language.
 */
import type { AccountRole, Entry } from "./proposal.js";
import type { GtdOutcome } from "./run.js";

const role = (a: AccountRole | null) =>
  a === null
    ? "—"
    : a.code
      ? `${a.code} (${a.role})`
      : `? (${a.role}${a.suggested ? `; the spec expects ${a.suggested}, not used without a posted example` : ""})`;

const STATUS: Record<Entry["status"], string> = {
  ready: "ready: both accounts are the base's own",
  confirm: "needs the accountant to name the open account from a posted example",
  existing_flow: "the existing flow, not written from this declaration",
  bank_statement: "comes from the bank statement",
  none: "no posting",
};

export function gtdReport(outcome: GtdOutcome): string {
  if (outcome.status === "unsupported_regime")
    return `Regime ${outcome.regime.type} ${outcome.regime.code}: ${outcome.question}`;
  if (outcome.status !== "proposal") {
    const lines = outcome.checks
      .filter((c) => !c.ok)
      .map(
        (c) =>
          `${c.id} ${c.rule}: ${c.message}${c.expected ? ` (expected ${c.expected}, read ${c.actual ?? "?"})` : ""}`,
      );
    return [outcome.message, ...lines].join("\n");
  }
  const d = outcome.declaration as {
    declaration_no: string | null;
    date: string | null;
    regime: { type: string; code: string; kind: string };
    exporter: { name: string | null };
    importer: { name: string | null; inn: string | null };
    invoice: { no: string | null; currency: string | null; amount: string | null };
    fx_rate: string | null;
    customs_value_uzs: string | null;
    warehouse: { licence: string | null; release_deadline: string | null } | null;
    items: unknown[];
  };
  const lines = [
    `GTD ${d.declaration_no ?? "?"} of ${d.date ?? "?"}: regime ${d.regime.type} ${d.regime.code} (${d.regime.kind.replaceAll("_", " ")}), ${d.items.length} items.`,
    `Exporter ${d.exporter.name ?? "?"}; importer ${d.importer.name ?? "?"} (INN ${d.importer.inn ?? "?"}); invoice ${d.invoice.no ?? "?"} ${d.invoice.currency ?? ""} ${d.invoice.amount ?? "?"} at ${d.fx_rate ?? "?"} = customs value ${d.customs_value_uzs ?? "?"} UZS.`,
  ];
  if (d.warehouse)
    lines.push(
      `Warehouse ${d.warehouse.licence ?? "?"}; the goods must be placed under another regime by ${d.warehouse.release_deadline ?? "?"}.`,
    );
  const skipped = outcome.checks.filter((c) => c.skipped);
  lines.push(
    `Checks V1–V12: all passed${skipped.length ? ` (${skipped.map((c) => c.id).join(", ")} not applicable)` : ""}.`,
    ...outcome.warnings.map((w) => `${w.id}: ${w.message}`),
  );
  if (outcome.proposal.entries.length > 0) {
    lines.push("Proposal (nothing is written until the accountant confirms):");
    for (const e of outcome.proposal.entries)
      lines.push(
        `  ${e.step}. ${e.event}${e.debit || e.credit ? `: Dt ${role(e.debit)} / Kt ${role(e.credit)}` : ""}${e.amount ? `, ${e.amount} UZS` : ""} — ${e.status === "ready" || e.status === "confirm" ? `${STATUS[e.status]}${e.note ? `; ${e.note}` : ""}` : (e.note ?? STATUS[e.status])}`,
      );
    if (outcome.proposal.fee)
      lines.push(
        `  The fee ${outcome.proposal.fee.total} UZS is shared over the items by value: the shares add up to ${outcome.proposal.fee.allocated} (see the steps' perItem).`,
      );
  }
  for (const x of outcome.proposal.excluded) lines.push(`Not posted: ${x}.`);
  for (const n of outcome.accountNotes) lines.push(`Accounts: ${n}.`);
  lines.push("Open decisions for the accountant:", ...outcome.proposal.open.map((q) => `  - ${q}`));
  return lines.join("\n");
}
