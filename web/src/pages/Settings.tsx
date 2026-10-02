import QRCode from "qrcode";
import { useState } from "react";

import { Card, ErrorBox, PageHeader } from "../components/ui";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { useSession } from "../lib/session";

export function SettingsPage() {
  const { user, isOwner } = useSession();
  const { t } = useT();
  const [mcpToken, setMcpToken] = useState<string | null>(null);
  const [totp, setTotp] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mcpUrl = `${window.location.origin}/mcp`;

  async function issueMcp() {
    setError(null);
    try {
      setMcpToken((await api<{ token: string }>("/api/auth/mcp-token", { method: "POST" })).token);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function setupTotp() {
    setError(null);
    try {
      const res = await api<{ secret: string; uri: string }>("/api/auth/totp/setup", { method: "POST" });
      setTotp({ secret: res.secret, qr: await QRCode.toDataURL(res.uri, { margin: 1, width: 180 }) });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function enableTotp() {
    setError(null);
    try {
      await api("/api/auth/totp/enable", { method: "POST", json: { code } });
      setTotp(null);
      setMessage(t("set.totpDone"));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <PageHeader title={t("set.title")} subtitle={`${user?.email} · ${user ? t(`role.${user.role}`) : ""}`} />
      <ErrorBox error={error} />
      {message && <div className="mb-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">{message}</div>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t("set.mcpTitle")}>
          <div className="space-y-3 text-sm">
            <p>{t("set.mcpText")}</p>
            <div>
              <span className="label">{t("set.serverUrl")}</span>
              <code className="block break-all rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">{mcpUrl}</code>
            </div>
            {mcpToken ? (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
                <div className="mb-1 text-xs font-semibold">{t("set.tokenOnce")}</div>
                <code className="block break-all text-xs">{mcpToken}</code>
                <p className="mt-2 text-xs">{t("set.tokenHint")}</p>
              </div>
            ) : (
              <button className="btn-primary" onClick={issueMcp}>{t("set.createToken")}</button>
            )}
          </div>
        </Card>
        {isOwner && (
          <Card title={t("set.totpTitle")}>
            {user?.totp_enabled && !totp ? (
              <p className="text-sm">{t("set.totpOn")}</p>
            ) : totp ? (
              <div className="space-y-3 text-sm">
                <p>{t("set.totpScan")}</p>
                <img src={totp.qr} alt="TOTP QR code" className="rounded bg-white p-2" />
                <code className="block text-xs">{totp.secret}</code>
                <div className="flex gap-2">
                  <input className="input w-32 tracking-widest" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
                  <button className="btn-primary" onClick={enableTotp}>{t("set.totpEnable")}</button>
                </div>
              </div>
            ) : (
              <div className="space-y-3 text-sm">
                <p>{t("set.totpRecommended")}</p>
                <button className="btn-primary" onClick={setupTotp}>{t("set.totpSetup")}</button>
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
