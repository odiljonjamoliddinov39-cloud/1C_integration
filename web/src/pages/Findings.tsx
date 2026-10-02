import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { Card, Empty, ErrorBox, Modal, PageHeader, SeverityBadge, Spinner, StatusBadge } from "../components/ui";
import { api, download, qs } from "../lib/api";
import { fmtDate, fmtMoney } from "../lib/format";
import { useT, type Key } from "../lib/i18n";
import { useData, useSession } from "../lib/session";
import type { Counterparty, Finding, Fix } from "../lib/types";

interface Rule {
  code: string;
  severity: string;
  fix_type: string | null;
  title: string;
}

const FIELD_LABEL: Record<string, Key> = { inn: "find.fieldInn", ikpu_code: "find.fieldIkpu", vat_rate: "find.fieldVat", contract_ref: "find.fieldContract" };

export function FindingsPage() {
  const { companyId, company, canWrite, companies } = useSession();
  const { t } = useT();
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
        title={t("find.title")}
        subtitle={t("find.subtitle")}
        actions={
          <>
            {company && (
              <>
                <input type="month" className="input w-auto" value={month} onChange={(e) => setMonth(e.target.value)} aria-label={t("find.reportMonth")} />
                <button className="btn-secondary" onClick={() => download(`/api/companies/${company.id}/audit-report.pdf${qs({ month })}`, `audit-${company.name}-${month}.pdf`)}>
                  {t("find.report")}
                </button>
              </>
            )}
            {canWrite && company && <button className="btn-primary" onClick={runAudit}>{t("find.runAudit")}</button>}
            <button className="btn-ghost" onClick={() => download(`/api/findings${qs({ company_id: companyId, severity, rule, status, format: "xlsx" })}`, "findings.xlsx")}>{t("common.excel")}</button>
          </>
        }
      />
      <Card>
        <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <select className="input" value={severity} onChange={(e) => setFilter("severity", e.target.value)} aria-label={t("common.status")}>
            <option value="">{t("find.allSeverities")}</option>
            {["critical", "high", "medium", "low"].map((s) => <option key={s} value={s}>{t(`severity.${s}`)}</option>)}
          </select>
          <select className="input" value={rule} onChange={(e) => setFilter("rule", e.target.value)} aria-label={t("find.allRules")}>
            <option value="">{t("find.allRules")}</option>
            {(rules.data ?? []).map((r) => <option key={r.code} value={r.code}>{r.code}: {t(`rule.${r.code}`)}</option>)}
          </select>
          <select className="input" value={status} onChange={(e) => setFilter("status", e.target.value)} aria-label={t("common.status")}>
            {["open", "ignored", "fixed", "all"].map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
          </select>
        </div>
        <ErrorBox error={error ?? actionError} />
        {loading && <Spinner />}
        {data && data.length === 0 && <Empty>{t("find.empty")}</Empty>}
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {(data ?? []).map((f) => (
            <li key={f.id} className="py-3">
              <div className="flex flex-wrap items-start gap-2">
                <SeverityBadge severity={f.severity} />
                <span className="font-mono text-xs font-semibold text-slate-500" title={t(`rule.${f.rule_code}`)}>{f.rule_code}</span>
                {companyId === null && <span className="text-xs text-slate-500">{companyName(f.company_id)}</span>}
                {f.status !== "open" && <StatusBadge status={f.status} />}
                <span className="ml-auto text-xs text-slate-500">
                  {f.object_date ? fmtDate(f.object_date) : ""} {f.amount ? `· ${fmtMoney(f.amount)} ${t("common.currency")}` : ""}
                </span>
              </div>
              <p className="mt-1 text-sm">{f.message}</p>
              {f.ai_explanation && f.ai_explanation !== f.message && (
                <p className="mt-1 rounded-lg bg-slate-50 p-2 text-sm text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">{f.ai_explanation}</p>
              )}
              {typeof f.details.note === "string" && <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">{t("find.closedPeriod")}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                {f.object_type === "document" && (
                  <button className="btn-ghost text-xs" onClick={() => navigate(`/documents${qs({ company_id: f.company_id, refs: f.object_ref })}`)}>{t("find.openDocument")}</button>
                )}
                {Array.isArray(f.details.documents) && f.details.documents.length > 0 && (
                  <button className="btn-ghost text-xs" onClick={() => navigate(`/documents${qs({ company_id: f.company_id, refs: (f.details.documents as string[]).join(",") })}`)}>
                    {t("find.documentsBehind")}
                  </button>
                )}
                {!f.ai_explanation && (
                  <button className="btn-ghost text-xs" disabled={busy === f.id} onClick={() => act(f, () => api(`/api/findings/${f.id}/explain`, { method: "POST", json: {} }))}>
                    {t("find.explain")}
                  </button>
                )}
                {canWrite && f.status === "open" && f.fix_type && (
                  <button className="btn-primary text-xs" onClick={() => setFixFor(f)}>
                    {t("find.propose", { type: t(`fixType.${f.fix_type}`) })}
                  </button>
                )}
                {canWrite && f.status === "open" && (
                  <button className="btn-ghost text-xs" disabled={busy === f.id} onClick={() => act(f, () => api(`/api/findings/${f.id}/ignore`, { method: "POST" }))}>
                    {t("find.ignore")}
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
  const { t } = useT();
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
    <Modal open={finding !== null} onClose={onClose} title={t("find.modalTitle")}>
      {finding && (
        <div className="space-y-3">
          <p className="text-sm">{finding.message}</p>
          <p className="text-sm text-slate-500">
            {t("find.modalText", { type: t(`fixType.${finding.fix_type ?? ""}`) })}
          </p>
          {needsValue && field && (
            <div>
              <label className="label">{FIELD_LABEL[field] ? t(FIELD_LABEL[field]) : field}</label>
              {field === "contract_ref" ? (
                <select className="input" value={value} onChange={(e) => setValue(e.target.value)}>
                  <option value="">{t("find.chooseContract")}</option>
                  {(contracts.data?.[0]?.contracts ?? []).map((c) => (
                    <option key={c.ref} value={c.ref}>{c.name || `№${c.number}`}</option>
                  ))}
                </select>
              ) : field === "vat_rate" ? (
                <select className="input" value={value} onChange={(e) => setValue(e.target.value)}>
                  <option value="">{t("common.choose")}</option>
                  {["0", "12", "15"].map((r) => <option key={r} value={r}>{r}%</option>)}
                </select>
              ) : (
                <input className="input" value={value} onChange={(e) => setValue(e.target.value.trim())} autoFocus />
              )}
            </div>
          )}
          <ErrorBox error={error} />
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={onClose}>{t("common.cancel")}</button>
            <button className="btn-primary" onClick={submit} disabled={busy || (needsValue && !value)}>
              {busy ? t("find.preparing") : t("find.showChange")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
