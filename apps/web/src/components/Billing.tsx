import type {
  CatalogResponse,
  OfferStatus,
  EntitlementsResponse,
  InvoiceView,
  PlanView,
  SubscriptionResponse,
} from "@platform/shared";
import { useCallback, useEffect, useState } from "react";

import { CreditsSection } from "./Credits";
import { OfferModal } from "./OfferModal";
import { type ClickWindowValues, openClickWindow } from "../lib/click-checkout";
import {
  ApiError,
  acceptOffer,
  cancelPlan,
  catalog as loadCatalog,
  changePlan,
  checkout,
  entitlements as loadEntitlements,
  invoiceCheckout,
  invoices as loadInvoices,
  offerStatus as loadOffer,
  openInvoicePrint,
  quote,
  resumePlan,
  subscription as loadSubscription,
} from "../lib/api";
import { billingText, money } from "../lib/billing-i18n";
import { formatDate } from "../lib/dates";
import type { Locale } from "../lib/i18n";

type Cycle = "month" | "year";
type Provider = "payme" | "click" | "bank";
/** The providers that take a card (the customer types it on the provider's own page or window). */
const CARD_PROVIDERS = ["payme", "click"] as const;

const dateOf = (iso: string, locale: Locale) => formatDate(new Date(iso), locale);

/** The cabinet's subscription (plan, use, change, cancel) and invoices (pay, print). */
export function BillingSection({ locale }: { locale: Locale }) {
  const t = billingText(locale).cabinet;
  const tp = billingText(locale).pricing;
  const [plans, setPlans] = useState<CatalogResponse | null>(null);
  const [sub, setSub] = useState<SubscriptionResponse | null>(null);
  const [ent, setEnt] = useState<EntitlementsResponse | null>(null);
  const [list, setList] = useState<InvoiceView[]>([]);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  // The public offer: shown before a purchase until the owner has accepted it (the server refuses a purchase without it).
  const [offer, setOffer] = useState<OfferStatus | null>(null);
  const [pendingBuy, setPendingBuy] = useState<(() => void) | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [offerError, setOfferError] = useState<string | null>(null);

  // Bumped after a change, to load everything again.
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const failure = useCallback(
    (e: unknown): string => {
      if (e instanceof ApiError) return t.errors[e.code] ?? e.message;
      return e instanceof Error ? e.message : String(e);
    },
    [t],
  );

  useEffect(() => {
    let current = true;
    Promise.all([
      loadCatalog(),
      loadSubscription(),
      loadEntitlements(),
      loadInvoices(),
      loadOffer().catch(() => null),
    ]).then(
      ([c, s, e, i, o]) => {
        if (!current) return;
        setPlans(c);
        setSub(s);
        setEnt(e);
        setList(i);
        setOffer(o);
      },
      (e: unknown) => {
        if (current) setMessage({ text: failure(e), bad: true });
      },
    );
    return () => {
      current = false;
    };
  }, [version, failure]);

  /** Runs an action with the buttons off, then shows what happened and reloads. */
  async function act(run: () => Promise<string | null>) {
    setBusy(true);
    setMessage(null);
    try {
      const text = await run();
      if (text) setMessage({ text, bad: false });
      reload();
    } catch (e) {
      setMessage({ text: failure(e), bad: true });
    } finally {
      setBusy(false);
    }
  }

  if (!sub || !ent || !plans) {
    return (
      <section className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
        {message ? message.text : t.working}
      </section>
    );
  }

  /** Runs a purchase; first the offer, when the owner has not accepted its current text. */
  const guard = (run: () => void) => {
    if (offer && offer.required && !offer.accepted) {
      setOfferError(null);
      setPendingBuy(() => run);
    } else run();
  };
  async function agree() {
    if (!offer) return;
    setAccepting(true);
    setOfferError(null);
    try {
      const status = await acceptOffer({ version: offer.version, locale });
      setOffer(status);
      const run = pendingBuy;
      setPendingBuy(null);
      run?.();
    } catch (e) {
      setOfferError(failure(e));
    } finally {
      setAccepting(false);
    }
  }

  const e = ent.entitlements;
  const paid = sub.status === "active" || sub.status === "grace";
  const planName = plans.plans.find((p) => p.code === e.plan)?.name ?? e.plan;
  const bar = (used: number, limit: number | null) =>
    limit === null ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const usage: [string, number, number | null][] = [
    [t.companies, ent.usage.companies, e.companies],
    [t.users, ent.usage.users, e.users],
    [t.imports, ent.usage.imports, e.importsPerMonth],
    [t.audits, ent.usage.audits, e.auditsPerMonth],
    // With credits the balance replaces the question count: it has its own section.
    ...(ent.credits
      ? []
      : [[t.ai, ent.usage.aiQuestions, e.aiQuestionsPerMonth] as [string, number, number | null]]),
  ];

  /** After an invoice exists: card goes to the provider, a bank transfer opens the printable invoice. */
  async function pay(result: {
    invoice: InvoiceView;
    checkoutUrl: string | null;
    click?: ClickWindowValues | undefined;
  }): Promise<string> {
    // Click opens its window over the page; when it closes the subscription is loaded again, a few times, because Click
    // confirms the payment to our server a moment after the customer is done.
    if (result.click) {
      try {
        const status = await openClickWindow(result.click);
        for (const wait of [1500, 4000, 9000]) setTimeout(reload, wait);
        if (status === 2) return t.paidMessage.replace("{number}", result.invoice.number);
        if (status < 0) return t.notPaid.replace("{number}", result.invoice.number);
        return t.created.replace("{number}", result.invoice.number);
      } catch {
        // The window could not be opened (no connection to Click, a blocker): the link does the same on Click's page.
      }
    }
    if (result.checkoutUrl) {
      window.location.assign(result.checkoutUrl);
      return t.created.replace("{number}", result.invoice.number);
    }
    await openInvoicePrint(result.invoice.id);
    return t.createdBank.replace("{number}", result.invoice.number);
  }

  return (
    <>
      <section className="rounded-xl border border-border bg-card p-6">
        <h2 className="text-lg font-semibold">{t.subscription}</h2>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted-foreground">{t.plan}:</span>
          <span className="text-lg font-semibold">{planName}</span>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${sub.status === "grace" ? "bg-warning/20" : "bg-success/15 text-success"}`}
          >
            {t.status[sub.status] ?? sub.status}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {sub.periodEnd ? t.periodEnd.replace("{date}", dateOf(sub.periodEnd, locale)) : t.noEnd}
        </p>
        {sub.pendingPlan && sub.periodEnd && (
          <p className="mt-1 text-sm">
            {t.pendingPlan
              .replace("{plan}", plans.plans.find((p) => p.code === sub.pendingPlan)?.name ?? sub.pendingPlan)
              .replace("{date}", dateOf(sub.periodEnd, locale))}
          </p>
        )}
        {sub.cancelAtPeriodEnd && sub.periodEnd && (
          <p className="mt-1 text-sm">{t.cancelled.replace("{date}", dateOf(sub.periodEnd, locale))}</p>
        )}
        {message && (
          <p
            className={`mt-3 rounded-lg px-3 py-2 text-sm ${message.bad ? "bg-destructive/10 text-destructive" : "bg-success/15"}`}
          >
            {message.text}
          </p>
        )}

        <h3 className="mt-5 text-sm font-semibold">{t.usage}</h3>
        <ul className="mt-2 grid gap-3 sm:grid-cols-2">
          {usage.map(([label, used, limit]) => (
            <li key={label} className="text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-medium">
                  {used} / {limit === null ? t.unlimited : limit}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full ${bar(used, limit) >= 100 ? "bg-destructive" : bar(used, limit) >= 80 ? "bg-warning" : "bg-primary"}`}
                  style={{ width: `${bar(used, limit)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>

        {paid && (
          <div className="mt-5 flex flex-wrap gap-3 text-sm">
            {sub.cancelAtPeriodEnd ? (
              <button
                disabled={busy}
                onClick={() => void act(async () => (await resumePlan(), null))}
                className="underline"
              >
                {t.resume}
              </button>
            ) : (
              <button
                disabled={busy}
                onClick={() =>
                  window.confirm(t.confirmCancel) && void act(async () => (await cancelPlan(), null))
                }
                className="text-destructive underline"
              >
                {t.cancel}
              </button>
            )}
          </div>
        )}
      </section>

      {ent.credits && (
        <CreditsSection
          locale={locale}
          busy={busy}
          version={version}
          act={act}
          pay={pay}
          guard={guard}
          providers={plans.providers}
        />
      )}

      <PlanChooser
        locale={locale}
        plans={plans.plans.filter((p) => p.code !== "free")}
        current={paid ? e.plan : null}
        currentCycle={sub.billingCycle}
        busy={busy}
        providers={plans.providers}
        onCheckout={(input) => guard(() => void act(async () => pay(await checkout(input))))}
        onChange={(input) =>
          guard(
            () =>
              void act(async () => {
                const result = await changePlan(input);
                if (result.checkout) return pay(result.checkout);
                return result.effectiveAt
                  ? t.scheduled.replace("{date}", dateOf(result.effectiveAt, locale))
                  : null;
              }),
          )
        }
        previewTotals={(input) => quote(input)}
      />

      {paid && plans.addons.length > 0 && (
        <section className="rounded-xl border border-border bg-card p-6">
          <h2 className="text-lg font-semibold">{t.addons}</h2>
          <ul className="mt-3 divide-y divide-border text-sm">
            {plans.addons
              .filter((a) => a.allowedPlans.includes(e.plan))
              .map((a) => (
                <li key={a.code} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
                  <span className="min-w-56 flex-1 font-medium">{tp.addonNames[a.code] ?? a.name}</span>
                  <span className="text-muted-foreground">
                    {money(a.priceSum, locale)}
                    {a.kind === "recurring" ? ` ${tp.perMonth}` : ""}
                  </span>
                  <button
                    disabled={busy || sub.status === "grace"}
                    onClick={() =>
                      guard(
                        () =>
                          void act(async () =>
                            pay(
                              await checkout({
                                addon: a.code,
                                quantity: 1,
                                provider: CARD_PROVIDERS.find((p) => plans.providers.includes(p)) ?? "bank",
                              }),
                            ),
                          ),
                      )
                    }
                    className="rounded-lg border border-primary px-3 py-1 text-primary hover:bg-primary/5 disabled:opacity-50"
                  >
                    {t.addAddon}
                  </button>
                </li>
              ))}
          </ul>
        </section>
      )}

      <section className="rounded-xl border border-border bg-card p-6">
        <h2 className="text-lg font-semibold">{t.invoices}</h2>
        {list.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">{t.noInvoices}</p>
        ) : (
          <ul className="mt-3 divide-y divide-border text-sm">
            {list.map((inv) => (
              <li key={inv.id} className="flex flex-wrap items-center gap-x-5 gap-y-1 py-3">
                <span className="min-w-24 font-medium">{inv.number}</span>
                <span className="text-muted-foreground">{dateOf(inv.createdAt, locale)}</span>
                <span className="min-w-40 flex-1">{inv.items.map((i) => i.title).join(", ")}</span>
                <span className="font-medium">{money(inv.totalSum, locale)}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${inv.status === "paid" ? "bg-success/15 text-success" : inv.status === "pending" ? "bg-warning/20" : "bg-muted"}`}
                >
                  {t.invoiceStatus[inv.status] ?? inv.status}
                </span>
                <button onClick={() => void openInvoicePrint(inv.id)} className="underline">
                  {t.print}
                </button>
                {(inv.status === "pending" || inv.status === "expired") &&
                  CARD_PROVIDERS.filter((p) => plans.providers.includes(p)).map((p) => (
                    <button
                      key={p}
                      disabled={busy}
                      onClick={() =>
                        guard(
                          () =>
                            void act(async () => {
                              const result = await invoiceCheckout(inv.id, p);
                              return pay({
                                invoice: inv,
                                checkoutUrl: result.checkoutUrl,
                                click: result.click,
                              });
                            }),
                        )
                      }
                      className="rounded-lg bg-primary px-3 py-1 text-primary-foreground hover:opacity-90"
                    >
                      {t.pay} · {t.provider[p]}
                    </button>
                  ))}
              </li>
            ))}
          </ul>
        )}
      </section>
      {pendingBuy && (
        <OfferModal
          locale={locale}
          busy={accepting}
          error={offerError}
          onAgree={() => void agree()}
          onCancel={() => setPendingBuy(null)}
        />
      )}
    </>
  );
}

/** Pick a plan and how to pay: a new plan from Free, an upgrade or downgrade from a paid one. */
function PlanChooser(props: {
  locale: Locale;
  plans: PlanView[];
  /** The paid plan the account has, or null on Free and in a trial. */
  current: string | null;
  currentCycle: Cycle;
  busy: boolean;
  providers: string[];
  onCheckout: (input: { plan: string; cycle: Cycle; promoCode?: string; provider: Provider }) => void;
  onChange: (input: { plan: string; cycle?: Cycle; provider: Provider }) => void;
  previewTotals: (input: { plan: string; cycle: Cycle; promoCode?: string; provider: Provider }) => Promise<{
    subtotalSum: number;
    discountSum: number;
    vatSum: number;
    totalSum: number;
  }>;
}) {
  const { locale, plans, current, busy } = props;
  const t = billingText(locale).cabinet;
  const tp = billingText(locale).pricing;
  const params =
    typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const [choice, setChoice] = useState(params.get("plan") ?? "");
  const [cycle, setCycle] = useState<Cycle>(params.get("cycle") === "year" ? "year" : "month");
  const [promo, setPromo] = useState("");
  const [provider, setProvider] = useState<Provider>(
    CARD_PROVIDERS.find((p) => props.providers.includes(p)) ?? "bank",
  );
  const [totals, setTotals] = useState<Awaited<ReturnType<typeof props.previewTotals>> | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);

  const selected = plans.find((p) => p.code === choice);
  const renewing = selected !== undefined && selected.code === current;
  const switching = current !== null && !renewing;

  // The price of the choice, with the promo code and VAT, from the server.
  useEffect(() => {
    if (!selected || switching) return;
    let live = true;
    props
      .previewTotals({ plan: selected.code, cycle, ...(promo ? { promoCode: promo } : {}), provider })
      .then(
        (q) => live && (setTotals(q), setPromoError(null)),
        (e: unknown) => {
          if (!live) return;
          setTotals(null);
          setPromoError(e instanceof ApiError ? (t.errors[e.code] ?? e.message) : null);
        },
      );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.code, cycle, promo, provider, switching]);

  // Only a new purchase has a price to preview; a switch of plan is priced by the server when it is made.
  const shown = selected && !switching ? totals : null;
  const rank = (code: string) => plans.findIndex((p) => p.code === code);
  const kind =
    switching && selected ? (rank(selected.code) > rank(current) ? t.upgrade : t.downgrade) : t.buy;

  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <h2 className="text-lg font-semibold">{t.choosePlan}</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {plans.map((p) => (
          <button
            key={p.code}
            onClick={() => setChoice(p.code)}
            className={`rounded-xl border p-4 text-left ${choice === p.code ? "border-2 border-primary bg-primary/5" : "border-border"}`}
          >
            <div className="font-semibold">
              {p.name} {p.code === current && <span className="text-xs text-primary">· {tp.current}</span>}
            </div>
            <div className="text-sm text-muted-foreground">
              {money(cycle === "year" ? p.priceYearSum : p.priceMonthSum, locale)}{" "}
              {cycle === "year" ? tp.perYear : tp.perMonth}
            </div>
          </button>
        ))}
      </div>

      {selected && (
        <div className="mt-4 space-y-3 text-sm">
          {current === null && (
            <div className="flex flex-wrap gap-3">
              {(["month", "year"] as const).map((c) => (
                <label key={c} className="flex items-center gap-1.5">
                  <input type="radio" name="cycle" checked={cycle === c} onChange={() => setCycle(c)} />
                  {t.cycle[c]}
                </label>
              ))}
            </div>
          )}
          {!switching && (
            <label className="block">
              <span className="text-muted-foreground">{t.promo}</span>
              <input
                value={promo}
                onChange={(ev) => setPromo(ev.target.value.trim())}
                className="mt-1 block w-48 rounded-lg border border-border bg-background px-3 py-1.5"
              />
              {promoError && <span className="text-xs text-destructive">{promoError}</span>}
            </label>
          )}
          <div className="flex flex-wrap gap-3">
            {(["payme", "click", "bank"] as const)
              .filter((p) => props.providers.includes(p))
              .map((p) => (
                <label key={p} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="provider"
                    checked={provider === p}
                    onChange={() => setProvider(p)}
                  />
                  {t.provider[p]}
                </label>
              ))}
          </div>
          {shown && (
            <div className="rounded-lg bg-muted/50 p-3">
              {shown.discountSum > 0 && (
                <div>
                  {t.discount}: −{money(shown.discountSum, locale)}
                </div>
              )}
              {shown.vatSum > 0 && (
                <div>
                  {t.vat}: {money(shown.vatSum, locale)}
                </div>
              )}
              <div className="font-semibold">
                {t.total}: {money(shown.totalSum, locale)}
              </div>
            </div>
          )}
          <button
            disabled={busy || (promo !== "" && promoError !== null)}
            onClick={() =>
              switching
                ? props.onChange({ plan: selected.code, provider })
                : props.onCheckout({
                    plan: selected.code,
                    cycle,
                    ...(promo ? { promoCode: promo } : {}),
                    provider,
                  })
            }
            className="rounded-xl bg-primary px-5 py-2 font-medium text-primary-foreground shadow-md shadow-primary/25 hover:opacity-90 disabled:opacity-60"
          >
            {kind}
          </button>
        </div>
      )}
    </section>
  );
}
