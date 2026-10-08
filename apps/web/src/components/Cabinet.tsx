import type { DeviceView, Me } from "@platform/shared";
import { useEffect, useState } from "react";

import { ApiError, devices as loadDevices, logout, me as loadMe, revokeDevice } from "../lib/api";
import { DOWNLOAD_URL } from "../lib/config";
import { type Locale, dict, href } from "../lib/i18n";

/** Customer cabinet (TD §9): plan and status, this account's PCs, the download link. */
export function Cabinet({ locale }: { locale: Locale }) {
  const t = dict(locale).cabinet;
  const [me, setMe] = useState<Me | null>(null);
  const [pcs, setPcs] = useState<DeviceView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const date = (iso: string) => formatDate(new Date(iso), locale);

  // Bumped after a change, to load the cabinet again.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let current = true;
    Promise.all([loadMe(), loadDevices()]).then(
      ([account, list]) => {
        if (!current) return;
        setMe(account);
        setPcs(list);
      },
      (e: unknown) => {
        if (!current) return;
        if (e instanceof ApiError && e.status === 401) window.location.replace(href(locale, "/login"));
        else setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      current = false;
    };
  }, [locale, version]);

  async function revoke(pc: DeviceView) {
    if (!window.confirm(t.confirmRevoke.replace("{name}", pc.name))) return;
    await revokeDevice(pc.id).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    setVersion((v) => v + 1);
  }

  async function signOut() {
    await logout();
    window.location.assign(href(locale, "/"));
  }

  if (error)
    return <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>;
  if (!me) return <p className="text-muted-foreground">{t.loading}</p>;

  const status = me.subscription.status;
  const good = status === "trial" || status === "active";
  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-border bg-card p-6">
        <div className="flex flex-wrap items-start gap-4">
          <div>
            <div className="text-sm text-muted-foreground">{t.account}</div>
            <div className="text-lg font-semibold">{me.account.name}</div>
            <div className="text-sm text-muted-foreground">
              {me.user.name} · {me.user.email}
            </div>
          </div>
          <button onClick={() => void signOut()} className="ml-auto text-sm text-muted-foreground underline">
            {t.logout}
          </button>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted-foreground">{t.plan}:</span>
          <span className="font-medium">{t.planNames[me.subscription.plan] ?? me.subscription.plan}</span>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${good ? "bg-success/15 text-success" : "bg-warning/20"}`}
          >
            {t.status[status] ?? status} · {t.until.replace("{date}", date(me.subscription.endsAt))}
          </span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{t.trialNote}</p>
      </section>

      <section className="rounded-xl border border-border bg-card p-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">{t.devices}</h2>
          <a
            href={DOWNLOAD_URL}
            className="ml-auto rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {t.download}
          </a>
        </div>
        {pcs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.noDevices}</p>
        ) : (
          <ul className="divide-y divide-border">
            {pcs.map((pc) => (
              <li key={pc.id} className="flex flex-wrap items-center gap-x-6 gap-y-1 py-3 text-sm">
                <span className={`min-w-40 font-medium ${pc.revoked ? "line-through opacity-60" : ""}`}>
                  {pc.name}
                </span>
                <span className="text-muted-foreground">
                  {t.activated}: {date(pc.activatedAt)}
                </span>
                <span className="text-muted-foreground">
                  {t.lastSeen}: {date(pc.lastSeenAt)}
                </span>
                {pc.revoked ? (
                  <span className="ml-auto text-muted-foreground">{t.revoked}</span>
                ) : (
                  <button onClick={() => void revoke(pc)} className="ml-auto text-destructive underline">
                    {t.revoke}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// Browsers often lack Uzbek month names ("2026 M10 18"), so Uzbek dates are written out here.
const UZ_MONTHS = [
  "yanvar",
  "fevral",
  "mart",
  "aprel",
  "may",
  "iyun",
  "iyul",
  "avgust",
  "sentabr",
  "oktabr",
  "noyabr",
  "dekabr",
];

function formatDate(d: Date, locale: Locale): string {
  if (locale === "uz") return `${d.getFullYear()}-yil ${d.getDate()}-${UZ_MONTHS[d.getMonth()]}`;
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}
