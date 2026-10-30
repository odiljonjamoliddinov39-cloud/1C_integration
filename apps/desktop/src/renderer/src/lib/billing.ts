import { LimitCode } from "@platform/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import type { BillingView } from "../../../shared/ipc";

// AI_BUDGET_EXCEEDED: the AI credits are used up.
const LIMIT_CODES = new Set<string>([...LimitCode.options, "AI_BUDGET_EXCEEDED"]);

/** A refusal that comes from the plan's limits: it gets the "Upgrade" dialog. */
export const isLimitCode = (code: string): boolean => LIMIT_CODES.has(code);

/** The plan, its limits and what is used: kept fresh as the main process learns of changes. */
export function useBilling(): BillingView | null {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["billing"],
    queryFn: async () => (await window.platform.billing.get()) ?? (await window.platform.billing.refresh()),
    refetchInterval: 60_000,
  });
  useEffect(
    () => window.platform.billing.onChange((view) => queryClient.setQueryData(["billing"], view)),
    [queryClient],
  );
  return query.data ?? null;
}

/** AI questions left in this period, or null while the plan is not known. */
export function aiQuestionsLeft(billing: BillingView | null): { left: number; total: number } | null {
  if (!billing) return null;
  const total = billing.entitlements.aiQuestionsPerMonth;
  return { left: Math.max(0, total - billing.usage.aiQuestions), total };
}

/** The AI credits balance with the monthly credits of the plan; null when credits are not in use. */
export function aiCredits(billing: BillingView | null): { balance: number; monthly: number } | null {
  const c = billing?.credits;
  return c ? { balance: Math.max(0, Math.floor(c.balanceCredits)), monthly: c.monthlyCredits } : null;
}
