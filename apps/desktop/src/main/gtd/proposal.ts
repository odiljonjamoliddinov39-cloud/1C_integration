/**
 * The 1C postings a declaration leads to, as a proposal and nothing more: the entries with their roles, the accounts the base
 * itself uses for those roles, and the amounts. Nothing is written until the accountant confirms, and the program never invents
 * an account: a role whose account the base does not show stays open, with the account the spec expects named as a suggestion
 * only.
 *
 *   IM 74 (customs warehouse): the processing fee is the only charge. It goes into the cost of the goods (shared by item value,
 *     allocate.ts) against the customs settlement account. Import VAT and duty are NOT posted: they are deferred (V-rule of §4).
 *   IM 40: duty, excise, fee and import VAT. Not coded yet: a sample is needed (the spec's §9); the proposal says so.
 */
import { allocateCharges } from "./allocate.js";
import type { Declaration } from "./declaration.js";
import { type Dec, ZERO, fixed, isZero, sum } from "./decimal.js";
import { FEE } from "./validate.js";

export interface AccountRole {
  /** What the account is for. */
  role: string;
  /** The account's code, as the base uses it; null while the base has not shown one. */
  code: string | null;
  /** How the code is known: «base» (read from posted documents) or null. */
  source: "base" | null;
  evidence?: string;
  /** What the spec expects for the role; never used as the account. */
  suggested?: string;
}

export interface GtdAccounts {
  goods: AccountRole;
  customsSettlement: AccountRole;
  bank: AccountRole;
  foreignSupplier: AccountRole;
}

export const emptyAccounts = (): GtdAccounts => ({
  goods: { role: "cost of the goods", code: null, source: null, suggested: "2910" },
  customsSettlement: { role: "customs payments settlement", code: null, source: null },
  bank: { role: "bank", code: null, source: null, suggested: "5110" },
  foreignSupplier: { role: "foreign supplier settlements", code: null, source: null, suggested: "6015" },
});

export interface Entry {
  step: number;
  event: string;
  debit: AccountRole | null;
  credit: AccountRole | null;
  /** Soums, two decimals; null for an entry another flow writes. */
  amount: string | null;
  /** The entry's amount per item (cost allocation). */
  perItem?: { no: number; amount: string }[];
  /**
   * ready: both accounts are known from the base.
   * confirm: an account is open: the accountant names it from a posted example before anything is written.
   * existing_flow / bank_statement: not written by this declaration (shown for the whole picture).
   * none: no posting, by rule.
   */
  status: "ready" | "confirm" | "existing_flow" | "bank_statement" | "none";
  note?: string;
}

export interface Proposal {
  kind: Declaration["regime"]["kind"];
  entries: Entry[];
  /** The fee total in soums, and what the items' shares add up to. */
  fee: { total: string; allocated: string } | null;
  /** Lines of the declaration the proposal leaves out on purpose, and why. */
  excluded: string[];
  /** Decisions the accountant still owns (spec §9). */
  open: string[];
}

const READY = (a: AccountRole | null) => a?.code != null;

const OPEN_QUESTIONS = [
  "Is regime code 74 the customs warehouse in the official classifier? (confirm before release)",
  "How are IM 74 goods kept apart in 1C: a dedicated «customs warehouse» or a batch attribute?",
  "Which exchange rate is the cost base: the declaration's (graph 23) or the central bank's on the receipt date, and where does the difference go?",
];

export function propose(d: Declaration, accounts: GtdAccounts): Proposal {
  const kind = d.regime.kind;
  const excluded: string[] = [];
  if (kind === "customs_warehouse") {
    const fees = d.charges.filter((c) => c.type === FEE && c.amount && !isZero(c.amount));
    for (const c of d.charges)
      if (c.type !== FEE)
        excluded.push(
          `graph 47 line ${c.type}${c.amount ? ` (${fixed(c.amount, 2)})` : ""}: an IM 74 declaration posts only the fee; duty, excise and VAT are deferred`,
        );
    const items = d.items.flatMap((i) => (i.value ? [{ no: i.no, value: i.value }] : []));
    const shared = allocateCharges(
      fees.map((c) => ({ amount: c.amount as Dec, itemNo: c.item_no })),
      items,
    );
    const total = shared?.total ?? ZERO;
    const entries: Entry[] = [
      {
        step: 1,
        event: "Goods bought from the foreign supplier (the invoice)",
        debit: { ...accounts.goods },
        credit: { ...accounts.foreignSupplier },
        amount: null,
        status: "existing_flow",
        note: `${d.invoice.currency ?? ""} ${d.invoice.amount ? fixed(d.invoice.amount, 2) : ""} at the rate of the receipt date: the goods receipt is the existing flow, not written from this declaration`,
      },
    ];
    if (shared && !isZero(total)) {
      const sharesOf = shared.perItem.filter((s) => !isZero(s.amount));
      const debit = { ...accounts.goods };
      const credit = { ...accounts.customsSettlement };
      entries.push({
        step: 2,
        event: `IM 74 declaration ${d.declaration_no ?? ""}: customs fee`,
        debit,
        credit,
        amount: fixed(total, 2),
        perItem: sharesOf.map((s) => ({ no: s.no, amount: fixed(s.amount, 2) })),
        status: READY(debit) && READY(credit) ? "ready" : "confirm",
        note: "added to the cost of the items, shared by their value",
      });
      entries.push({
        step: 3,
        event: "Payment of the fee from the bank to the customs transit account",
        debit: { ...accounts.customsSettlement },
        credit: { ...accounts.bank },
        amount: fixed(total, 2),
        status: "bank_statement",
        note: "comes from the bank statement (the 29801 prefix), entered by the bank flow; shown to match the fee",
      });
    }
    entries.push({
      step: 4,
      event: "IM 74: import VAT and duty",
      debit: null,
      credit: null,
      amount: "0.00",
      status: "none",
      note: "no posting: deferred while the goods are in the customs warehouse (graph 50 sets the deadline)",
    });
    return {
      kind,
      entries,
      fee: shared
        ? { total: fixed(total, 2), allocated: fixed(sum(shared.perItem.map((s) => s.amount)), 2) }
        : null,
      excluded,
      open: OPEN_QUESTIONS,
    };
  }
  // IM 40 and anything else that reached this point: nothing is proposed without a sample (spec §9).
  const known = kind === "release_for_consumption" || kind === "release_from_warehouse";
  return {
    kind,
    entries: [],
    fee: null,
    excluded: known
      ? [
          "an IM 40 declaration (duty, excise, fee and import VAT, or the release of IM 74 goods) is read and checked but not posted: its postings are coded after a second sample declaration is seen",
        ]
      : [],
    open: OPEN_QUESTIONS,
  };
}

/** Whether a proposal has anything an accountant can confirm. */
export const hasEntries = (p: Proposal) =>
  p.entries.some((e) => e.status === "ready" || e.status === "confirm");
