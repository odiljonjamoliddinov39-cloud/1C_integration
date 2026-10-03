import { useEffect, useState, type FormEvent } from "react";

import { Badge, Card, ErrorBox, Modal, PageHeader, Spinner, Table } from "../components/ui";
import { api } from "../lib/api";
import { fmtDate, fmtDateTime } from "../lib/format";
import { useT } from "../lib/i18n";
import { useData, useSession } from "../lib/session";
import type { Company, ConnectionTest, DirectConnection, Role, User } from "../lib/types";

interface AgentRow {
  id: number;
  last_seen: string | null;
  version: string;
  revoked: boolean;
  created_at: string;
}

export function AdminPage() {
  const { companies, reloadCompanies } = useSession();
  const users = useData(() => api<User[]>("/api/admin/users"), []);
  const { t } = useT();
  const [editing, setEditing] = useState<Partial<User> & { password?: string } | null>(null);
  const [companyEdit, setCompanyEdit] = useState<Partial<Company> | null>(null);
  const [agentsFor, setAgentsFor] = useState<Company | null>(null);
  // null: closed; {}: connect a new base; a company: connect or edit that company's base.
  const [connectFor, setConnectFor] = useState<Partial<Company> | null>(null);

  return (
    <>
      <PageHeader title={t("admin.title")} subtitle={t("admin.subtitle")} />
      <div className="space-y-4">
        <Card title={t("admin.users")} actions={<button className="btn-primary" onClick={() => setEditing({ role: "viewer", is_active: true, company_ids: [] })}>{t("admin.newUser")}</button>}>
          <ErrorBox error={users.error} />
          {users.loading && <Spinner />}
          <Table>
            <thead>
              <tr>
                <th className="th">{t("admin.email")}</th>
                <th className="th">{t("admin.role")}</th>
                <th className="th">{t("admin.companies")}</th>
                <th className="th">{t("admin.twofa")}</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {(users.data ?? []).map((u) => (
                <tr key={u.id} className={u.is_active ? "" : "opacity-50"}>
                  <td className="td">{u.email}<div className="text-xs text-slate-500">{u.name}</div></td>
                  <td className="td">{t(`role.${u.role}`)}</td>
                  <td className="td text-xs">{u.role === "owner" ? t("common.all") : (u.company_ids ?? []).map((id) => companies.find((c) => c.id === id)?.name ?? id).join(", ") || t("common.none")}</td>
                  <td className="td">{u.totp_enabled ? t("admin.on") : "—"}</td>
                  <td className="td"><button className="btn-ghost text-xs" onClick={() => setEditing(u)}>{t("common.edit")}</button></td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card
          title={t("admin.companiesCard")}
          actions={
            <div className="flex flex-wrap gap-2">
              <button className="btn-secondary" onClick={() => setCompanyEdit({})}>{t("admin.addCompany")}</button>
              <button className="btn-primary" onClick={() => setConnectFor({})}>{t("admin.connectNew")}</button>
            </div>
          }
        >
          <Table>
            <thead>
              <tr>
                <th className="th">{t("admin.name")}</th>
                <th className="th">{t("common.inn")}</th>
                <th className="th">{t("admin.closedUntil")}</th>
                <th className="th">{t("admin.connection")}</th>
                <th className="th">{t("admin.lastSync")}</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id}>
                  <td className="td">{c.name}<div className="text-xs text-slate-500">{c.base_path}</div></td>
                  <td className="td">{c.inn}</td>
                  <td className="td">{fmtDate(c.closed_period_until)}</td>
                  <td className="td">
                    <Badge tone={c.connection_type === "odata" ? "blue" : "slate"}>{c.connection_type === "odata" ? t("admin.direct") : t("admin.viaAgent")}</Badge>{" "}
                    {c.agent_online ? t("admin.online") : t("admin.offline")}
                    {c.pending_commands ? ` · ${t("admin.queued", { n: c.pending_commands })}` : ""}
                  </td>
                  <td className="td text-xs">{fmtDateTime(c.last_synced_at)}</td>
                  <td className="td whitespace-nowrap">
                    <button className="btn-ghost text-xs" onClick={() => setCompanyEdit(c)}>{t("common.edit")}</button>
                    <button className="btn-ghost text-xs" onClick={() => setConnectFor(c)}>{t("admin.connect1c")}</button>
                    {c.connection_type !== "odata" && (
                      <button className="btn-ghost text-xs" onClick={() => setAgentsFor(c)}>{t("admin.agentToken")}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>

      {editing && <UserModal user={editing} companies={companies} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); users.reload(); }} />}
      {companyEdit && <CompanyModal company={companyEdit} onClose={() => setCompanyEdit(null)} onSaved={() => { setCompanyEdit(null); void reloadCompanies(); }} />}
      {agentsFor && <AgentModal company={agentsFor} onClose={() => setAgentsFor(null)} />}
      {connectFor && <ConnectModal company={connectFor} onClose={() => setConnectFor(null)} onSaved={() => { setConnectFor(null); void reloadCompanies(); }} />}
    </>
  );
}

function UserModal({ user, companies, onClose, onSaved }: { user: Partial<User> & { password?: string }; companies: Company[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useT();
  const [form, setForm] = useState({ email: user.email ?? "", name: user.name ?? "", password: "", role: (user.role ?? "viewer") as Role, is_active: user.is_active ?? true, company_ids: user.company_ids ?? [] });
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const body = { ...form, password: form.password || null };
      if (user.id) await api(`/api/admin/users/${user.id}`, { method: "PUT", json: body });
      else await api("/api/admin/users", { method: "POST", json: body });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const toggle = (id: number) => setForm((f) => ({ ...f, company_ids: f.company_ids.includes(id) ? f.company_ids.filter((x) => x !== id) : [...f.company_ids, id] }));

  return (
    <Modal open onClose={onClose} title={user.id ? t("admin.editUser") : t("admin.newUser")}>
      <form onSubmit={submit} className="space-y-3">
        <div><label className="label">{t("admin.email")}</label><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></div>
        <div><label className="label">{t("admin.name")}</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div><label className="label">{user.id ? t("admin.newPasswordKeep") : t("admin.passwordMin")}</label><input className="input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required={!user.id} /></div>
        <div>
          <label className="label">{t("admin.role")}</label>
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            <option value="owner">{t("admin.roleOwner")}</option>
            <option value="accountant">{t("admin.roleAccountant")}</option>
            <option value="viewer">{t("admin.roleViewer")}</option>
          </select>
        </div>
        {form.role !== "owner" && (
          <fieldset>
            <legend className="label">{t("admin.companiesLegend")}</legend>
            <div className="space-y-1">
              {companies.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.company_ids.includes(c.id)} onChange={() => toggle(c.id)} />{c.name}</label>
              ))}
            </div>
          </fieldset>
        )}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />{t("admin.active")}</label>
        <ErrorBox error={error} />
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>{t("common.cancel")}</button><button className="btn-primary">{t("common.save")}</button></div>
      </form>
    </Modal>
  );
}

function CompanyModal({ company, onClose, onSaved }: { company: Partial<Company>; onClose: () => void; onSaved: () => void }) {
  const { t } = useT();
  const [form, setForm] = useState({ name: company.name ?? "", inn: company.inn ?? "", base_path: company.base_path ?? "", closed_period_until: company.closed_period_until ?? "" });
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const body = { ...form, closed_period_until: form.closed_period_until || null };
      if (company.id) await api(`/api/admin/companies/${company.id}`, { method: "PUT", json: body });
      else await api("/api/admin/companies", { method: "POST", json: body });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title={company.id ? t("admin.editCompany") : t("admin.addCompany")}>
      <form onSubmit={submit} className="space-y-3">
        <div><label className="label">{t("admin.name")}</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
        <div><label className="label">{t("common.inn")}</label><input className="input" value={form.inn} onChange={(e) => setForm({ ...form, inn: e.target.value })} /></div>
        <div><label className="label">{t("admin.basePath")}</label><input className="input" placeholder="C:\1C\Bases\TEST_CRYSTAL" value={form.base_path} onChange={(e) => setForm({ ...form, base_path: e.target.value })} /></div>
        <div><label className="label">{t("admin.closedPeriod")}</label><input className="input" type="date" value={form.closed_period_until} onChange={(e) => setForm({ ...form, closed_period_until: e.target.value })} /></div>
        <ErrorBox error={error} />
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>{t("common.cancel")}</button><button className="btn-primary">{t("common.save")}</button></div>
      </form>
    </Modal>
  );
}

function AgentModal({ company, onClose }: { company: Company; onClose: () => void }) {
  const { t } = useT();
  const agents = useData(() => api<AgentRow[]>(`/api/admin/companies/${company.id}/agents`), [company.id]);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function issue() {
    if (!confirm(t("admin.confirmNewToken"))) return;
    try {
      setToken((await api<{ token: string }>(`/api/admin/companies/${company.id}/agents`, { method: "POST" })).token);
      agents.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function revoke(id: number) {
    await api(`/api/admin/agents/${id}/revoke`, { method: "POST" });
    agents.reload();
  }

  return (
    <Modal open onClose={onClose} title={t("admin.agentTitle", { company: company.name })}>
      <div className="space-y-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">{t("admin.agentText")}</p>
        {token && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
            <div className="mb-1 text-xs font-semibold">{t("admin.copyNow")}</div>
            <code className="block break-all text-xs">{token}</code>
          </div>
        )}
        <ErrorBox error={error} />
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {(agents.data ?? []).map((a) => (
            <li key={a.id} className="flex items-center justify-between py-2">
              <span>#{a.id} · {a.revoked ? t("admin.revoked") : t("admin.activeToken")} · {t("admin.lastSeen", { time: fmtDateTime(a.last_seen) })} {a.version && `· v${a.version}`}</span>
              {!a.revoked && <button className="btn-ghost text-xs text-red-600" onClick={() => revoke(a.id)}>{t("admin.revoke")}</button>}
            </li>
          ))}
        </ul>
        <button className="btn-primary" onClick={issue}>{t("admin.newToken")}</button>
      </div>
    </Modal>
  );
}

/** Connect a company to its 1C base directly: address, base name, 1C user and password. */
function ConnectModal({ company, onClose, onSaved }: { company: Partial<Company>; onClose: () => void; onSaved: () => void }) {
  const { t } = useT();
  const [form, setForm] = useState({ address: "", base: "", username: "", password: "" });
  const [orgRef, setOrgRef] = useState<string>("");
  const [hasSaved, setHasSaved] = useState(false);
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isNew = !company.id;

  useEffect(() => {
    if (!company.id) return;
    api<{ connection_type: string; direct: DirectConnection | null }>(`/api/admin/companies/${company.id}/connection`)
      .then((c) => {
        if (!c.direct) return;
        const host = c.direct.address.slice(0, c.direct.address.length - c.direct.base.length).replace(/\/$/, "");
        setForm({ address: host, base: c.direct.base, username: c.direct.username, password: "" });
        setHasSaved(true);
      })
      .catch(() => undefined);
  }, [company.id]);

  const body = () => ({ ...form, company_id: company.id ?? null });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => { setForm({ ...form, [key]: e.target.value }); setTest(null); };

  async function runTest() {
    setBusy("test");
    setError(null);
    try {
      const result = await api<ConnectionTest>("/api/admin/onec/test", { method: "POST", json: body() });
      setTest(result);
      if (result.organizations.length) setOrgRef(result.organizations[0].ref);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy("save");
    setError(null);
    try {
      if (isNew) await api("/api/admin/companies/connect", { method: "POST", json: { ...body(), organization_ref: orgRef || null } });
      else await api(`/api/admin/companies/${company.id}/connection`, { method: "POST", json: body() });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!company.id || !window.confirm(t("admin.confirmDisconnect"))) return;
    try {
      await api(`/api/admin/companies/${company.id}/connection`, { method: "DELETE" });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const total = test ? test.found.length + test.missing.length : 0;
  return (
    <Modal open onClose={onClose} title={isNew ? t("admin.connectNew") : t("admin.connectTitle", { company: company.name ?? "" })}>
      <form onSubmit={save} className="space-y-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">{t("admin.connectHelp")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label">{t("admin.address")}</label><input className="input" placeholder="192.168.1.10" value={form.address} onChange={set("address")} required autoFocus /></div>
          <div><label className="label">{t("admin.baseName")}</label><input className="input" placeholder="TEST_CRYSTAL" value={form.base} onChange={set("base")} /></div>
          <div><label className="label">{t("admin.user1c")}</label><input className="input" autoComplete="off" value={form.username} onChange={set("username")} required /></div>
          <div>
            <label className="label">{t("admin.password1c")}</label>
            <input className="input" type="password" autoComplete="new-password" placeholder={hasSaved ? t("admin.passwordKeep") : ""} value={form.password} onChange={set("password")} required={!hasSaved} />
          </div>
        </div>

        {test && !test.ok && <ErrorBox error={test.error ?? t("admin.testFailed")} />}
        {test?.ok && (
          <div className="space-y-2 rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-900 dark:bg-green-950/40">
            <div className="font-medium text-green-800 dark:text-green-300">✓ {t("admin.testOk")}</div>
            {test.organizations.length > 1 && isNew ? (
              <div>
                <label className="label">{t("admin.org")}</label>
                <select className="input" value={orgRef} onChange={(e) => setOrgRef(e.target.value)}>
                  {test.organizations.map((o) => <option key={o.ref} value={o.ref}>{o.name} · {o.inn}</option>)}
                </select>
              </div>
            ) : (
              test.organizations.map((o) => <div key={o.ref}>{t("admin.org")}: <b>{o.name}</b> · {t("common.inn")} {o.inn || "—"}</div>)
            )}
            <div>{t("admin.published", { found: test.found.length, total })}</div>
            {test.missing.length > 0 && (
              <div className="text-amber-800 dark:text-amber-300">{t("admin.missing", { list: test.missing.join(", ") })}</div>
            )}
          </div>
        )}

        <details className="text-xs text-slate-500 dark:text-slate-400">
          <summary className="cursor-pointer">{t("admin.connectSetupTitle")}</summary>
          <p className="mt-1 whitespace-pre-line">{t("admin.connectSetup")}</p>
        </details>
        <ErrorBox error={error} />
        <div className="flex flex-wrap justify-between gap-2">
          <div>
            {hasSaved && <button type="button" className="btn-ghost text-xs" onClick={disconnect}>{t("admin.disconnect")}</button>}
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={runTest} disabled={busy !== null || !form.address || !form.username}>
              {busy === "test" ? t("admin.testing") : t("admin.test")}
            </button>
            <button className="btn-primary" disabled={busy !== null}>{busy === "save" ? t("admin.testing") : t("admin.connectSave")}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
