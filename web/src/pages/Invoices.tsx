import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { Card, Empty, ErrorBox, PageHeader, Spinner, StatusBadge, Table } from "../components/ui";
import { api, ApiError, download, qs } from "../lib/api";
import { fmtDate, fmtMoney, today } from "../lib/format";
import { useT } from "../lib/i18n";
import { useData, useSession } from "../lib/session";
import type { Counterparty, Invoice, InvoiceRow, Item, ValidationError } from "../lib/types";

function errorsFrom(e: unknown): { message: string; errors: ValidationError[] } {
  if (e instanceof ApiError && e.detail && typeof e.detail === "object" && "errors" in e.detail) {
    return { message: e.message, errors: (e.detail as { errors: ValidationError[] }).errors };
  }
  return { message: (e as Error).message, errors: [] };
}

function NeedCompany() {
  const { t } = useT();
  return <Empty>{t("inv.needCompany")}</Empty>;
}

export function InvoicesPage() {
  const { companyId, canWrite } = useSession();
  const { t } = useT();
  const navigate = useNavigate();
  const { data, error, loading } = useData(() => api<Invoice[]>(`/api/invoices${qs({ company_id: companyId })}`), [companyId]);
  return (
    <>
      <PageHeader
        title={t("inv.title")}
        subtitle={t("inv.subtitle")}
        actions={
          canWrite && companyId !== null && (
            <>
              <button className="btn-secondary" onClick={() => navigate("/invoices/bulk")}>{t("inv.bulk")}</button>
              <button className="btn-primary" onClick={() => navigate("/invoices/new")}>{t("inv.new")}</button>
            </>
          )
        }
      />
      <Card>
        <ErrorBox error={error} />
        {loading && <Spinner />}
        {data && data.length === 0 && <Empty>{t("inv.empty")}</Empty>}
        {data && data.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th className="th">{t("common.date")}</th>
                <th className="th">{t("inv.number1c")}</th>
                <th className="th">{t("inv.buyer")}</th>
                <th className="th num">{t("common.total")}</th>
                <th className="th num">{t("common.vat")}</th>
                <th className="th">{t("common.status")}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((i) => (
                <tr key={i.id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => navigate(`/invoices/${i.id}`)}>
                  <td className="td">{fmtDate(i.date)}</td>
                  <td className="td">{i.number || <span className="text-slate-400">—</span>}</td>
                  <td className="td">{i.buyer_name} <span className="text-xs text-slate-500">{i.buyer_inn}</span></td>
                  <td className="td num">{fmtMoney(i.total)}</td>
                  <td className="td num">{fmtMoney(i.vat)}</td>
                  <td className="td"><StatusBadge status={i.status} /></td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Search<T>({ placeholder, load, render, onPick, initial }: { placeholder: string; load: (q: string) => Promise<T[]>; render: (t: T) => React.ReactNode; onPick: (t: T) => void; initial?: string }) {
  const [q, setQ] = useState(initial ?? "");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<T[]>([]);
  const dq = useDebounced(q);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setQ(initial ?? ""), [initial]);
  useEffect(() => {
    if (!open) return;
    load(dq).then(setResults).catch(() => setResults([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq, open]);
  useEffect(() => {
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  return (
    <div className="relative" ref={box}>
      <input className="input" placeholder={placeholder} value={q} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} />
      {open && results.length > 0 && (
        <ul className="card absolute z-20 mt-1 max-h-64 w-full overflow-y-auto py-1 text-sm">
          {results.map((r, i) => (
            <li key={i}>
              <button type="button" className="w-full px-3 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => { onPick(r); setOpen(false); }}>
                {render(r)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const emptyRow = (): InvoiceRow => ({ item_ref: "", quantity: 1 });

function rowTotals(r: InvoiceRow) {
  const amount = Math.round(Number(r.quantity || 0) * Number(r.price || 0) * 100) / 100;
  const vat = Math.round(amount * Number(r.vat_rate || 0)) / 100;
  return { amount, vat };
}

export function InvoiceFormPage() {
  const { id } = useParams();
  const isNew = id === undefined;
  const navigate = useNavigate();
  const { companyId, canWrite } = useSession();
  const { t, ts } = useT();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [date, setDate] = useState(today());
  const [buyer, setBuyer] = useState<Counterparty | null>(null);
  const [contractRef, setContractRef] = useState<string>("");
  const [rows, setRows] = useState<InvoiceRow[]>([emptyRow()]);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!isNew);

  const company = invoice?.company_id ?? companyId;
  const editable = canWrite && (isNew || invoice?.status === "draft");

  function load(inv: Invoice) {
    setInvoice(inv);
    setDate(inv.date);
    setContractRef(inv.contract_ref ?? "");
    setRows(inv.rows.length ? inv.rows : [emptyRow()]);
    setErrors(inv.errors ?? []);
    if (inv.buyer_ref) {
      api<Counterparty[]>(`/api/companies/${inv.company_id}/counterparties${qs({ ref: inv.buyer_ref })}`).then((r) => setBuyer(r[0] ?? null));
    }
  }

  useEffect(() => {
    if (isNew) return;
    setLoading(true);
    api<Invoice>(`/api/invoices/${id}`).then(load).catch((e) => setMessage(e.message)).finally(() => setLoading(false));
  }, [id, isNew]);

  // Poll while 1C is creating or posting the invoice.
  useEffect(() => {
    if (!invoice || !["creating", "posting"].includes(invoice.status)) return;
    const timer = setInterval(() => api<Invoice>(`/api/invoices/${invoice.id}`).then(load), 3000);
    return () => clearInterval(timer);
  }, [invoice?.status, invoice?.id]);

  if (company === null) return <><PageHeader title={t("inv.newTitle")} /><NeedCompany /></>;
  if (loading) return <Spinner />;

  const payload = () => ({ company_id: company, date, buyer_ref: buyer?.ref_1c ?? null, contract_ref: contractRef || null, rows: rows.filter((r) => r.item_ref) });

  async function save(): Promise<Invoice | null> {
    setBusy(true);
    setMessage(null);
    try {
      const saved = isNew
        ? await api<Invoice>("/api/invoices", { method: "POST", json: payload() })
        : await api<Invoice>(`/api/invoices/${invoice!.id}`, { method: "PUT", json: payload() });
      load(saved);
      if (isNew) navigate(`/invoices/${saved.id}`, { replace: true });
      return saved;
    } catch (e) {
      const { message: m, errors: errs } = errorsFrom(e);
      setMessage(m);
      setErrors(errs);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function action(path: string, method = "POST") {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api<Invoice>(path, { method });
      if (path.endsWith("/copy")) navigate(`/invoices/${res.id}`);
      else load(res);
    } catch (e) {
      const { message: m, errors: errs } = errorsFrom(e);
      setMessage(m);
      if (errs.length) setErrors(errs);
    } finally {
      setBusy(false);
    }
  }

  async function createIn1C() {
    const saved = await save();
    if (saved && saved.errors?.length === 0) await action(`/api/invoices/${saved.id}/create-in-1c`);
  }

  function setRow(i: number, patch: Partial<InvoiceRow>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  const totals = rows.reduce((acc, r) => { const rt = rowTotals(r); return { amount: acc.amount + rt.amount, vat: acc.vat + rt.vat }; }, { amount: 0, vat: 0 });
  const errorFor = (field: string, row?: number) => errors.filter((e) => e.field === field && (row === undefined ? e.row === undefined : e.row === row)).map((e) => ts(e.message)).join("; ");

  return (
    <>
      <PageHeader
        title={isNew ? t("inv.newTitle") : invoice?.number ? t("inv.titleNumber", { number: invoice.number }) : t("inv.titleDraft")}
        subtitle={invoice && <><StatusBadge status={invoice.status} />{invoice.operator_message && <span className="ml-2 text-amber-700 dark:text-amber-400">{invoice.operator_message}</span>}</>}
        actions={
          canWrite && (
            <>
              {invoice && <button className="btn-ghost" disabled={busy} onClick={() => action(`/api/invoices/${invoice.id}/copy`)}>{t("inv.copy")}</button>}
              {editable && <button className="btn-secondary" disabled={busy} onClick={save}>{t("inv.saveDraft")}</button>}
              {editable && <button className="btn-primary" disabled={busy} onClick={createIn1C}>{t("inv.create")}</button>}
              {invoice?.status === "created" && <button className="btn-primary" disabled={busy} onClick={() => action(`/api/invoices/${invoice.id}/post`)}>{t("inv.post")}</button>}
              {(invoice?.status === "posted" || invoice?.status === "rejected") && <button className="btn-primary" disabled={busy} onClick={() => action(`/api/invoices/${invoice.id}/send`)}>{t("inv.send")}</button>}
              {invoice?.status === "draft" && <button className="btn-ghost text-red-600" disabled={busy} onClick={async () => { await api(`/api/invoices/${invoice.id}`, { method: "DELETE" }); navigate("/invoices"); }}>{t("common.delete")}</button>}
            </>
          )
        }
      />
      <ErrorBox error={message} />
      {invoice?.status === "created" && (
        <div className="mb-4 rounded-lg bg-brand-50 p-3 text-sm dark:bg-brand-700/20">
          {t("inv.createdBanner", { number: invoice.number, total: fmtMoney(invoice.total), currency: t("common.currency"), vat: fmtMoney(invoice.vat) })}
        </div>
      )}
      <div className="space-y-4">
        <Card title={t("inv.buyerContract")}>
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className="label">{t("common.date")}</label>
              <input type="date" className="input" value={date} disabled={!editable} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <label className="label">{t("inv.buyerLabel")}</label>
              {editable ? (
                <Search<Counterparty>
                  placeholder={t("inv.search")}
                  initial={buyer ? `${buyer.name} (${buyer.inn})` : ""}
                  load={(q) => api<Counterparty[]>(`/api/companies/${company}/counterparties${qs({ q })}`)}
                  render={(c) => <>{c.name} <span className="text-xs text-slate-500">{c.inn || t("inv.noInn")}</span></>}
                  onPick={(c) => { setBuyer(c); setContractRef(c.contracts.length === 1 ? c.contracts[0].ref : ""); }}
                />
              ) : (
                <div className="py-1.5 text-sm">{invoice?.buyer_name} ({invoice?.buyer_inn})</div>
              )}
              <p className="mt-1 text-xs text-red-600">{errorFor("buyer_inn") || errorFor("buyer_ref")}</p>
            </div>
            <div>
              <label className="label">{t("common.contract")}</label>
              <select className="input" value={contractRef} disabled={!editable || !buyer} onChange={(e) => setContractRef(e.target.value)}>
                <option value="">{t("common.choose")}</option>
                {(buyer?.contracts ?? []).map((c) => <option key={c.ref} value={c.ref}>{c.name || `№${c.number}`}</option>)}
              </select>
              <p className="mt-1 text-xs text-red-600">{errorFor("contract_ref")}</p>
            </div>
          </div>
        </Card>

        <Card title={t("inv.items")} actions={editable && <button className="btn-secondary text-xs" onClick={() => setRows((r) => [...r, emptyRow()])}>{t("inv.addRow")}</button>}>
          <Table>
            <thead>
              <tr>
                <th className="th w-72">{t("common.item")}</th>
                <th className="th">{t("common.ikpu")}</th>
                <th className="th">{t("common.unit")}</th>
                <th className="th num">{t("common.qty")}</th>
                <th className="th num">{t("common.price")}</th>
                <th className="th num">{t("common.vatPct")}</th>
                <th className="th num">{t("common.amount")}</th>
                <th className="th num">{t("common.vat")}</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const tot = rowTotals(r);
                const rowErrors = errors.filter((e) => e.row === i + 1).map((e) => ts(e.message)).join("; ");
                return (
                  <tr key={i} className="align-top">
                    <td className="td">
                      {editable ? (
                        <Search<Item>
                          placeholder={t("inv.itemPlaceholder")}
                          initial={r.name ?? ""}
                          load={(q) => api<Item[]>(`/api/companies/${company}/items${qs({ q })}`)}
                          render={(it) => <>{it.name} <span className="text-xs text-slate-500">{it.ikpu_code || t("inv.noIkpu")} · {it.vat_rate ?? "?"}%</span></>}
                          onPick={(it) => setRow(i, { item_ref: it.ref_1c, name: it.name, unit: it.unit, price: it.price, vat_rate: it.vat_rate ?? "0", ikpu_code: it.ikpu_code })}
                        />
                      ) : (
                        r.name
                      )}
                      {rowErrors && <p className="mt-1 text-xs text-red-600">{rowErrors}</p>}
                    </td>
                    <td className="td text-xs">{r.ikpu_code || <span className="text-red-600">missing</span>}</td>
                    <td className="td">{r.unit}</td>
                    <td className="td num"><input className="input w-20 text-right" type="number" min="0" step="any" value={r.quantity} disabled={!editable} onChange={(e) => setRow(i, { quantity: e.target.value })} /></td>
                    <td className="td num"><input className="input w-28 text-right" type="number" min="0" step="any" value={r.price ?? ""} disabled={!editable} onChange={(e) => setRow(i, { price: e.target.value })} /></td>
                    <td className="td num">{r.vat_rate !== undefined ? Number(r.vat_rate) : ""}</td>
                    <td className="td num">{fmtMoney(tot.amount)}</td>
                    <td className="td num">{fmtMoney(tot.vat)}</td>
                    <td className="td">{editable && rows.length > 1 && <button className="btn-ghost px-2 text-xs" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label={t("inv.removeRow")}>✕</button>}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="td text-right font-medium" colSpan={6}>{t("inv.totalInclVat")}</td>
                <td className="td num font-semibold" colSpan={2}>{fmtMoney(totals.amount + totals.vat)} <span className="text-xs font-normal text-slate-500">(VAT {fmtMoney(totals.vat)})</span></td>
                <td className="td" />
              </tr>
            </tfoot>
          </Table>
          {errors.length > 0 && (
            <ul className="mt-3 list-inside list-disc text-sm text-red-600">
              {errors.map((e, i) => <li key={i}>{e.row ? t("inv.rowPrefix", { n: e.row }) : ""}{ts(e.message)}</li>)}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

interface BulkInvoice {
  key: string;
  lines: number[];
  date: string;
  buyer_ref: string | null;
  buyer_inn: string;
  buyer_name: string;
  contract_ref: string | null;
  rows: InvoiceRow[];
  total: string;
  vat: string;
  errors: ValidationError[];
}

export function BulkInvoicesPage() {
  const { companyId } = useSession();
  const { t, ts } = useT();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<BulkInvoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Invoice[] | null>(null);

  if (companyId === null) return <><PageHeader title={t("inv.bulkTitle")} /><NeedCompany /></>;

  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const form = new FormData();
      form.append("file", file);
      setPreview(await api<BulkInvoice[]>(`/api/invoices/bulk/preview${qs({ company_id: companyId })}`, { method: "POST", body: form }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  const valid = (preview ?? []).filter((p) => p.errors.length === 0);

  async function createAll() {
    setBusy(true);
    setError(null);
    try {
      setCreated(
        await api<Invoice[]>("/api/invoices/bulk/create", {
          method: "POST",
          json: { company_id: companyId, invoices: valid.map((p) => ({ date: p.date, buyer_ref: p.buyer_ref, contract_ref: p.contract_ref, rows: p.rows })) },
        }),
      );
      setPreview(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title={t("inv.bulkTitle")}
        subtitle={t("inv.bulkSubtitle")}
        actions={
          <>
            <button className="btn-ghost" onClick={() => download("/api/invoices/bulk/template.xlsx", "invoices-template.xlsx")}>{t("inv.template")}</button>
            <label className="btn-primary cursor-pointer">
              {busy ? t("inv.working") : t("inv.upload")}
              <input type="file" accept=".xlsx" className="hidden" onChange={upload} disabled={busy} />
            </label>
          </>
        }
      />
      <ErrorBox error={error} />
      {preview && (
        <Card
          title={t("inv.preview", { n: preview.length, valid: valid.length })}
          actions={<button className="btn-primary" disabled={busy || valid.length === 0} onClick={createAll}>{t("inv.createN", { n: valid.length })}</button>}
        >
          <Table>
            <thead>
              <tr>
                <th className="th">invoice_no</th>
                <th className="th">{t("inv.lines")}</th>
                <th className="th">{t("common.date")}</th>
                <th className="th">{t("inv.buyer")}</th>
                <th className="th num">{t("common.total")}</th>
                <th className="th">{t("inv.validation")}</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((p) => (
                <tr key={p.key} className="align-top">
                  <td className="td">{p.key}</td>
                  <td className="td text-xs">{p.lines.join(", ")}</td>
                  <td className="td">{fmtDate(p.date)}</td>
                  <td className="td">{p.buyer_name || p.buyer_inn}</td>
                  <td className="td num">{fmtMoney(p.total)}</td>
                  <td className="td text-xs">
                    {p.errors.length === 0 ? (
                      <span className="text-emerald-600">{t("inv.ok")}</span>
                    ) : (
                      <ul className="text-red-600">{p.errors.map((e, i) => <li key={i}>{e.line ? t("inv.linePrefix", { n: e.line }) : e.row ? t("inv.rowPrefix", { n: e.row }) : ""}{ts(e.message)}</li>)}</ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      {created && (
        <Card title={t("inv.created")}>
          <ul className="space-y-1 text-sm">
            {created.map((i) => (
              <li key={i.id}>
                <Link className="link" to={`/invoices/${i.id}`}>{t("inv.invoiceN", { id: i.id })}</Link> · <StatusBadge status={i.status} /> {i.errors?.length ? <span className="text-red-600">{i.errors.map((e) => ts(e.message)).join("; ")}</span> : null}
              </li>
            ))}
          </ul>
          <button className="btn-secondary mt-3" onClick={() => navigate("/invoices")}>{t("inv.back")}</button>
        </Card>
      )}
    </>
  );
}
