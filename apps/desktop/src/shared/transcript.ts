/**
 * What a chat looks like on screen. The main process builds it from the same events the window
 * gets, so a saved chat reopens exactly as it was shown.
 */
import type { AssistantEvent, AttachmentInfo, Proposal, ProposalOutcome } from "./ipc.js";

export type ChatEntry =
  | { kind: "user"; text: string; files?: AttachmentInfo[] }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; detail: string }
  | { kind: "proposal"; id: string; proposal: Proposal; outcome: ProposalOutcome | null }
  | { kind: "error"; code: string; message: string };

type EntryEvent = AssistantEvent extends infer E ? (E extends unknown ? Omit<E, "companyId"> : never) : never;

/** The entries after one event; "done" changes nothing on screen. */
export function applyEvent(entries: ChatEntry[], event: EntryEvent): ChatEntry[] {
  const last = entries.at(-1);
  switch (event.type) {
    case "text":
      return last?.kind === "assistant"
        ? [...entries.slice(0, -1), { ...last, text: last.text + event.text }]
        : [...entries, { kind: "assistant", text: event.text }];
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
    case "done":
      return entries;
  }
}
