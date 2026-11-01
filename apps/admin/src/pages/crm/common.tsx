import type { CallResult, CrmLeadRow } from "@platform/shared";
import { useEffect, useState } from "react";

import { t } from "@/lib/i18n";

/** A value that follows `value` a moment later: a search box asks the server once the typing pauses. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setShown(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return shown;
}

/** A stage, in the colour the admin gave it. */
export function StageBadge({ name, color }: { name: string; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: `${color}22`, color }}
    >
      <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
      {name}
    </span>
  );
}

export const CALL_RESULT_OPTIONS: { value: CallResult; label: string }[] = [
  { value: "answered", label: t("Answered") },
  { value: "no_answer", label: t("No answer") },
  { value: "busy", label: t("Busy") },
  { value: "callback", label: t("Call back later") },
  { value: "wrong_number", label: t("Wrong number") },
];

export const callResultLabel = (result: CallResult) =>
  CALL_RESULT_OPTIONS.find((o) => o.value === result)?.label ?? result;

export const leadLink = (lead: Pick<CrmLeadRow, "id">) => `crm/leads/${lead.id}`;

/** 95 → "1:35". */
export function duration(seconds: number | null): string {
  if (seconds === null) return "";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
