import { useState } from "react";
import { useSearchParams } from "react-router-dom";

import { Card, Empty, ErrorBox, Modal, PageHeader, Spinner, StatusBadge, Table } from "../components/ui";
import { api, download, qs } from "../lib/api";
import { fmtDate, fmtMoney } from "../lib/format";
import { useT } from "../lib/i18n";
import { useData, useSession } from "../lib/session";
import type { DocumentRow } from "../lib/types";

interface DocDetail {
  document: (DocumentRow & { rows: Record<string, unknown>[] }) | null;
  entries: { date: string; dt: string; kt: string; amount: string }[];
}

const DOC_KEYS = ["sale", "purchase", "invoice_out", "invoice_in", "cash_in", "cash_out", "bank_in", "bank_out", "operation"];
const FILTER_KEYS = ["type", "from", "to", "counterparty_ref", "account", "refs", "posted"] as const;

export function DocumentsPage() {
  const { companyId, companies } = useSession();
  const { t } = useT();
  const docType = (type: string) => t(`doc.${type}`);
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
        title={t("docs.title")}
        subtitle={data ? t("docs.subtitle", { n: data.length, sum: fmtMoney(total), currency: t("common.currency") }) : undefined}
        actions={<button className="btn-secondary" onClick={() => download(`/api/documents${qs({ company_id: scopeCompany, ...filters, format: "xlsx" })}`, "documents.xlsx")}>{t("common.exportExcel")}</button>}
      />
      <Card>
        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
          <select className="input" value={filters.type} onChange={(e) => setFilter("type", e.target.value)} aria-label={t("common.type")}>
            <option value="">{t("docs.allTypes")}</option>
            {DOC_KEYS.map((k) => <option key={k} value={k}>{docType(k)}</option>)}
          </select>
          <input className="input" type="date" value={filters.from} onChange={(e) => setFilter("from", e.target.value)} aria-label={t("common.from")} />
          <input className="input" type="date" value={filters.to} onChange={(e) => setFilter("to", e.target.value)} aria-label={t("common.to")} />
          <input className="input" placeholder={t("docs.accountPlaceholder")} value={filters.account} onChange={(e) => setFilter("account", e.target.value)} />
          <select className="input" value={filters.posted} onChange={(e) => setFilter("posted", e.target.value)} aria-label={t("common.status")}>
            <option value="">{t("docs.postedAny")}</option>
            <option value="true">{t("docs.postedOnly")}</option>
            <option value="false">{t("docs.unpostedOnly")}</option>
          </select>
        </div>
        {(filters.counterparty_ref || filters.refs) && (
          <div className="mb-3 text-xs text-slate-500">
            {filters.counterparty_ref ? t("docs.filteredCounterparty") : t("docs.filteredRefs")} ·{" "}
            <button className="link" onClick={() => { setFilter("counterparty_ref", ""); setFilter("refs", ""); }}>{t("docs.clear")}</button>
          </div>
        )}
        <ErrorBox error={error} />
        {loading && <Spinner />}
        {data && data.length === 0 && <Empty>{t("docs.empty")}</Empty>}
        {data && data.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th className="th">{t("common.date")}</th>
                <th className="th">{t("common.type")}</th>
                <th className="th">{t("common.number")}</th>
                {companyId === null && <th className="th">{t("common.company")}</th>}
                <th className="th">{t("common.counterparty")}</th>
                <th className="th num">{t("common.amount")}</th>
                <th className="th num">{t("common.vat")}</th>
                <th className="th">{t("common.status")}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => setOpen(d)}>
                  <td className="td">{fmtDate(d.date)}</td>
                  <td className="td">{docType(d.type)}</td>
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

      <Modal open={open !== null} onClose={() => setOpen(null)} title={open ? t("docs.modalTitle", { type: docType(open.type), number: open.number, date: fmtDate(open.date) }) : ""} wide>
        {detail.loading && <Spinner />}
        {detail.data?.document && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div><span className="label">{t("common.counterparty")}</span>{open?.counterparty || "—"}</div>
              <div><span className="label">{t("common.amount")}</span>{fmtMoney(detail.data.document.amount)}</div>
              <div><span className="label">{t("common.vat")}</span>{fmtMoney(detail.data.document.vat)}</div>
              <div><span className="label">{t("docs.ref")}</span><code className="text-xs">{detail.data.document.ref_1c}</code></div>
            </div>
            {detail.data.document.rows.length > 0 && (
              <Table>
                <thead>
                  <tr>
                    <th className="th">#</th>
                    <th className="th">{t("common.item")}</th>
                    <th className="th num">{t("common.qty")}</th>
                    <th className="th num">{t("common.price")}</th>
                    <th className="th num">{t("common.amount")}</th>
                    <th className="th num">{t("common.vatPct")}</th>
                    <th className="th num">{t("common.vat")}</th>
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
              <h3 className="mb-1 text-sm font-semibold">{t("docs.entries")}</h3>
              <Table>
                <thead>
                  <tr>
                    <th className="th">{t("common.dt")}</th>
                    <th className="th">{t("common.kt")}</th>
                    <th className="th num">{t("common.amount")}</th>
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
                    <tr><td className="td text-slate-500" colSpan={3}>{t("docs.noEntries")}</td></tr>
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
