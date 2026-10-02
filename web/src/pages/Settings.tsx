import QRCode from "qrcode";
import { useState } from "react";

import { Card, ErrorBox, PageHeader } from "../components/ui";
import { api } from "../lib/api";
import { useSession } from "../lib/session";

export function SettingsPage() {
  const { user, isOwner } = useSession();
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
      setMessage("Two-factor authentication is on. You will be asked for a code at every login.");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <PageHeader title="Settings" subtitle={`${user?.email} · ${user?.role}`} />
      <ErrorBox error={error} />
      {message && <div className="mb-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">{message}</div>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Claude.ai / Claude Desktop connector (MCP)">
          <div className="space-y-3 text-sm">
            <p>Connect Claude to the books of every company you can see. Read tools answer questions. Write tools only create proposals and drafts that someone approves here.</p>
            <div>
              <span className="label">Server URL</span>
              <code className="block break-all rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">{mcpUrl}</code>
            </div>
            {mcpToken ? (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
                <div className="mb-1 text-xs font-semibold">Your token (shown once; issuing a new one replaces it):</div>
                <code className="block break-all text-xs">{mcpToken}</code>
                <p className="mt-2 text-xs">Use it as the Bearer token (header <code>Authorization: Bearer …</code>) when adding the custom connector.</p>
              </div>
            ) : (
              <button className="btn-primary" onClick={issueMcp}>Create MCP token</button>
            )}
          </div>
        </Card>
        {isOwner && (
          <Card title="Two-factor authentication (TOTP)">
            {user?.totp_enabled && !totp ? (
              <p className="text-sm">2FA is on for this account.</p>
            ) : totp ? (
              <div className="space-y-3 text-sm">
                <p>Scan with Google Authenticator, Authy or a similar app, then enter the 6-digit code.</p>
                <img src={totp.qr} alt="TOTP QR code" className="rounded bg-white p-2" />
                <code className="block text-xs">{totp.secret}</code>
                <div className="flex gap-2">
                  <input className="input w-32 tracking-widest" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
                  <button className="btn-primary" onClick={enableTotp}>Turn on</button>
                </div>
              </div>
            ) : (
              <div className="space-y-3 text-sm">
                <p>Recommended for owners: logins will need a code from your phone.</p>
                <button className="btn-primary" onClick={setupTotp}>Set up 2FA</button>
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
