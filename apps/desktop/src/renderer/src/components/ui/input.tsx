import type { InputHTMLAttributes, LabelHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

/** The one look of a dropdown (the chevron comes from the global select style). */
export const selectClass =
  "h-10 w-full rounded-xl border border-border bg-card px-3 text-sm outline-none hover:border-primary/40 focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:opacity-60";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-xl border border-border bg-card px-3 text-sm outline-none placeholder:text-muted-foreground/70 hover:border-primary/40 focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cn("mb-1.5 block text-xs font-semibold text-muted-foreground", className)} {...props} />
  );
}
