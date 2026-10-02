import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { Card, Empty, ErrorBox, Modal, PageHeader, SeverityBadge, Spinner, StatusBadge } from "../components/ui";
import { api, download, qs } from "../lib/api";
import { FIX_TYPES, fmtDate, fmtMoney } from "../lib/format";
import { useData, useSession } from "../lib/session";
import type { Counterparty, Finding, Fix } from "../lib/types";

interface Rule {
  code: string;
  severity: string;
  fix_type: string | null;
  title: string;
}

const FIELD_LABEL: Record<string, string> = { inn: "INN (9 or 14 digits)", ikpu_code: "IKPU code (17 digits)", vat_rate: "VAT rate", contract_ref: "Contract" };

export function FindingsPage() {
  const { companyId, company, canWrite, companies } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const severity = params.get("severity") ?? "";
  const rule = params.get("rule") ?? "";
  const status = params.get("status") ?? "open";
  const query = qs({ company_id: companyId, severity, rule, status });
  const { data, error, loading, reload } = useData(() => api<Finding[]>(`/api/findings${query}`), [query]);
  const rules = useData(() => api<Rule[]>("/api/audit/rules"), []);
  const [actionError, setActionError] = useState<string | null>(null);
  const [fixFor, setFixFor] = useState<Finding | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  }

  async function act(f: Finding, fn: () => Promise<unknown>) {
    setBusy(f.id);
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function runAudit() {
    if (!company) return;
    setActionError(null);
    try {
      await api(`/api/companies/${company.id}/audit`, { method: "POST" });
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  const companyName = (id: number) => companies.find((c) => c.id === id)?.name ?? id;

  return (
    <>
      <PageHeader
        title="Audit findings"
        subtitle="Rules run after every sync and nightly at 02:00. Ignored findings stay hidden until their data changes."
        actions={
          <>
            {company && (
              <>
                <input type="month" className="input w-auto" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Report month" />
                <button className="btn-secondary" onClick={() => download(`/api/companies/${company.id}/audit-report.pdf${qs({ month })}`, `audit-${company.name}-${month}.pdf`)}>
                  Monthly report (PDF)
                </button>
              </>
            )}
            {canWrite && company && <button className="btn-primary" onClick={runAudit}>Run audit now</button>}
            <button className="btn-ghost" onClick={() => download(`/api/findings${qs({ company_id: companyId, severity, rule, status, format: "xlsx" })}`, "findings.xlsx")}>Excel</button>
          </>
        }
      />
      <Card>
        <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <select className="input" value={severity} onChange={(e) => setFilter("severity", e.target.value)} aria-label="Severity">
            <option value="">All severities</option>
            {["critical", "high", "medium", "low"].map((s) => <option key={s}>{s}</option>)}
          </select>
          <select className="input" value={rule} onChange={(e) => setFilter("rule", e.target.value)} aria-label="Rule">
            <option value="">All rules</option>
            {(rules.data ?? []).map((r) => <option key={r.code} value={r.code}>{r.code}: {r.title}</option>)}
          </select>
          <select className="input" value={status} onChange={(e) => setFilter("status", e.target.value)} aria-label="Status">
            <option value="open">Open</option>
            <option value="ignored">Ignored</option>
            <option value="fixed">Fixed</option>
            <option value="all">All</option>
          </select>
        </div>
        <ErrorBox error={error ?? actionError} />
        {loading && <Spinner />}
        {data && data.length === 0 && <Empty>No findings here. 🎉</Empty>}
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {(data ?? []).map((f) => (
            <li key={f.id} className="py-3">
              <div className="flex flex-wrap items-start gap-2">
                <SeverityBadge severity={f.severity} />
                <span className="font-mono text-xs font-semibold text-slate-500">{f.rule_code}</span>
                {companyId === null && <span className="text-xs text-slate-500">{companyName(f.company_id)}</span>}
                {f.status !== "open" && <StatusBadge status={f.status} />}
                <span className="ml-auto text-xs text-slate-500">
                  {f.object_date ? fmtDate(f.object_date) : ""} {f.amount ? `· ${fmtMoney(f.amount)} UZS` : ""}
                </span>
              </div>
              <p className="mt-1 text-sm">{f.message}</p>
              {f.ai_explanation && f.ai_explanation !== f.message && (
                <p className="mt-1 rounded-lg bg-slate-50 p-2 text-sm text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">{f.ai_explanation}</p>
              )}
              {typeof f.details.note === "string" && <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">Closed period: {f.details.note}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                {f.object_type === "document" && (
                  <button className="btn-ghost text-xs" onClick={() => navigate(`/documents${qs({ company_id: f.company_id, refs: f.object_ref })}`)}>Open document</button>
                )}
                {Array.isArray(f.details.documents) && f.details.documents.length > 0 && (
                  <button className="btn-ghost text-xs" onClick={() => navigate(`/documents${qs({ company_id: f.company_id, refs: (f.details.documents as string[]).join(",") })}`)}>
                    Documents behind it
                  </button>
                )}
                {!f.ai_explanation && (
                  <button className="btn-ghost text-xs" disabled={busy === f.id} onClick={() => act(f, () => api(`/api/findings/${f.id}/explain`, { method: "POST", json: {} }))}>
                    Explain with AI
                  </button>
                )}
                {canWrite && f.status === "open" && f.fix_type && (
                  <button className="btn-primary text-xs" onClick={() => setFixFor(f)}>
                    Propose fix: {FIX_TYPES[f.fix_type]}
                  </button>
                )}
                {canWrite && f.status === "open" && (
                  <button className="btn-ghost text-xs" disabled={busy === f.id} onClick={() => act(f, () => api(`/api/findings/${f.id}/ignore`, { method: "POST" }))}>
                    Ignore
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>
      <ProposeFixModal finding={fixFor} onClose={() => setFixFor(null)} onCreated={(fix) => navigate(`/fixes/${fix.id}`)} />
    </>
  );
}

function ProposeFixModal({ finding, onClose, onCreated }: { finding: Finding | null; onClose: () => void; onCreated: (fix: Fix) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = finding?.details.field as string | undefined;
  const needsValue = finding?.fix_type === "fill_field" && !finding.details.suggested;
  const cpRef = finding?.details.counterparty_ref as string | undefined;
  const contracts = useData<Counterparty[]>(
    () => (finding && field === "contract_ref" && cpRef ? api<Counterparty[]>(`/api/companies/${finding.company_id}/counterparties${qs({ ref: cpRef })}`) : Promise.resolve([])),
    [finding?.id],
  );

  async function submit() {
    if (!finding) return;
    setBusy(true);
    setError(null);
    try {
      const fix = await api<Fix>("/api/fixes", { method: "POST", json: { finding_id: finding.id, params: value ? { value } : {} } });
      onCreated(fix);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={finding !== null} onClose={onClose} title="Propose a correction">
      {finding && (
        <div className="space-y-3">
          <p className="text-sm">{finding.message}</p>
          <p className="text-sm text-slate-500">
            Fix: <strong>{FIX_TYPES[finding.fix_type ?? ""]}</strong>. Nothing changes in 1C until an owner or accountant approves it on the next screen.
          </p>
          {needsValue && field && (
            <div>
              <label className="label">{FIELD_LABEL[field] ?? field}</label>
              {field === "contract_ref" ? (
                <select className="input" value={value} onChange={(e) => setValue(e.target.value)}>
                  <option value="">Choose a contract…</option>
                  {(contracts.data?.[0]?.contracts ?? []).map((c) => (
                    <option key={c.ref} value={c.ref}>{c.name || `№${c.number}`}</option>
                  ))}
                </select>
              ) : field === "vat_rate" ? (
                <select className="input" value={value} onChange={(e) => setValue(e.target.value)}>
                  <option value="">Choose…</option>
                  {["0", "12", "15"].map((r) => <option key={r} value={r}>{r}%</option>)}
                </select>
              ) : (
                <input className="input" value={value} onChange={(e) => setValue(e.target.value.trim())} autoFocus />
              )}
            </div>
          )}
          <ErrorBox error={error} />
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" onClick={submit} disabled={busy || (needsValue && !value)}>
              {busy ? "Preparing…" : "Show proposed change"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
