import type { CheckoutResponse, CreditsView } from "@platform/shared";
import { useCallback, useEffect, useState } from "react";

import { ApiError, credits as loadCredits, purchaseCredits, saveAutoRecharge } from "../lib/api";
import { billingText, money } from "../lib/billing-i18n";
import { formatDate } from "../lib/dates";
import type { Locale } from "../lib/i18n";

const nf = (n: number) => new Intl.NumberFormat("ru-RU").format(Math.round(n * 100) / 100);

/** The cabinet's AI credits: balance, what it buys, history, buying more and auto-recharge. */
export function CreditsSection({
  locale,
  busy,
  version,
  act,
  pay,
  providers,
}: {
  locale: Locale;
  busy: boolean;
  /** Changes after any billing change, so the balance is read again. */
  version: number;
  act: (run: () => Promise<string | null>) => Promise<void>;
  pay: (result: CheckoutResponse) => Promise<string>;
  providers: string[];
}) {
  const t = billingText(locale).cabinet;
  const c = t.credits;
  const [view, setView] = useState<CreditsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState(1_000);
  const [provider, setProvider] = useState<"payme" | "click" | "bank">("bank");
  const [auto, setAuto] = useState({ enabled: false, thresholdCredits: 300, amountCredits: 1_000 });
  const [method, setMethod] = useState<"payme" | "click">("payme");
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    loadCredits().then(
      (v) => {
        setView(v);
        setAuto({
          enabled: v.autoRecharge.enabled,
          thresholdCredits: v.autoRecharge.thresholdCredits,
          amountCredits: v.autoRecharge.amountCredits,
        });
        if (v.autoRecharge.method) setMethod(v.autoRecharge.method);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [version]);

  const failure = (e: unknown): string => {
    if (e instanceof ApiError) return t.errors[e.code] ?? e.message;
    return e instanceof Error ? e.message : String(e);
  };

  if (!view) {
    return error ? (
      <section className="rounded-xl border border-border bg-card p-6 text-sm text-destructive">
        {error}
      </section>
    ) : null;
  }
  const sum = (credits: number) => money(Math.round(credits * view.somPerCredit), locale);
  const cardProviders = (["payme", "click"] as const).filter((p) => providers.includes(p));
  const input = "h-9 rounded-lg border border-border bg-background px-3 text-sm";
  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <h2 className="text-lg font-semibold">{c.title}</h2>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-sm text-muted-foreground">{c.balance}:</span>
        <span className="text-2xl font-bold">{nf(view.balanceCredits)}</span>
        <span className="text-sm text-muted-foreground">
          {c.approx.replace("{sum}", sum(Math.max(0, view.balanceCredits)))} ·{" "}
          {c.perCredit.replace("{sum}", money(view.somPerCredit, locale))}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {c.monthly.replace("{count}", nf(view.monthlyCredits)).replace("{cap}", nf(view.rolloverCapCredits))}
      </p>
      {view.low && <p className="mt-3 rounded-lg bg-warning/20 px-3 py-2 text-sm">{c.low}</p>}
      {view.atCap && <p className="mt-3 rounded-lg bg-muted px-3 py-2 text-sm">{c.atCap}</p>}
      {error && (
        <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}

      {view.canPurchase ? (
        <>
          <h3 className="mt-5 text-sm font-semibold">{c.buyTitle}</h3>
          <form
            className="mt-2 flex flex-wrap items-end gap-3 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => pay(await purchaseCredits({ credits: amount, provider })));
            }}
          >
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {c.buyAmount.replace("{min}", nf(view.minPurchaseCredits))}
              <input
                className={input}
                type="number"
                min={view.minPurchaseCredits}
                step={100}
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
              />
            </label>
            <select
              className={input}
              value={provider}
              onChange={(e) => setProvider(e.target.value as typeof provider)}
            >
              {[...cardProviders, "bank" as const].map((p) => (
                <option key={p} value={p}>
                  {t.provider[p]}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={busy || amount < view.minPurchaseCredits}
              className="h-9 rounded-lg bg-primary px-4 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {c.buy}
            </button>
            <span className="text-muted-foreground">
              {c.buyTotal.replace("{credits}", nf(amount)).replace("{sum}", sum(amount))}
            </span>
          </form>

          <h3 className="mt-5 text-sm font-semibold">{c.autoTitle}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {view.autoRecharge.hasCard ? "" : c.autoNoCard}
          </p>
          {!auto.enabled && view.autoRecharge.hasCard && (
            <p className="mt-1 text-sm text-muted-foreground">{c.autoOff}</p>
          )}
          {view.autoRecharge.hasCard && (
            <form
              className="mt-2 flex flex-wrap items-end gap-3 text-sm"
              onSubmit={(e) => {
                e.preventDefault();
                setSaved(false);
                saveAutoRecharge({ ...auto, method }).then(
                  () => {
                    setSaved(true);
                    setError(null);
                    load();
                  },
                  (err: unknown) => setError(failure(err)),
                );
              }}
            >
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={auto.enabled}
                  onChange={(e) => setAuto({ ...auto, enabled: e.target.checked })}
                />
                {c.autoEnable}
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {c.autoThreshold}
                <input
                  className={input}
                  type="number"
                  min={0}
                  value={auto.thresholdCredits}
                  onChange={(e) => setAuto({ ...auto, thresholdCredits: Number(e.target.value) })}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {c.autoAmount}
                <input
                  className={input}
                  type="number"
                  min={view.minPurchaseCredits}
                  step={100}
                  value={auto.amountCredits}
                  onChange={(e) => setAuto({ ...auto, amountCredits: Number(e.target.value) })}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {c.autoMethod}
                <select
                  className={input}
                  value={method}
                  onChange={(e) => setMethod(e.target.value as typeof method)}
                >
                  {(["payme", "click"] as const).map((p) => (
                    <option key={p} value={p}>
                      {t.provider[p]}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="h-9 rounded-lg border border-primary px-4 text-primary">
                {c.autoSave}
              </button>
              {saved && <span className="text-success">{c.autoSaved}</span>}
            </form>
          )}
        </>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">{c.freeNote}</p>
      )}

      <h3 className="mt-5 text-sm font-semibold">{c.historyTitle}</h3>
      {view.history.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{c.noHistory}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">{c.when}</th>
                <th className="py-2 pr-3 font-medium">{c.type}</th>
                <th className="py-2 pr-3 text-right font-medium">{c.amount}</th>
                <th className="py-2 text-right font-medium">{c.after}</th>
              </tr>
            </thead>
            <tbody>
              {view.history.map((h) => (
                <tr key={h.id} className="border-b border-border">
                  <td className="py-2 pr-3 whitespace-nowrap">{formatDate(new Date(h.createdAt), locale)}</td>
                  <td className="py-2 pr-3">{c.types[h.type] ?? h.type}</td>
                  <td
                    className={`py-2 pr-3 text-right ${h.amountCredits < 0 ? "text-destructive" : "text-success"}`}
                  >
                    {h.amountCredits > 0 ? "+" : ""}
                    {nf(h.amountCredits)}
                  </td>
                  <td className="py-2 text-right">{nf(h.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
