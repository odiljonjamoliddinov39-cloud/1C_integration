import type { CatalogResponse, PlanView } from "@platform/shared";
import { useEffect, useState } from "react";

import { ApiError, catalog as loadCatalog, signedIn, startTrial } from "../lib/api";
import { billingText, money } from "../lib/billing-i18n";
import { type Locale, href } from "../lib/i18n";

/** The pricing page: four plans (Free first), monthly or yearly, the add-ons and the questions people ask. */
export function Pricing({ locale }: { locale: Locale }) {
  const t = billingText(locale).pricing;
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cycle, setCycle] = useState<"month" | "year">("month");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    loadCatalog().then(
      (c) => current && setData(c),
      (e: unknown) => current && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      current = false;
    };
  }, []);

  async function tryBusiness() {
    if (!signedIn()) return window.location.assign(href(locale, "/signup"));
    setBusy(true);
    try {
      await startTrial();
    } catch (e) {
      // Already used or not available: the cabinet explains.
      if (!(e instanceof ApiError)) setError(e instanceof Error ? e.message : String(e));
    }
    window.location.assign(href(locale, "/cabinet"));
  }

  if (error)
    return <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>;
  if (!data) return <p className="text-muted-foreground">…</p>;

  const limit = (n: number | null) => (n === null ? t.rows.unlimited : String(n));
  const cell = (plan: PlanView) => [
    [t.rows.companies, String(plan.companies)],
    [t.rows.users, String(plan.users)],
    [t.rows.imports, limit(plan.importsPerMonth)],
    [
      t.rows.audits,
      plan.auditsPerMonth === null ? t.rows.unlimited : `${plan.auditsPerMonth} ${t.rows.perMonthShort}`,
    ],
    [t.rows.ai, String(plan.aiQuestionsPerMonth)],
    [t.rows.excel, plan.features.excelExport ? "✓" : "—"],
    [t.rows.support, t.support[plan.features.support] ?? plan.features.support],
  ];

  return (
    <div>
      <div className="inline-flex rounded-xl border border-border bg-card p-1 text-sm">
        {(["month", "year"] as const).map((c) => (
          <button
            key={c}
            onClick={() => setCycle(c)}
            className={`rounded-lg px-4 py-1.5 font-medium ${cycle === c ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
          >
            {c === "month" ? t.toggleMonth : t.toggleYear}
          </button>
        ))}
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {data.plans.map((plan) => {
          const free = plan.priceMonthSum === 0;
          const featured = plan.code === "business";
          const price = cycle === "year" ? plan.priceYearSum : plan.priceMonthSum;
          return (
            <div
              key={plan.code}
              className={`flex flex-col rounded-3xl border bg-card p-6 ${featured ? "border-2 border-primary shadow-xl shadow-primary/15" : "border-border shadow-sm"}`}
            >
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">{plan.name}</h2>
                {featured && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    {t.popular}
                  </span>
                )}
              </div>
              <div className="mt-3 text-2xl font-bold whitespace-nowrap">
                {free ? t.free : money(price, locale)}
              </div>
              <div className="h-5 text-sm text-muted-foreground">
                {free ? "" : cycle === "year" ? t.perYear : t.perMonth}
              </div>
              <ul className="mt-4 flex-1 space-y-2 text-sm">
                {cell(plan).map(([label, value]) => (
                  <li key={label} className="flex justify-between gap-3 border-b border-border/60 pb-1.5">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="text-right font-medium">{value}</span>
                  </li>
                ))}
              </ul>
              {free && <p className="mt-3 text-xs text-muted-foreground">{t.noteFree}</p>}
              <div className="mt-5 space-y-2">
                {free ? (
                  <a
                    href={href(locale, signedIn() ? "/cabinet" : "/signup")}
                    className="block rounded-xl bg-primary py-2.5 text-center font-medium text-primary-foreground shadow-md shadow-primary/25 hover:opacity-90"
                  >
                    {t.startFree}
                  </a>
                ) : (
                  <a
                    href={`${href(locale, "/cabinet")}?plan=${plan.code}&cycle=${cycle}`}
                    className="block rounded-xl border border-primary py-2.5 text-center font-medium text-primary hover:bg-primary/5"
                  >
                    {t.choose}
                  </a>
                )}
                {featured && (
                  <button
                    disabled={busy}
                    onClick={() => void tryBusiness()}
                    className="block w-full rounded-xl bg-primary py-2.5 text-center text-sm font-medium text-primary-foreground shadow-md shadow-primary/25 hover:opacity-90 disabled:opacity-60"
                  >
                    {t.tryBusiness}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-sm text-muted-foreground">{t.custom}</p>
      <p className="mt-1 text-sm text-muted-foreground">{t.vat}</p>

      <section className="mt-12">
        <h2 className="text-2xl font-bold">{t.addonsTitle}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t.addonsNote}</p>
        <ul className="mt-4 divide-y divide-border rounded-2xl border border-border bg-card">
          {data.addons.map((a) => (
            <li key={a.code} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-3 text-sm">
              <span className="min-w-56 flex-1 font-medium">{t.addonNames[a.code] ?? a.name}</span>
              <span className="text-muted-foreground">
                {t.addonOn}{" "}
                {a.allowedPlans.map((p) => data.plans.find((x) => x.code === p)?.name ?? p).join(", ")}
              </span>
              <span className="font-semibold">
                {money(a.priceSum, locale)}
                {a.kind === "recurring" ? ` ${t.perMonth}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-12">
        <h2 className="text-2xl font-bold">{t.faqTitle}</h2>
        <div className="mt-4 space-y-3">
          {t.faq.map(([q, a]) => (
            <details key={q} className="rounded-2xl border border-border bg-card px-5 py-3">
              <summary className="cursor-pointer font-medium">{q}</summary>
              <p className="mt-2 text-sm text-muted-foreground">{a}</p>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
