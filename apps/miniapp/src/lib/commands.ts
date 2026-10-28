/** Helpers for requests in flight: when one is finished, how to poll it, what to show for it. */
import type { CommandView, ProposalCard } from "@platform/shared";

import type { Api } from "./api.js";

export const TERMINAL = new Set<CommandView["state"]>(["done", "failed", "expired", "cancelled"]);
export const isTerminal = (state: CommandView["state"]) => TERMINAL.has(state);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * Follows a request until it ends, calling `onUpdate` with each state. The wait grows from 1.5 s to 5 s, so a PC that is
 * off costs few calls. Stops quietly when `signal` aborts (the screen closed); a failed poll is tried again.
 */
export async function follow(
  api: Pick<Api, "command">,
  id: string,
  onUpdate: (view: CommandView) => void,
  signal?: AbortSignal,
  wait: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
): Promise<CommandView | null> {
  let delay = 1500;
  while (!signal?.aborted) {
    try {
      const view = await api.command(id);
      onUpdate(view);
      if (isTerminal(view.state)) return view;
    } catch {
      // A dropped connection is not the request failing: ask again.
    }
    await wait(delay, signal);
    delay = Math.min(delay + 500, 5000);
  }
  return null;
}

/** "12.3 KB" */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The result of a done request, if it has the shape the screen expects. */
export function resultOf<T>(view: CommandView | undefined, guard: (value: unknown) => value is T): T | null {
  return view?.state === "done" && guard(view.result) ? view.result : null;
}

export const isChatResult = (
  v: unknown,
): v is { reply: string; cards: { id: string }[]; set_aside?: number } =>
  typeof v === "object" && v !== null && typeof (v as { reply?: unknown }).reply === "string";
export const isCardsResult = (v: unknown): v is { cards: ProposalCard[] } =>
  typeof v === "object" && v !== null && Array.isArray((v as { cards?: unknown }).cards);
export const isApplyResult = (
  v: unknown,
): v is { created: number; skipped: number; refused: number; reasons: string[] } =>
  typeof v === "object" && v !== null && typeof (v as { created?: unknown }).created === "number";
export const isSummary = (v: unknown): v is { summary: string } =>
  typeof v === "object" && v !== null && typeof (v as { summary?: unknown }).summary === "string";
export const isStatus = (
  v: unknown,
): v is { onec_reachable: boolean; company: string; app_version: string; last_import: string | null } =>
  typeof v === "object" && v !== null && typeof (v as { app_version?: unknown }).app_version === "string";
