import type { CheckoutResponse, CreditsView } from "@platform/shared";
import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  cancelCreditRequest,
  credits as loadCredits,
  purchaseCredits,
  requestCredits,
  saveAutoRecharge,
  setExtraCredits,
} from "../lib/api";
import { billingText, money } from "../lib/billing-i18n";
import { formatDate, formatDateTime } from "../lib/dates";
import type { Locale } from "../lib/i18n";

const nf = (n: number) => new Intl.NumberFormat("ru-RU").format(Math.round(n * 100) / 100);

/** The cabinet's AI credits: balance, what it buys, history, buying more and auto-recharge. */
export function CreditsSection({
  locale,
  busy,
  version,
  act,
  pay,
  guard,
  providers,
}: {
  locale: Locale;
  busy: boolean;
  /** Changes after any billing change, so the balance is read again. */
  version: number;
  act: (run: () => Promise<string | null>) => Promise<void>;
  pay: (result: CheckoutResponse) => Promise<string>;
  /** Runs a purchase after the public offer is accepted (it asks first when it is not). */
  guard: (run: () => void) => void;
  providers: string[];
}) {
  const t = billingText(locale).cabinet;
  const c = t.credits;
  const [view, setView] = useState<CreditsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState(100_000);
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
  /** What an amount of credits comes to in questions: the customer is told questions and a scale, never money. */
  const questionsOf = (credits: number) => (credits * view.somPerCredit) / view.questionSom;
  /** Questions, with a decimal while it is only a few (a small use of the AI is a fraction of a question). */
  const qText = (credits: number) => {
    const q = questionsOf(credits);
    return nf(Math.abs(q) < 10 ? Math.round(q * 10) / 10 : Math.round(q));
  };
  /** The tokens of an amount of credits, when there is use to learn them from. */
  const tokenText = (credits: number) =>
    view.tokensPerQuestion === null
      ? null
      : c.estTokens.replace("{n}", nf(Math.round(questionsOf(credits) * view.tokensPerQuestion)));
  const estimate = (credits: number) =>
    [c.estQuestions.replace("{n}", qText(credits)), tokenText(credits)].filter(Boolean).join(" · ");
  const planLeftPct = Math.min(
    100,
    Math.round((Math.max(0, view.balanceCredits) / Math.max(1, view.monthlyCredits)) * 100),
  );
  const monthlyQuestions = nf(Math.round(questionsOf(view.monthlyCredits)));
  const toggleExtra = (enabled: boolean) =>
    setExtraCredits({ enabled }).then(
      (v) => {
        setView(v);
        setError(null);
      },
      (e: unknown) => setError(failure(e)),
    );
  const cardProviders = (["payme", "click"] as const).filter((p) => providers.includes(p));
  const input = "h-9 rounded-lg border border-border bg-background px-3 text-sm";
  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <h2 className="text-lg font-semibold">{c.title}</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div>
          <div className="text-sm text-muted-foreground">{c.planBalance}</div>
          <div className="text-2xl font-bold">{c.leftPct.replace("{pct}", nf(planLeftPct))}</div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full ${planLeftPct === 0 ? "bg-destructive" : planLeftPct <= 20 ? "bg-warning" : "bg-primary"}`}
              style={{ width: `${planLeftPct}%` }}
            />
          </div>
          <div className="mt-1.5 text-sm text-muted-foreground">{estimate(view.balanceCredits)}</div>
          <div className="mt-1 text-sm text-muted-foreground">
            {c.monthlyQuestions.replace("{questions}", monthlyQuestions)}
            {view.planResetsAt && (
              <> {c.planResets.replace("{date}", formatDate(new Date(view.planResetsAt), locale))}</>
            )}
          </div>
        </div>
        <div>
          <div className="text-sm text-muted-foreground">{c.extraBalance}</div>
          <div className="text-2xl font-bold">
            {c.estQuestions.replace("{n}", qText(Math.max(0, view.extraCredits)))}
          </div>
          <div className="text-sm text-muted-foreground">
            {tokenText(Math.max(0, view.extraCredits)) ?? ""}
          </div>
        </div>
      </div>
      {(view.daily || view.weekly) && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {(
            [
              [c.today, view.daily],
              [c.thisWeek, view.weekly],
            ] as const
          ).map(([label, limit]) =>
            limit ? (
              <div key={label}>
                <div className="flex justify-between text-sm">
                  <span>{label}</span>
                  <span className="text-muted-foreground">
                    {c.usedPct.replace(
                      "{pct}",
                      nf(Math.min(100, Math.round((limit.usedCredits / limit.limitCredits) * 100))),
                    )}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${limit.usedCredits >= limit.limitCredits ? "bg-destructive" : "bg-primary"}`}
                    style={{
                      width: `${Math.min(100, Math.round((limit.usedCredits / limit.limitCredits) * 100))}%`,
                    }}
                  />
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {c.resets.replace("{when}", formatDateTime(new Date(limit.resetsAt), locale))}
                </div>
              </div>
            ) : null,
          )}
        </div>
      )}
      {view.blocked && (
        <div className="mt-4 rounded-lg bg-warning/20 px-3 py-3 text-sm">
          <p className="font-medium">{c.blocked[view.blocked]}</p>
          <p className="mt-1 text-muted-foreground">
            {view.extraEnabled
              ? view.extraCredits > 0
                ? c.blockedUsing
                : c.blockedBuy
              : view.extraCredits > 0
                ? c.blockedTurnOn
                : view.canPurchase
                  ? c.blockedBuy
                  : c.blockedWait}
          </p>
        </div>
      )}
      {(view.canPurchase || view.extraCredits > 0) && (
        <label className="mt-4 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={view.extraEnabled}
            onChange={(e) => toggleExtra(e.target.checked)}
          />
          <span>
            {c.extraToggle}
            <span className="block text-xs text-muted-foreground">{c.extraHint}</span>
          </span>
        </label>
      )}
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
              guard(
                () =>
                  void act(async () => {
                    if (view.approvalRequired) {
                      await requestCredits({ sum: amount });
                      return c.requestSent;
                    }
                    return pay(await purchaseCredits({ sum: amount, provider }));
                  }),
              );
            }}
          >
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {c.buyAmount.replace("{min}", money(view.minTopupSum, locale))}
              <input
                className={input}
                type="number"
                min={view.minTopupSum}
                step={10_000}
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
              />
            </label>
            {!view.approvalRequired && (
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
            )}
            <button
              type="submit"
              disabled={busy || !(amount >= view.minTopupSum)}
              className="h-9 rounded-lg bg-primary px-4 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {view.approvalRequired ? c.requestBuy : c.buy}
            </button>
            <span className="text-muted-foreground">
              {c.buyGets.replace(
                "{questions}",
                nf(Math.round((amount * view.topupShare) / view.questionSom)),
              )}
            </span>
          </form>
          {view.approvalRequired && <p className="mt-2 text-sm text-muted-foreground">{c.requestNote}</p>}
          {view.requests.length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-semibold">{c.requestsTitle}</h3>
              <ul className="mt-2 divide-y divide-border rounded-lg border border-border text-sm">
                {view.requests.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
                    <span className="whitespace-nowrap text-muted-foreground">
                      {formatDate(new Date(r.createdAt), locale)}
                    </span>
                    <span className="font-medium">+{c.estQuestions.replace("{n}", qText(r.credits))}</span>
                    <span className="text-muted-foreground">
                      {c.requestPays.replace("{sum}", money(r.totalSom, locale))}
                    </span>
                    <span
                      className={
                        r.status === "approved"
                          ? "text-success"
                          : r.status === "pending"
                            ? "text-foreground"
                            : "text-muted-foreground"
                      }
                    >
                      {c.requestStatus[r.status] ?? r.status}
                    </span>
                    {r.note && <span className="text-muted-foreground">{r.note}</span>}
                    {r.status === "pending" && (
                      <button
                        type="button"
                        disabled={busy}
                        className="ml-auto text-primary hover:underline disabled:opacity-50"
                        onClick={() => void act(async () => (await cancelCreditRequest(r.id), null))}
                      >
                        {c.cancelRequest}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

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
                  min={1_000}
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
                  <td className="py-2 pr-3">
                    {c.types[h.type] ?? h.type}
                    {h.pool === "extra" && <span className="text-muted-foreground"> · {c.poolExtra}</span>}
                  </td>
                  <td
                    className={`py-2 pr-3 text-right ${h.amountCredits < 0 ? "text-destructive" : "text-success"}`}
                  >
                    {h.amountCredits > 0 ? "+" : ""}
                    {qText(h.amountCredits)}
                  </td>
                  <td className="py-2 text-right">{qText(h.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
