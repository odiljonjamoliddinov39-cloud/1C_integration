/**
 * Daily AI cost as bars, one per day. One series, so no legend: the section title names it.
 * Hovering (or focusing) a bar shows its date, cost, requests and tokens.
 */
import type { UsageDay } from "@platform/shared";
import { useState } from "react";

import { compact, usd } from "@/lib/format";

const HEIGHT = 120;

export function CostChart({ days }: { days: UsageDay[] }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(...days.map((d) => d.costUsd), 0);
  const total = days.reduce((s, d) => s + d.costUsd, 0);
  const shown = active === null ? null : days[active];
  if (max === 0)
    return <div className="py-8 text-center text-sm text-muted-foreground">No AI use in this period.</div>;

  return (
    <div>
      <div className="mb-2 flex h-5 items-baseline gap-2 text-xs text-muted-foreground">
        {shown ? (
          <>
            <span className="font-medium text-foreground">{shown.date}</span>
            <span className="tabular">{usd(shown.costUsd)}</span>
            <span className="tabular">
              {shown.requests} requests · {compact(shown.tokens)} tokens
            </span>
          </>
        ) : (
          <span className="tabular">
            Total {usd(total)} · max {usd(max)} a day
          </span>
        )}
      </div>
      <div className="relative" style={{ height: HEIGHT }} onMouseLeave={() => setActive(null)}>
        {/* Recessive guide at the maximum, so bar heights read against something. */}
        <div className="absolute inset-x-0 top-0 border-t border-dashed border-border" />
        <div className="absolute inset-0 flex items-end gap-[2px]">
          {days.map((d, i) => (
            <button
              key={d.date}
              type="button"
              aria-label={`${d.date}: ${usd(d.costUsd)}`}
              className="group flex h-full flex-1 items-end outline-none"
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
            >
              <span
                className="block w-full rounded-t-[4px] bg-chart transition-opacity group-hover:opacity-80 group-focus-visible:outline-2 group-focus-visible:outline-primary"
                style={{
                  height: d.costUsd > 0 ? Math.max(2, (d.costUsd / max) * HEIGHT) : 0,
                  opacity: active === null || active === i ? 1 : 0.45,
                }}
              />
            </button>
          ))}
        </div>
      </div>
      <div className="mt-1 flex justify-between border-t border-border pt-1 text-[11px] text-muted-foreground">
        <span>{days[0]?.date}</span>
        <span>{days.at(-1)?.date}</span>
      </div>
    </div>
  );
}
