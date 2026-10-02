import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { Card, Empty, ErrorBox, PageHeader, SeverityBadge, Spinner, StatusBadge, Table } from "../components/ui";
import { api, qs } from "../lib/api";
import { FIX_TYPES, fmtDateTime, fmtMoney } from "../lib/format";
import { useData, useSession } from "../lib/session";
import type { Fix } from "../lib/types";

const MAX_BULK = 50;

export function FixesPage() {
  const { companyId, canWrite } = useSession();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "proposed";
  const { data, error, loading, reload } = useData(() => api<Fix[]>(`/api/fixes${qs({ company_id: companyId, status: status === "all" ? "" : status })}`), [companyId, status]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedFixes = (data ?? []).filter((f) => selected.has(f.id));
  const sameType = new Set(selectedFixes.map((f) => f.fix_type)).size <= 1;

  function toggle(fix: Fix) {
    const next = new Set(selected);
    if (next.has(fix.id)) next.delete(fix.id);
    else next.add(fix.id);
    setSelected(next);
  }

  async function approveSelected() {
    setBusy(true);
    setActionError(null);
    try {
      await api("/api/fixes/approve", { method: "POST", json: { fix_ids: [...selected] } });
      setSelected(new Set());
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Corrections"
        subtitle="The system never changes the books on its own: a person approves each correction, then the agent writes it to 1C."
        actions={
          canWrite && status === "proposed" && (
            <button className="btn-primary" disabled={busy || selected.size === 0 || selected.size > MAX_BULK || !sameType} onClick={approveSelected} title={!sameType ? "Bulk approval needs fixes of the same type" : undefined}>
              Approve {selected.size || ""} selected
            </button>
          )
        }
      />
      <Card>
        <div className="mb-3 flex flex-wrap gap-1">
          {["proposed", "approved", "applied", "failed", "rejected", "all"].map((s) => (
            <button key={s} className={s === status ? "btn-primary" : "btn-ghost"} onClick={() => { setSelected(new Set()); setParams({ status: s }); }}>
              {s}
            </button>
          ))}
        </div>
        <ErrorBox error={error ?? actionError} />
        {!sameType && <p className="mb-2 text-xs text-amber-600">Select fixes of one type to approve them together (max {MAX_BULK}).</p>}
        {loading && <Spinner />}
        {data && data.length === 0 && <Empty>No corrections with status “{status}”.</Empty>}
        {data && data.length > 0 && (
          <Table>
            <thead>
              <tr>
                {canWrite && status === "proposed" && <th className="th w-8" />}
                <th className="th">#</th>
                <th className="th">Type</th>
                <th className="th">Explanation</th>
                <th className="th">Status</th>
                <th className="th">Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.map((f) => (
                <tr key={f.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  {canWrite && status === "proposed" && (
                    <td className="td">
                      <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggle(f)} aria-label={`Select fix ${f.id}`} />
                    </td>
                  )}
                  <td className="td"><Link className="link" to={`/fixes/${f.id}`}>#{f.id}</Link></td>
                  <td className="td">{FIX_TYPES[f.fix_type] ?? f.fix_type}</td>
                  <td className="td max-w-md truncate text-slate-600 dark:text-slate-300">{f.explanation}</td>
                  <td className="td"><StatusBadge status={f.status} /></td>
                  <td className="td text-xs text-slate-500">{fmtDateTime(f.applied_at ?? f.approved_at ?? f.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}

function Value({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") return <span className="text-slate-400">empty</span>;
  if (typeof value === "object") return <pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(value, null, 2)}</pre>;
  return <span>{String(value)}</span>;
}

function Side({ title, data, tone }: { title: string; data: Record<string, unknown> | null | undefined; tone: "old" | "new" }) {
  const rows = Object.entries(data ?? {}).filter(([k]) => k !== "rows");
  const tableRows = (data?.rows as Record<string, unknown>[] | undefined) ?? null;
  return (
    <div className={`rounded-lg border p-3 ${tone === "new" ? "border-emerald-300 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/30" : "border-slate-200 dark:border-slate-800"}`}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      <dl className="space-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[8rem_1fr] gap-2">
            <dt className="text-slate-500">{k}</dt>
            <dd><Value value={v} /></dd>
          </div>
        ))}
      </dl>
      {tableRows && (
        <table className="mt-2 w-full text-xs">
          <thead>
            <tr>{Object.keys(tableRows[0] ?? {}).map((k) => <th key={k} className="pb-1 text-left font-medium text-slate-500">{k}</th>)}</tr>
          </thead>
          <tbody>
            {tableRows.map((r, i) => (
              <tr key={i}>{Object.values(r).map((v, j) => <td key={j} className="py-0.5 pr-2">{String(v ?? "")}</td>)}</tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function FixDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canWrite } = useSession();
  const { data: fix, error, loading, reload } = useData(() => api<Fix>(`/api/fixes/${id}`), [id]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // While the agent applies the fix (or the laptop is offline), poll for the result.
  useEffect(() => {
    if (fix?.status !== "approved") return;
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fix?.status]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading && !fix) return <Spinner />;
  if (!fix) return <ErrorBox error={error} />;
  const preview = fix.preview;

  return (
    <>
      <PageHeader
        title={`Correction #${fix.id}: ${FIX_TYPES[fix.fix_type] ?? fix.fix_type}`}
        subtitle={<>Status <StatusBadge status={fix.status} /> {fix.approval_id && <span className="ml-2 font-mono text-xs">approval {fix.approval_id}</span>}</>}
        actions={
          <>
            {canWrite && fix.status === "proposed" && (
              <>
                <button className="btn-secondary" disabled={busy} onClick={() => run(() => api(`/api/fixes/${fix.id}/reject`, { method: "POST" }))}>Reject</button>
                <button className="btn-primary" disabled={busy} onClick={() => run(() => api("/api/fixes/approve", { method: "POST", json: { fix_ids: [fix.id] } }))}>Approve</button>
              </>
            )}
            {canWrite && fix.status === "applied" && fix.before && (
              <button className="btn-secondary" disabled={busy} onClick={() => run(async () => { const undo = await api<Fix>(`/api/fixes/${fix.id}/undo`, { method: "POST", json: {} }); navigate(`/fixes/${undo.id}`); })}>
                Undo this fix
              </button>
            )}
          </>
        }
      />
      <ErrorBox error={actionError} />
      <div className="space-y-4">
        {fix.status === "approved" && <div className="rounded-lg bg-brand-50 p-3 text-sm dark:bg-brand-700/20">Approved, waiting for the agent. If the laptop is offline, the change runs as soon as it reconnects.</div>}
        {fix.result && fix.status !== "proposed" && <p className="text-sm text-slate-600 dark:text-slate-300">Result: {fix.result}</p>}
        {fix.finding && (
          <Card title="Finding">
            <div className="flex items-center gap-2">
              <SeverityBadge severity={fix.finding.severity} />
              <span className="font-mono text-xs">{fix.finding.rule_code}</span>
              <StatusBadge status={fix.finding.status} />
            </div>
            <p className="mt-1 text-sm">{fix.finding.message}</p>
          </Card>
        )}
        {(fix.explanation || fix.finding?.ai_explanation) && (
          <Card title="Why">
            <p className="whitespace-pre-wrap text-sm">{fix.finding?.ai_explanation || fix.explanation}</p>
          </Card>
        )}
        <Card title={fix.status === "applied" ? "Before and after (from 1C)" : "Current value and proposed change"}>
          <div className="grid gap-3 md:grid-cols-2">
            {fix.status === "applied" ? (
              <>
                <Side title="Before" data={fix.before} tone="old" />
                <Side title="After" data={fix.after} tone="new" />
              </>
            ) : (
              <>
                <Side title="Now in 1C" data={preview?.current} tone="old" />
                <Side title="Proposed" data={preview?.proposed} tone="new" />
              </>
            )}
          </div>
        </Card>
        {preview && preview.affected_entries.length > 0 && (
          <Card title="Affected entries">
            <Table>
              <thead>
                <tr>
                  <th className="th">Dt</th>
                  <th className="th">Kt</th>
                  <th className="th num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {preview.affected_entries.map((e, i) => (
                  <tr key={i}>
                    <td className="td">{e.dt}</td>
                    <td className="td">{e.kt}</td>
                    <td className="td num">{fmtMoney(e.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}
      </div>
    </>
  );
}
