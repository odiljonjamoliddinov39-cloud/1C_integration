/**
 * The journal of operations (the plan's `operations` and `operation_steps`): what was asked, the steps taken, where
 * each decision came from, how long each took and how it ended; and the accountant's corrections, which are the data
 * a small model will later learn from. Kept per company, the newest operations only.
 */
import type { DecisionSource } from "./posting-rules.js";

export interface OperationStep {
  function: string;
  /** What the step worked from (a period, a document number): short, no secrets. */
  input?: string;
  decision: DecisionSource;
  durationMs: number;
  error?: string;
}

export type OperationStatus = "dry_run" | "awaiting_approval" | "done" | "failed";

export interface Operation {
  id: string;
  intent: string;
  steps: OperationStep[];
  status: OperationStatus;
  approvedBy?: string;
  createdAt: string;
}

export interface Correction {
  operationId: string;
  step: string;
  before: string;
  after: string;
  user: string;
  createdAt: string;
}

export const MAX_OPERATIONS = 200;
export const MAX_CORRECTIONS = 500;

/** The one place an operation is made, so every one has the same shape. */
export function newOperation(
  intent: string,
  steps: OperationStep[],
  status: OperationStatus,
  now: Date = new Date(),
  id: string = crypto.randomUUID(),
): Operation {
  return { id, intent: intent.slice(0, 200), steps, status, createdAt: now.toISOString() };
}

export function failedStep(fn: string, started: number, error: string, now = Date.now()): OperationStep {
  return { function: fn, decision: "rule", durationMs: now - started, error: error.slice(0, 300) };
}
