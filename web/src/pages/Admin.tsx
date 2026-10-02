import { useState, type FormEvent } from "react";

import { Card, ErrorBox, Modal, PageHeader, Spinner, Table } from "../components/ui";
import { api } from "../lib/api";
import { fmtDate, fmtDateTime } from "../lib/format";
import { useData, useSession } from "../lib/session";
import type { Company, Role, User } from "../lib/types";

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
  const [editing, setEditing] = useState<Partial<User> & { password?: string } | null>(null);
  const [companyEdit, setCompanyEdit] = useState<Partial<Company> | null>(null);
  const [agentsFor, setAgentsFor] = useState<Company | null>(null);

  return (
    <>
      <PageHeader title="Admin" subtitle="Users, roles, company access and the agent token of each 1C base." />
      <div className="space-y-4">
        <Card title="Users" actions={<button className="btn-primary" onClick={() => setEditing({ role: "viewer", is_active: true, company_ids: [] })}>New user</button>}>
          <ErrorBox error={users.error} />
          {users.loading && <Spinner />}
          <Table>
            <thead>
              <tr>
                <th className="th">Email</th>
                <th className="th">Role</th>
                <th className="th">Companies</th>
                <th className="th">2FA</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {(users.data ?? []).map((u) => (
                <tr key={u.id} className={u.is_active ? "" : "opacity-50"}>
                  <td className="td">{u.email}<div className="text-xs text-slate-500">{u.name}</div></td>
                  <td className="td capitalize">{u.role}</td>
                  <td className="td text-xs">{u.role === "owner" ? "All" : (u.company_ids ?? []).map((id) => companies.find((c) => c.id === id)?.name ?? id).join(", ") || "None"}</td>
                  <td className="td">{u.totp_enabled ? "On" : "—"}</td>
                  <td className="td"><button className="btn-ghost text-xs" onClick={() => setEditing(u)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card title="Companies (1C bases)" actions={<button className="btn-primary" onClick={() => setCompanyEdit({})}>Add company</button>}>
          <Table>
            <thead>
              <tr>
                <th className="th">Name</th>
                <th className="th">INN</th>
                <th className="th">Closed until</th>
                <th className="th">Agent</th>
                <th className="th">Last sync</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id}>
                  <td className="td">{c.name}<div className="text-xs text-slate-500">{c.base_path}</div></td>
                  <td className="td">{c.inn}</td>
                  <td className="td">{fmtDate(c.closed_period_until)}</td>
                  <td className="td">{c.agent_online ? "online" : "offline"}{c.pending_commands ? ` · ${c.pending_commands} queued` : ""}</td>
                  <td className="td text-xs">{fmtDateTime(c.last_synced_at)}</td>
                  <td className="td whitespace-nowrap">
                    <button className="btn-ghost text-xs" onClick={() => setCompanyEdit(c)}>Edit</button>
                    <button className="btn-ghost text-xs" onClick={() => setAgentsFor(c)}>Agent token</button>
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
    </>
  );
}

function UserModal({ user, companies, onClose, onSaved }: { user: Partial<User> & { password?: string }; companies: Company[]; onClose: () => void; onSaved: () => void }) {
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
    <Modal open onClose={onClose} title={user.id ? "Edit user" : "New user"}>
      <form onSubmit={submit} className="space-y-3">
        <div><label className="label">Email</label><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></div>
        <div><label className="label">Name</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div><label className="label">{user.id ? "New password (leave empty to keep)" : "Password (min 10 characters)"}</label><input className="input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required={!user.id} /></div>
        <div>
          <label className="label">Role</label>
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            <option value="owner">Owner: everything, manage users and companies</option>
            <option value="accountant">Accountant: create invoices, approve fixes, ignore findings</option>
            <option value="viewer">Viewer: dashboards and reports only</option>
          </select>
        </div>
        {form.role !== "owner" && (
          <fieldset>
            <legend className="label">Companies this user can see</legend>
            <div className="space-y-1">
              {companies.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.company_ids.includes(c.id)} onChange={() => toggle(c.id)} />{c.name}</label>
              ))}
            </div>
          </fieldset>
        )}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />Active</label>
        <ErrorBox error={error} />
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary">Save</button></div>
      </form>
    </Modal>
  );
}

function CompanyModal({ company, onClose, onSaved }: { company: Partial<Company>; onClose: () => void; onSaved: () => void }) {
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
    <Modal open onClose={onClose} title={company.id ? "Edit company" : "Add company"}>
      <form onSubmit={submit} className="space-y-3">
        <div><label className="label">Name</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
        <div><label className="label">INN</label><input className="input" value={form.inn} onChange={(e) => setForm({ ...form, inn: e.target.value })} /></div>
        <div><label className="label">1C base (for reference)</label><input className="input" placeholder="C:\1C\Bases\TEST_CRYSTAL" value={form.base_path} onChange={(e) => setForm({ ...form, base_path: e.target.value })} /></div>
        <div><label className="label">Closed period until (also read from 1C on every sync)</label><input className="input" type="date" value={form.closed_period_until} onChange={(e) => setForm({ ...form, closed_period_until: e.target.value })} /></div>
        <ErrorBox error={error} />
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary">Save</button></div>
      </form>
    </Modal>
  );
}

function AgentModal({ company, onClose }: { company: Company; onClose: () => void }) {
  const agents = useData(() => api<AgentRow[]>(`/api/admin/companies/${company.id}/agents`), [company.id]);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function issue() {
    if (!confirm("Issue a new token? The current one stops working immediately.")) return;
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
    <Modal open onClose={onClose} title={`Agent token: ${company.name}`}>
      <div className="space-y-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">One token per company. Put it in <code>agent.ini</code> on the laptop under <code>[base:…]</code> → <code>agent_token</code>. Only its hash is stored here.</p>
        {token && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
            <div className="mb-1 text-xs font-semibold">Copy it now. It will not be shown again:</div>
            <code className="block break-all text-xs">{token}</code>
          </div>
        )}
        <ErrorBox error={error} />
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {(agents.data ?? []).map((a) => (
            <li key={a.id} className="flex items-center justify-between py-2">
              <span>#{a.id} · {a.revoked ? "revoked" : "active"} · last seen {fmtDateTime(a.last_seen)} {a.version && `· v${a.version}`}</span>
              {!a.revoked && <button className="btn-ghost text-xs text-red-600" onClick={() => revoke(a.id)}>Revoke</button>}
            </li>
          ))}
        </ul>
        <button className="btn-primary" onClick={issue}>New agent token</button>
      </div>
    </Modal>
  );
}
