/**
 * The trace of one finished question: which tools ran and how it ended, without the data. The
 * server's reasoner learns from these. What can only be known here, where the data is, is worked out
 * here by rules: whether the question was answered by one clean query (and as what template), and
 * whether a confirmed card's documents were exactly that query's rows.
 */
import {
  AI_PROPOSAL_TOOLS,
  type QueryResult,
  type RunQueryInput,
  type TraceInput,
  type TraceLearnable,
  type TraceStep,
} from "@platform/shared";

import type { ToolResult } from "../onec-jobs.js";
import { learnFromRun } from "./templates.js";

interface Recorded {
  step: number;
  input: RunQueryInput;
  data: QueryResult;
}

const isProposal = (name: string) => (AI_PROPOSAL_TOOLS as readonly string[]).includes(name);

/** The references in a result column, when every row of it holds one. */
function refsOf(data: QueryResult, column: number): string[] | null {
  const refs: string[] = [];
  for (const row of data.rows) {
    const cell = row[column] as { ref?: unknown } | string | number | boolean | null | undefined;
    if (cell === null || typeof cell !== "object" || typeof cell.ref !== "string") return null;
    refs.push(cell.ref);
  }
  return refs;
}

const sameSet = (a: string[], b: string[]) => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((x) => right.has(x));
};

export class TraceBuilder {
  private readonly steps: TraceStep[] = [];
  private readonly queries: Recorded[] = [];
  /** Reads of 1C other than proposals, ok or not. */
  reads = 0;

  /** A read tool that ran. */
  read(name: string, input: unknown, result: ToolResult): void {
    this.reads += 1;
    if (name !== "run_query") {
      this.steps.push({ tool: name.slice(0, 60), ok: result.ok });
      return;
    }
    const query = input as RunQueryInput;
    const data = result.ok ? (result.data as QueryResult) : null;
    this.steps.push({
      tool: "run_query",
      ok: result.ok,
      query: query.query,
      ...(query.params ? { params: query.params } : {}),
      ...(query.refs ? { refs: true } : {}),
      ...(data ? { columns: data.columns, rowCount: data.rows.length, truncated: data.truncated } : {}),
    });
    if (data) this.queries.push({ step: this.steps.length - 1, input: query, data });
  }

  /** A proposal (a card) and how it ended. */
  propose(name: string, input: unknown, result: ToolResult): void {
    const data = result.ok ? (result.data as { status?: string; applied?: unknown[] } | null) : null;
    const step: TraceStep = {
      tool: name.slice(0, 60),
      ok: result.ok,
      status: result.ok ? String(data?.status ?? "done") : result.code,
      count: Array.isArray(data?.applied) ? data.applied.length : result.ok ? 1 : 0,
    };
    if (name === "propose_invoices_issued") {
      const sales = (input as { sales?: { ref?: string }[] }).sales ?? [];
      const proposed = sales.flatMap((s) => (typeof s.ref === "string" ? [s.ref] : []));
      if (proposed.length === sales.length && proposed.length > 0) {
        for (const q of this.queries) {
          for (let column = 0; column < q.data.columns.length; column++) {
            const found = refsOf(q.data, column);
            if (found && sameSet(found, proposed)) {
              step.fromQuery = { step: q.step, column };
              break;
            }
          }
          if (step.fromQuery) break;
        }
      }
    }
    this.steps.push(step);
  }

  private get proposals(): TraceStep[] {
    return this.steps.filter((s) => isProposal(s.tool));
  }

  /** How the question ended, from what happened to its cards and whether it failed. */
  outcome(ended: { ok: boolean; code?: string }): TraceInput["outcome"] {
    if (!ended.ok) return ended.code === "AI_ABORTED" ? "stopped" : "failed";
    const cards = this.proposals;
    if (cards.length === 0) return "answered";
    if (cards.some((c) => c.status === "declined_by_user")) return "card_declined";
    return cards.every((c) => c.status === "done" || c.status === "created" || c.status === "already_exists")
      ? "card_confirmed"
      : "failed";
  }

  /** The question as a template, when one clean query (and at most one confirmed card) did all of it. */
  learnable(question: string, outcome: TraceInput["outcome"], today = new Date()): TraceLearnable | null {
    const [only, ...rest] = this.queries;
    if (!only || rest.length > 0 || this.reads !== 1) return null;
    const cards = this.proposals;
    let action: TraceLearnable["action"] = null;
    if (outcome === "card_confirmed") {
      const [card, ...more] = cards;
      if (!card || more.length > 0 || card.tool !== "propose_invoices_issued" || card.status !== "done")
        return null;
      if (!card.fromQuery || card.fromQuery.step !== only.step || !only.input.refs) return null;
      action = { tool: "propose_invoices_issued", refsColumn: card.fromQuery.column };
    } else if (outcome !== "answered") {
      return null;
    }
    const learned = learnFromRun(question, only.input, only.data, today);
    if (!learned) return null;
    return {
      step: only.step,
      phrase: learned.phrase,
      params: learned.params,
      columns: learned.columns,
      action,
    };
  }

  build(
    company: string,
    question: string,
    ended: { ok: boolean; code?: string },
    today = new Date(),
  ): TraceInput {
    const outcome = this.outcome(ended);
    return {
      company,
      question: question.slice(0, 2_000),
      outcome,
      steps: this.steps.slice(0, 40),
      learnable: this.learnable(question, outcome, today),
    };
  }
}
