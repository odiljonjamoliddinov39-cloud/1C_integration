import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { AskBox } from "../components/AskBox";
import { Card, ErrorBox, PageHeader, Spinner, Stat, Table } from "../components/ui";
import { api, download, qs } from "../lib/api";
import { fmtCompact, fmtDate, fmtMoney, monthEnd, startOfMonth, startOfYear, today } from "../lib/format";
import { useT } from "../lib/i18n";
import { useData, useSession } from "../lib/session";

const C = { primary: "#2553e6", secondary: "#94a3b8", accent: "#f59e0b", danger: "#dc2626" };

interface Dashboard {
  last_synced_at: string | null;
  cash_bank: Record<"cash" | "bank", { account: string; balance: string; series: { date: string; balance: string }[] }>;
  receivables_payables: Record<"receivables" | "payables", { total: string; top: { company_id: number; counterparty_ref: string; name: string; balance: string }[] }>;
  aging: { buckets: Record<string, string>; counterparties: { company_id: number; counterparty_ref: string; name: string; total: string; "90+": string }[] };
  sales_purchases: { month: string; sales: string; purchases: string }[];
  vat: { month: string; output: string; input: string; payable: string; invoiced: string }[];
  findings: Record<string, number>;
}

interface TBRow {
  account: string;
  opening_dt: string;
  opening_kt: string;
  turnover_dt: string;
  turnover_kt: string;
  closing_dt: string;
  closing_kt: string;
}

const axisTick = { fontSize: 11, fill: "#64748b" };

export function DashboardPage() {
  const { companyId, companies } = useSession();
  const companyName = (id: number) => companies.find((c) => c.id === id)?.name ?? "";
  const navigate = useNavigate();
  const { t } = useT();
  const cur = t("common.currency");
  const [on, setOn] = useState(today());
  const [from, setFrom] = useState(startOfYear());
  const [tbFrom, setTbFrom] = useState(startOfMonth());
  const [tbTo, setTbTo] = useState(today());

  const { data, error, loading } = useData(() => api<Dashboard>(`/api/analytics/dashboard${qs({ company_id: companyId, date: on, from })}`), [companyId, on, from]);
  const tb = useData(() => api<TBRow[]>(`/api/analytics/trial-balance${qs({ company_id: companyId, from: tbFrom, to: tbTo })}`), [companyId, tbFrom, tbTo]);

  const docs = (params: Record<string, string | number | null | undefined>) => navigate(`/documents${qs({ company_id: companyId, ...params })}`);

  return (
    <>
      <PageHeader
        title={t("dash.title")}
        subtitle={data ? t("dash.subtitle", { date: fmtDate(data.last_synced_at) }) : undefined}
        actions={
          <>
            <label className="text-xs text-slate-500">{t("common.from")}</label>
            <input type="date" className="input w-auto" value={from} onChange={(e) => setFrom(e.target.value)} />
            <label className="text-xs text-slate-500">{t("common.on")}</label>
            <input type="date" className="input w-auto" value={on} onChange={(e) => setOn(e.target.value)} />
          </>
        }
      />
      <ErrorBox error={error} />
      {loading && !data && <Spinner />}
      {data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={t("dash.cash")} value={fmtMoney(data.cash_bank.cash.balance)} tone={Number(data.cash_bank.cash.balance) < 0 ? "red" : undefined} hint={t("dash.clickHint", { currency: cur })} onClick={() => docs({ account: data.cash_bank.cash.account, to: on })} />
            <Stat label={t("dash.bank")} value={fmtMoney(data.cash_bank.bank.balance)} hint={t("dash.clickHint", { currency: cur })} onClick={() => docs({ account: data.cash_bank.bank.account, to: on })} />
            <Stat label={t("dash.receivables")} value={fmtMoney(data.receivables_payables.receivables.total)} hint={t("dash.overdue", { amount: fmtMoney(data.aging.buckets["90+"]) })} />
            <Stat label={t("dash.payables")} value={fmtMoney(data.receivables_payables.payables.total)} hint={cur} />
          </div>

          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <Card title={t("dash.cashChart")}>
              <div className="h-64">
                <ResponsiveContainer>
                  <LineChart data={data.cash_bank.cash.series.map((p, i) => ({ date: p.date.slice(5), cash: Number(p.balance), bank: Number(data.cash_bank.bank.series[i]?.balance ?? 0) }))}>
                    <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tick={axisTick} interval={14} />
                    <YAxis tick={axisTick} tickFormatter={fmtCompact} width={56} />
                    <Tooltip formatter={(v) => fmtMoney(v as number)} />
                    <Legend />
                    <Line type="monotone" dataKey="cash" name={t("dash.cashSeries")} stroke={C.primary} dot={false} strokeWidth={2} />
                    <Line type="monotone" dataKey="bank" name={t("dash.bankSeries")} stroke={C.secondary} dot={false} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card title={t("dash.openFindings")} actions={<button className="link text-xs" onClick={() => navigate("/findings")}>{t("dash.allFindings")}</button>}>
              <div className="grid grid-cols-2 gap-2">
                {(["critical", "high", "medium", "low"] as const).map((s) => (
                  <button key={s} onClick={() => navigate(`/findings${qs({ severity: s })}`)} className="rounded-lg border border-slate-200 p-3 text-left hover:border-brand-500 dark:border-slate-800">
                    <div className="text-xs text-slate-500 first-letter:uppercase">{t(`severity.${s}`)}</div>
                    <div className={`text-2xl font-semibold ${s === "critical" && data.findings[s] ? "text-red-600" : ""}`}>{data.findings[s] ?? 0}</div>
                  </button>
                ))}
              </div>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {(["receivables", "payables"] as const).map((kind) => (
              <Card
                key={kind}
                title={kind === "receivables" ? t("dash.receivablesTop") : t("dash.payablesTop")}
                actions={<button className="btn-ghost text-xs" onClick={() => download(`/api/analytics/receivables${qs({ company_id: companyId, date: on, format: "xlsx" })}`, "receivables_payables.xlsx")}>{t("common.excel")}</button>}
              >
                <Table>
                  <thead>
                    <tr>
                      <th className="th">{t("common.counterparty")}</th>
                      <th className="th num">{t("dash.balanceCol", { currency: cur })}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.receivables_payables[kind].top.map((r) => (
                      <tr key={`${r.company_id}-${r.counterparty_ref}`} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => docs({ company_id: r.company_id, counterparty_ref: r.counterparty_ref })}>
                        <td className="td">
                          {r.name}
                          {companyId === null && <div className="text-xs text-slate-500">{companyName(r.company_id)}</div>}
                        </td>
                        <td className="td num">{fmtMoney(r.balance)}</td>
                      </tr>
                    ))}
                    {data.receivables_payables[kind].top.length === 0 && (
                      <tr>
                        <td className="td text-slate-500" colSpan={2}>{t("dash.nothingOutstanding")}</td>
                      </tr>
                    )}
                  </tbody>
                </Table>
              </Card>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={t("dash.aging")} actions={<button className="btn-ghost text-xs" onClick={() => download(`/api/analytics/aging${qs({ company_id: companyId, date: on, format: "xlsx" })}`, "debt_aging.xlsx")}>{t("common.excel")}</button>}>
              <div className="h-56">
                <ResponsiveContainer>
                  <BarChart data={Object.entries(data.aging.buckets).map(([bucket, v]) => ({ bucket, amount: Number(v) }))}>
                    <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="bucket" tick={axisTick} />
                    <YAxis tick={axisTick} tickFormatter={fmtCompact} width={56} />
                    <Tooltip formatter={(v) => fmtMoney(v as number)} />
                    <Bar dataKey="amount" name={t("common.amount")} fill={C.primary} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card title={t("dash.salesChart")} actions={<button className="btn-ghost text-xs" onClick={() => download(`/api/analytics/sales${qs({ company_id: companyId, from, to: on, format: "xlsx" })}`, "sales_purchases.xlsx")}>{t("common.excel")}</button>}>
              <div className="h-56">
                <ResponsiveContainer>
                  <BarChart data={data.sales_purchases.map((r) => ({ month: r.month, sales: Number(r.sales), purchases: Number(r.purchases) }))} onClick={(e) => { const m = e?.activeLabel as string | undefined; if (m) docs({ type: "sale,purchase", from: `${m}-01`, to: monthEnd(m) }); }}>
                    <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="month" tick={axisTick} />
                    <YAxis tick={axisTick} tickFormatter={fmtCompact} width={56} />
                    <Tooltip formatter={(v) => fmtMoney(v as number)} />
                    <Legend />
                    <Bar dataKey="sales" name={t("dash.sales")} fill={C.primary} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="purchases" name={t("dash.purchases")} fill={C.secondary} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <Card title={t("dash.vatTitle")} actions={<button className="btn-ghost text-xs" onClick={() => download(`/api/analytics/vat${qs({ company_id: companyId, from, to: on, format: "xlsx" })}`, "vat.xlsx")}>{t("common.excel")}</button>}>
            <Table>
              <thead>
                <tr>
                  <th className="th">{t("common.month")}</th>
                  <th className="th num">{t("dash.vatOutput")}</th>
                  <th className="th num">{t("dash.vatInput")}</th>
                  <th className="th num">{t("dash.vatPayable")}</th>
                  <th className="th num">{t("dash.vatInvoiced")}</th>
                </tr>
              </thead>
              <tbody>
                {data.vat.map((r) => (
                  <tr key={r.month} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => docs({ type: "invoice_out", from: `${r.month}-01`, to: monthEnd(r.month) })}>
                    <td className="td">{r.month}</td>
                    <td className="td num">{fmtMoney(r.output)}</td>
                    <td className="td num">{fmtMoney(r.input)}</td>
                    <td className="td num font-medium">{fmtMoney(r.payable)}</td>
                    <td className={`td num ${Math.abs(Number(r.invoiced) - Number(r.output)) > 1 ? "text-amber-600" : ""}`}>{fmtMoney(r.invoiced)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <Card
            title={t("dash.tb")}
            actions={
              <>
                <input type="date" className="input w-auto py-1" value={tbFrom} onChange={(e) => setTbFrom(e.target.value)} />
                <input type="date" className="input w-auto py-1" value={tbTo} onChange={(e) => setTbTo(e.target.value)} />
                <button className="btn-ghost text-xs" onClick={() => download(`/api/analytics/trial-balance${qs({ company_id: companyId, from: tbFrom, to: tbTo, format: "xlsx" })}`, "trial_balance.xlsx")}>{t("common.excel")}</button>
              </>
            }
          >
            <ErrorBox error={tb.error} />
            <Table>
              <thead>
                <tr>
                  <th className="th">{t("dash.account")}</th>
                  <th className="th num">{t("dash.openingDt")}</th>
                  <th className="th num">{t("dash.openingKt")}</th>
                  <th className="th num">{t("dash.turnoverDt")}</th>
                  <th className="th num">{t("dash.turnoverKt")}</th>
                  <th className="th num">{t("dash.closingDt")}</th>
                  <th className="th num">{t("dash.closingKt")}</th>
                </tr>
              </thead>
              <tbody>
                {(tb.data ?? []).map((r) => (
                  <tr key={r.account} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => docs({ account: r.account, from: tbFrom, to: tbTo })}>
                    <td className="td font-medium">{r.account}</td>
                    {(["opening_dt", "opening_kt", "turnover_dt", "turnover_kt", "closing_dt", "closing_kt"] as const).map((k) => (
                      <td key={k} className="td num">{Number(r[k]) ? fmtMoney(r[k]) : ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <AskBox />
        </div>
      )}
    </>
  );
}
