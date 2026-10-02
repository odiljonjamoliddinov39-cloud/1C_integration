import { useState, type FormEvent } from "react";

import { ErrorBox } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { LanguageSwitcher, useT } from "../lib/i18n";
import { useSession } from "../lib/session";
import type { User } from "../lib/types";

export function Login() {
  const { login } = useSession();
  const { t } = useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ token: string; user: User }>("/api/auth/login", { method: "POST", json: { email, password, totp: totp || null } });
      login(res.token, res.user);
    } catch (err) {
      if (err instanceof ApiError && err.message === "totp_required") {
        setNeedTotp(true);
        setError(null);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
        <div className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-md bg-brand-600 text-sm font-bold text-white">1C</span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{t("app.name")}</div>
            <div className="text-xs text-slate-500">{t("app.product")}</div>
          </div>
          <LanguageSwitcher />
        </div>
        <div>
          <label className="label" htmlFor="email">{t("login.email")}</label>
          <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor="password">{t("login.password")}</label>
          <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {needTotp && (
          <div>
            <label className="label" htmlFor="totp">{t("login.totp")}</label>
            <input id="totp" className="input tracking-widest" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value)} autoFocus required />
          </div>
        )}
        <ErrorBox error={error} />
        <button className="btn-primary w-full py-2" disabled={busy}>
          {busy ? t("login.submitting") : t("login.submit")}
        </button>
      </form>
    </div>
  );
}
