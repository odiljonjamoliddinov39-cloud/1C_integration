/**
 * The usage logger: one ai_usage row per model call (tokens, cost, route, feature, tool calls) and
 * one per answer that never reached the model, so the dashboard counts every question. The month's
 * spend of the account is added as each row is written.
 */
import { AI_PROPOSAL_TOOLS, type AiMessage, CONTINUE_NOTE } from "@platform/shared";

import type { Db } from "../db/client.js";
import { aiUsage } from "../db/schema.js";
import { addSpend } from "./budget.js";
import type { TurnUsage } from "./model.js";

export interface UsageContext {
  accountId: string;
  userId: string;
  company: string;
  feature: "chat" | "audit";
  route: "model" | "template" | "cache" | "batch";
  toolCalls: number;
  firstStep: boolean;
  question: string | null;
}

const QUESTION_CHARS = 200;

function isResultsMessage(message: AiMessage): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some((block) => (block as { type?: unknown }).type === "tool_result")
  );
}

function textOf(message: AiMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .flatMap((block) => {
      const { type, text } = block as { type?: unknown; text?: unknown };
      return type === "text" && typeof text === "string" ? [text] : [];
    })
    .join(" ");
}

/** Index of the message that started the current question: the user's last message that is not a tool result or a continuation. */
export function questionStart(messages: AiMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user" || isResultsMessage(message)) continue;
    if (textOf(message).startsWith(CONTINUE_NOTE)) continue;
    return i;
  }
  return 0;
}

/** True when the model is about to read the user's question itself (not 1C results). */
export function isFirstStep(messages: AiMessage[]): boolean {
  return questionStart(messages) === messages.length - 1;
}

export function questionOf(messages: AiMessage[]): string | null {
  const message = messages[questionStart(messages)];
  const text = message ? textOf(message).replace(/\s+/g, " ").trim() : "";
  return text ? text.slice(0, QUESTION_CHARS) : null;
}

/** 1C reads (tool calls other than proposals and the audit report) the model made in this question. */
export function readCallsInQuestion(messages: AiMessage[]): number {
  const proposals = new Set<string>([...AI_PROPOSAL_TOOLS, "report_findings"]);
  let calls = 0;
  for (const message of messages.slice(questionStart(messages))) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const block of message.content) {
      const b = block as { type?: unknown; name?: unknown };
      if (b.type === "tool_use" && typeof b.name === "string" && !proposals.has(b.name)) calls++;
    }
  }
  return calls;
}

export async function logUsage(db: Db, context: UsageContext, usage: TurnUsage): Promise<void> {
  await db.insert(aiUsage).values({ ...context, ...usage });
  await addSpend(db, context.accountId, usage.costUsd);
}

/** An answer from a template or the cache: no tokens, no cost. */
export async function logFreeAnswer(
  db: Db,
  who: { accountId: string; userId: string },
  answer: { route: "template" | "cache"; company: string; question: string },
): Promise<void> {
  await db.insert(aiUsage).values({
    accountId: who.accountId,
    userId: who.userId,
    model: answer.route,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    company: answer.company,
    feature: "chat",
    route: answer.route,
    firstStep: true,
    question: answer.question.replace(/\s+/g, " ").trim().slice(0, QUESTION_CHARS),
  });
}
