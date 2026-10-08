/**
 * What a chat looks like on screen. The main process builds it from the same events the window
 * gets, so a saved chat reopens exactly as it was shown.
 */
import type { AssistantEvent, AttachmentInfo, AuditView, Proposal, ProposalOutcome } from "./ipc.js";

export type ChatEntry =
  | { kind: "user"; text: string; files?: AttachmentInfo[] }
  | { kind: "assistant"; text: string }
  /** What the assistant said it is doing between steps. */
  | { kind: "note"; text: string }
  | { kind: "tool"; name: string; detail: string }
  | { kind: "proposal"; id: string; proposal: Proposal; outcome: ProposalOutcome | null }
  | { kind: "error"; code: string; message: string }
  /** How long the assistant worked on the task, not counting cards waiting for the user. */
  | { kind: "elapsed"; ms: number }
  /** An audit of the base: its checks and what they found. */
  | { kind: "audit"; audit: AuditView }
  | { kind: "notice"; code: string; message: string }
  /** The answer below came from a template or the cache, not the model (0 tokens). */
  | {
      kind: "route";
      route: "template" | "cache";
      question: string;
      title?: string;
      ageSeconds?: number;
      learnedCode?: string;
    };

type EntryEvent = AssistantEvent extends infer E ? (E extends unknown ? Omit<E, "companyId"> : never) : never;

/** The entries after one event; "done" changes nothing on screen. */
export function applyEvent(entries: ChatEntry[], event: EntryEvent): ChatEntry[] {
  const last = entries.at(-1);
  switch (event.type) {
    case "text":
      return last?.kind === "assistant"
        ? [...entries.slice(0, -1), { ...last, text: last.text + event.text }]
        : [...entries, { kind: "assistant", text: event.text }];
    case "progress":
      return last?.kind === "note"
        ? [...entries.slice(0, -1), { ...last, text: last.text + event.text }]
        : [...entries, { kind: "note", text: event.text }];
    case "retry": {
      // Take back what the failed attempt had written: the answer and notes after the last step.
      let keep = entries.length;
      while (keep > 0 && (entries[keep - 1]?.kind === "assistant" || entries[keep - 1]?.kind === "note"))
        keep--;
      return entries.slice(0, keep);
    }
    case "tool":
      return [...entries, { kind: "tool", name: event.name, detail: event.detail }];
    case "error":
      return [...entries, { kind: "error", code: event.code, message: event.message }];
    case "confirm":
      return [...entries, { kind: "proposal", id: event.id, proposal: event.proposal, outcome: null }];
    case "decided":
      return entries.map((e) =>
        e.kind === "proposal" && e.id === event.id ? { ...e, outcome: event.outcome } : e,
      );
    case "elapsed":
      return [...entries, { kind: "elapsed", ms: event.ms }];
    case "audit": {
      const at = entries.findLastIndex((e) => e.kind === "audit");
      const entry: ChatEntry = { kind: "audit", audit: event.audit };
      return at < 0 ? [...entries, entry] : entries.map((e, i) => (i === at ? entry : e));
    }
    case "notice":
      return [...entries, { kind: "notice", code: event.code, message: event.message }];
    case "route":
      return [
        ...entries,
        {
          kind: "route",
          route: event.route,
          question: event.question,
          ...(event.title === undefined ? {} : { title: event.title }),
          ...(event.ageSeconds === undefined ? {} : { ageSeconds: event.ageSeconds }),
          ...(event.learnedCode === undefined ? {} : { learnedCode: event.learnedCode }),
        },
      ];
    case "done":
      return entries;
  }
}
