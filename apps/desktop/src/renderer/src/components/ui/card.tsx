import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-border bg-card shadow-sm", className)} {...props} />;
}

export function Badge({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "success" | "danger" | "warning";
  children: ReactNode;
}) {
  const tones = {
    muted: "bg-muted text-muted-foreground",
    success: "bg-success/15 text-success",
    danger: "bg-destructive/15 text-destructive",
    warning: "bg-warning/20 text-foreground",
  };
  return (
    <span
      className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", tones[tone])}
    >
      {children}
    </span>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{children}</div>;
}
