/**
 * The saved chats are what this PC already knows: every question that was asked, the queries the
 * assistant ran for it and what came back. Replayed through the same rules that watch a live question
 * (TraceBuilder), they become traces for the engine, so the questions people already paid for can
 * become templates without being asked again. Questions that needed attached files, or a card, are
 * left out; a chat is replayed once, from where it was last looked at.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import {
  type AiContentBlock,
  type AiMessage,
  CONTINUE_NOTE,
  type QueryResult,
  type TraceInput,
  isProposalTool,
} from "@platform/shared";

import type { ToolResult } from "../onec-jobs.js";
import { decodeTable } from "./toon.js";
import { TraceBuilder } from "./trace.js";

/** How many messages of each chat were already turned into traces (live, or by a replay). */
export class TraceLog {
  private marks: Record<string, number> = {};

  constructor(private readonly file: string) {
    try {
      if (existsSync(file)) this.marks = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
    } catch {
      this.marks = {};
    }
  }

  get(chatId: string): number {
    return this.marks[chatId] ?? 0;
  }

  set(chatId: string, messages: number): void {
    if (this.marks[chatId] === messages) return;
    this.marks[chatId] = messages;
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.marks));
      renameSync(tmp, this.file);
    } catch {
      /* a mark lost only means a chat is looked at again */
    }
  }
}

const blocksOf = (content: AiMessage["content"]): AiContentBlock[] => (Array.isArray(content) ? content : []);

/** The text of a user message that is a question; null for tool results, attachments and notes. */
function questionOf(message: AiMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text && text !== CONTINUE_NOTE.trim() ? text : null;
  }
  const blocks = message.content;
  if (blocks.some((b) => b.type === "tool_result")) return null;
  if (blocks.some((b) => b.type !== "text")) return null; // a file came with it
  const text = blocks
    .map((b) => String((b as { text?: unknown }).text ?? ""))
    .join("\n")
    .trim();
  return text && text !== CONTINUE_NOTE.trim() ? text : null;
}

/** A run_query result as it was kept in the chat: a TOON table (or the older JSON). */
function resultOf(block: AiContentBlock | undefined): ToolResult {
  if (!block) return { ok: false, code: "MISSING", message: "no result" };
  const raw = block.content;
  const text =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw)
        ? raw.map((b) => String((b as { text?: unknown }).text ?? "")).join("")
        : "";
  if (block.is_error === true) return { ok: false, code: "ERROR", message: text.slice(0, 200) };
  const table = decodeTable(text);
  if (table) {
    const data: QueryResult = {
      columns: table.columns,
      rows: table.rows as QueryResult["rows"],
      truncated: text.includes("[The result was cut"),
    };
    return { ok: true, data };
  }
  try {
    const json = JSON.parse(text) as Partial<QueryResult>;
    if (Array.isArray(json.columns) && Array.isArray(json.rows)) {
      return {
        ok: true,
        data: { columns: json.columns, rows: json.rows, truncated: json.truncated === true },
      };
    }
  } catch {
    /* not JSON */
  }
  return { ok: true, data: null };
}

/**
 * The traces of the questions in messages[from..]: read-only questions answered by one clean query.
 * `days` are the days a question may have been asked on (the chat's first and last), for the
 * questions whose date or month the query takes as a parameter.
 */
export function tracesFromMessages(
  messages: AiMessage[],
  from: number,
  company: string,
  days: Date[],
): TraceInput[] {
  const traces: TraceInput[] = [];
  let i = from;
  while (i < messages.length) {
    const start = messages[i];
    const question = start ? questionOf(start) : null;
    if (!start || question === null) {
      i += 1;
      continue;
    }
    // Everything up to the next question belongs to this one.
    let end = i + 1;
    while (end < messages.length) {
      const next = messages[end];
      if (next && questionOf(next) !== null) break;
      end += 1;
    }
    const builder = new TraceBuilder();
    let usable = true;
    const uses = new Map<string, { name: string; input: unknown }>();
    for (const message of messages.slice(i + 1, end)) {
      for (const block of blocksOf(message.content)) {
        if (message.role === "assistant" && block.type === "tool_use") {
          const name = String(block.name ?? "");
          if (isProposalTool(name as never) || name === "report_findings") usable = false;
          uses.set(String(block.id), { name, input: block.input });
        } else if (message.role === "user" && block.type === "tool_result") {
          const use = uses.get(String(block.tool_use_id));
          if (!use) continue;
          const input = use.input as { refs?: boolean } | undefined;
          if (use.name === "run_query" && input?.refs) usable = false;
          builder.read(
            use.name,
            use.input,
            use.name === "run_query" ? resultOf(block) : { ok: true, data: null },
          );
        }
      }
    }
    if (usable) {
      for (const day of days) {
        const trace = builder.build(company, question, { ok: true }, day);
        if (trace.learnable) {
          traces.push(trace);
          break;
        }
      }
    }
    i = end;
  }
  return traces;
}
