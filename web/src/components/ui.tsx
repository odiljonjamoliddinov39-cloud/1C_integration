import { useEffect, type ReactNode } from "react";

import { useT } from "../lib/i18n";

export function Card({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  const { t } = useT();
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
      <span className="size-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
      {label ?? t("common.loading")}
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  const { ts } = useT();
  if (!error) return null;
  return <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">{ts(error)}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">{children}</div>;
}

const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  high: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  medium: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  low: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "green" | "blue" | "red" | "amber" }) {
  const tones = {
    slate: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    blue: "bg-brand-100 text-brand-700 dark:bg-brand-700/30 dark:text-brand-100",
    red: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  };
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  const { t } = useT();
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold first-letter:uppercase ${SEVERITY_STYLE[severity] ?? SEVERITY_STYLE.low}`}>{t(`severity.${severity}`)}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const { t } = useT();
  const tone = ({ applied: "green", posted: "green", signed: "green", fixed: "green", ready: "blue", sent: "blue", approved: "blue", created: "blue", failed: "red", rejected: "red", open: "amber", proposed: "amber", creating: "amber", posting: "amber" } as const)[status] ?? "slate";
  return <Badge tone={tone}>{t(`status.${status}`)}</Badge>;
}

export function Modal({ open, onClose, title, children, wide = false }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  const { t } = useT();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8" onClick={onClose}>
      <div className={`card w-full ${wide ? "max-w-4xl" : "max-w-lg"}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          <h2 className="font-semibold">{title}</h2>
          <button className="btn-ghost px-2" onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Stat({ label, value, hint, onClick, tone }: { label: string; value: ReactNode; hint?: ReactNode; onClick?: () => void; tone?: "red" }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag onClick={onClick} className={`card block w-full min-w-0 p-3 text-left sm:p-4 ${onClick ? "transition hover:border-brand-500" : ""}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-1 break-words text-lg font-semibold tabular-nums sm:text-2xl ${tone === "red" ? "text-red-600 dark:text-red-400" : ""}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</div>}
    </Tag>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full min-w-max border-collapse">{children}</table>
    </div>
  );
}
