import { type CatalogResponse, type PlanView, YEAR_MONTHS, yearPriceOf } from "@platform/shared";
import { useEffect, useState } from "react";

import { catalog as loadCatalog, signedIn } from "../lib/api";
import { billingText, money } from "../lib/billing-i18n";
import { type Locale, href } from "../lib/i18n";

/** The pricing page: four plans (Free first), monthly or yearly, the add-ons and the questions people ask. */
export function Pricing({ locale }: { locale: Locale }) {
  const t = billingText(locale).pricing;
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cycle, setCycle] = useState<"month" | "year">("month");

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

  if (error)
    return <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>;
  if (!data) return <p className="text-muted-foreground">…</p>;

  const nf = (n: number) => new Intl.NumberFormat("ru-RU").format(n);
  /** A monthly limit; in the yearly view also what it comes to over the 12 months. */
  const limit = (n: number | null, year: boolean) =>
    n === null
      ? t.rows.unlimited
      : year
        ? `${nf(n)} ${t.rows.perMonthShort} · ${nf(n * YEAR_MONTHS)} ${t.perYearShort}`
        : nf(n);
  const cell = (plan: PlanView, year: boolean) => [
    [t.rows.companies, String(plan.companies)],
    [t.rows.users, String(plan.users)],
    [t.rows.imports, limit(plan.importsPerMonth, year)],
    [
      t.rows.audits,
      plan.auditsPerMonth === null
        ? t.rows.unlimited
        : year
          ? limit(plan.auditsPerMonth, year)
          : `${plan.auditsPerMonth} ${t.rows.perMonthShort}`,
    ],
    [t.rows.ai, limit(plan.aiQuestionsPerMonth, year)],
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
          // The yearly price is worked out from the monthly one when the admin set none (12 for 10).
          const yearPrice = yearPriceOf(plan.priceMonthSum);
          const price = cycle === "year" ? yearPrice : plan.priceMonthSum;
          const saved = plan.priceMonthSum * YEAR_MONTHS - yearPrice;
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
              <div className="h-5 text-xs text-muted-foreground">
                {!free && cycle === "year"
                  ? `${t.monthEquivalent} ≈ ${money(Math.round(yearPrice / YEAR_MONTHS), locale)}${saved > 0 ? ` · ${t.saves} ${money(saved, locale)}` : ""}`
                  : ""}
              </div>
              <ul className="mt-4 flex-1 space-y-2 text-sm">
                {cell(plan, cycle === "year").map(([label, value]) => (
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
    </div>
  );
}
