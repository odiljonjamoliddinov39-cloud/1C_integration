import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-2xl border border-border bg-card shadow-card", className)} {...props} />;
}

export function Badge({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "success" | "danger" | "warning" | "info";
  children: ReactNode;
}) {
  const tones = {
    muted: "bg-muted text-muted-foreground",
    success: "bg-success/15 text-success",
    danger: "bg-destructive/15 text-destructive",
    warning: "bg-warning/20 text-foreground",
    info: "bg-primary/10 text-primary",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-destructive/20 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive">
      {children}
    </div>
  );
}
