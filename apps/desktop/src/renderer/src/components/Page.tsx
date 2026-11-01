import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** The same frame for every screen: one width, one padding, one place for the title. */
export function Page({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto w-full max-w-6xl px-8 py-8", className)}>{children}</div>;
}

/** A screen's title with its one-line explanation, and the actions that belong to the whole screen. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end gap-3">
      <div className="min-w-0">
        <h1 className="text-3xl font-extrabold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-3xl text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
