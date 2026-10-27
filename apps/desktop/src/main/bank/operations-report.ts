/** What the program tells the accountant about the operations of its bank documents: the cases, the decisions, what checks found. */
import { BANK_CASES } from "@platform/shared";

import { type OperationMemory } from "./operations.js";

const WHAT: Record<(typeof BANK_CASES)[number], string> = {
  fee: "a bank fee",
  transferOut: "money paid to another account of the company",
  transferIn: "money received from another account of the company",
  conversionOut: "the paying leg of a currency conversion",
  conversionIn: "the receiving leg of a currency conversion",
  tax: "a payment to the budget",
  cashIn: "cash paid into the account",
  cashOut: "cash taken out of the account",
  capital: "a founder's contribution to the charter capital",
};

export const BANK_OPERATION_CASES = BANK_CASES.map((c) => ({ case: c, is: WHAT[c] }));

export function describeOperations(memory: OperationMemory) {
  return {
    decisions: memory.choices,
    seenPosting: memory.verdicts.map((v) => ({
      case: v.case,
      operation: v.operation,
      rightEntries: v.good,
      wrongEntries: v.bad,
      ...(v.lastBad ? { lastWrong: v.lastBad } : {}),
      used: v.bad > 0 && v.bad >= v.good ? "no (it posted wrong entries from here)" : "yes",
    })),
  };
}
