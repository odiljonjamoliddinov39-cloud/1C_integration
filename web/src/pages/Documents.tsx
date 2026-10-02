import { useState } from "react";
import { useSearchParams } from "react-router-dom";

import { Card, Empty, ErrorBox, Modal, PageHeader, Spinner, StatusBadge, Table } from "../components/ui";
import { api, download, qs } from "../lib/api";
import { DOC_TYPES, fmtDate, fmtMoney } from "../lib/format";
import { useData, useSession } from "../lib/session";
import type { DocumentRow } from "../lib/types";

interface DocDetail {
  document: (DocumentRow & { rows: Record<string, unknown>[] }) | null;
  entries: { date: string; dt: string; kt: string; amount: string }[];
}

const FILTER_KEYS = ["type", "from", "to", "counterparty_ref", "account", "refs", "posted"] as const;

export function DocumentsPage() {
  const { companyId, companies } = useSession();
  const [params, setParams] = useSearchParams();
  const scopeCompany = params.get("company_id") ? Number(params.get("company_id")) : companyId;
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ""]));
  const query = qs({ company_id: scopeCompany, ...filters });
  const { data, error, loading } = useData(() => api<DocumentRow[]>(`/api/documents${query}`), [query]);
  const [open, setOpen] = useState<DocumentRow | null>(null);
  const detail = useData<DocDetail | null>(() => (open ? api<DocDetail>(`/api/documents/${open.company_id}/${open.ref_1c}`) : Promise.resolve(null)), [open?.ref_1c]);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  }

  const total = (data ?? []).reduce((s, d) => s + Number(d.amount), 0);
  const companyName = (id: number) => companies.find((c) => c.id === id)?.name ?? id;

  return (
    <>
      <PageHeader
        title="Documents"
        subtitle={data ? `${data.length} documents · total ${fmtMoney(total)} UZS` : undefined}
        actions={<button className="btn-secondary" onClick={() => download(`/api/documents${qs({ company_id: scopeCompany, ...filters, format: "xlsx" })}`, "documents.xlsx")}>Export to Excel</button>}
      />
      <Card>
        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
          <select className="input" value={filters.type} onChange={(e) => setFilter("type", e.target.value)} aria-label="Type">
            <option value="">All types</option>
            {Object.entries(DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input className="input" type="date" value={filters.from} onChange={(e) => setFilter("from", e.target.value)} aria-label="From" />
          <input className="input" type="date" value={filters.to} onChange={(e) => setFilter("to", e.target.value)} aria-label="To" />
          <input className="input" placeholder="Account, e.g. 5010" value={filters.account} onChange={(e) => setFilter("account", e.target.value)} />
          <select className="input" value={filters.posted} onChange={(e) => setFilter("posted", e.target.value)} aria-label="Posted">
            <option value="">Posted and unposted</option>
            <option value="true">Posted</option>
            <option value="false">Unposted</option>
          </select>
        </div>
        {(filters.counterparty_ref || filters.refs) && (
          <div className="mb-3 text-xs text-slate-500">
            Filtered by {filters.counterparty_ref ? "counterparty" : "selected documents"} ·{" "}
            <button className="link" onClick={() => { setFilter("counterparty_ref", ""); setFilter("refs", ""); }}>clear</button>
          </div>
        )}
        <ErrorBox error={error} />
        {loading && <Spinner />}
        {data && data.length === 0 && <Empty>No documents match these filters.</Empty>}
        {data && data.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th className="th">Date</th>
                <th className="th">Type</th>
                <th className="th">Number</th>
                {companyId === null && <th className="th">Company</th>}
                <th className="th">Counterparty</th>
                <th className="th num">Amount</th>
                <th className="th num">VAT</th>
                <th className="th">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => setOpen(d)}>
                  <td className="td">{fmtDate(d.date)}</td>
                  <td className="td">{DOC_TYPES[d.type] ?? d.type}</td>
                  <td className="td">{d.number}</td>
                  {companyId === null && <td className="td">{companyName(d.company_id)}</td>}
                  <td className="td">{d.counterparty}</td>
                  <td className="td num">{fmtMoney(d.amount)}</td>
                  <td className="td num">{fmtMoney(d.vat)}</td>
                  <td className="td"><StatusBadge status={d.posted ? "posted" : "draft"} /></td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal open={open !== null} onClose={() => setOpen(null)} title={open ? `${DOC_TYPES[open.type] ?? open.type} №${open.number} от ${fmtDate(open.date)}` : ""} wide>
        {detail.loading && <Spinner />}
        {detail.data?.document && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div><span className="label">Counterparty</span>{open?.counterparty || "—"}</div>
              <div><span className="label">Amount</span>{fmtMoney(detail.data.document.amount)}</div>
              <div><span className="label">VAT</span>{fmtMoney(detail.data.document.vat)}</div>
              <div><span className="label">1C ref</span><code className="text-xs">{detail.data.document.ref_1c}</code></div>
            </div>
            {detail.data.document.rows.length > 0 && (
              <Table>
                <thead>
                  <tr>
                    <th className="th">#</th>
                    <th className="th">Item</th>
                    <th className="th num">Qty</th>
                    <th className="th num">Price</th>
                    <th className="th num">Amount</th>
                    <th className="th num">VAT %</th>
                    <th className="th num">VAT</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.document.rows.map((r, i) => (
                    <tr key={i}>
                      <td className="td">{i + 1}</td>
                      <td className="td text-xs">{String(r.item_ref ?? "")}</td>
                      <td className="td num">{String(r.quantity ?? "")}</td>
                      <td className="td num">{fmtMoney(r.price as string)}</td>
                      <td className="td num">{fmtMoney(r.amount as string)}</td>
                      <td className="td num">{String(r.vat_rate ?? "")}</td>
                      <td className="td num">{fmtMoney(r.vat_amount as string)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <div>
              <h3 className="mb-1 text-sm font-semibold">Journal entries</h3>
              <Table>
                <thead>
                  <tr>
                    <th className="th">Dt</th>
                    <th className="th">Kt</th>
                    <th className="th num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.entries.map((e, i) => (
                    <tr key={i}>
                      <td className="td">{e.dt}</td>
                      <td className="td">{e.kt}</td>
                      <td className="td num">{fmtMoney(e.amount)}</td>
                    </tr>
                  ))}
                  {detail.data.entries.length === 0 && (
                    <tr><td className="td text-slate-500" colSpan={3}>No entries (unposted or no accounting effect)</td></tr>
                  )}
                </tbody>
              </Table>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
