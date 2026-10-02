import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { AskBox } from "../components/AskBox";
import { Card, ErrorBox, PageHeader, Spinner, Stat, Table } from "../components/ui";
import { api, download, qs } from "../lib/api";
import { fmtCompact, fmtDate, fmtMoney, monthEnd, startOfMonth, startOfYear, today } from "../lib/format";
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
        title="Dashboard"
        subtitle={data ? `Built from the mirror · last synced ${fmtDate(data.last_synced_at)}` : undefined}
        actions={
          <>
            <label className="text-xs text-slate-500">From</label>
            <input type="date" className="input w-auto" value={from} onChange={(e) => setFrom(e.target.value)} />
            <label className="text-xs text-slate-500">On</label>
            <input type="date" className="input w-auto" value={on} onChange={(e) => setOn(e.target.value)} />
          </>
        }
      />
      <ErrorBox error={error} />
      {loading && !data && <Spinner />}
      {data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Cash (5010)" value={fmtMoney(data.cash_bank.cash.balance)} tone={Number(data.cash_bank.cash.balance) < 0 ? "red" : undefined} hint="UZS · click for documents" onClick={() => docs({ account: data.cash_bank.cash.account, to: on })} />
            <Stat label="Bank (5110)" value={fmtMoney(data.cash_bank.bank.balance)} hint="UZS · click for documents" onClick={() => docs({ account: data.cash_bank.bank.account, to: on })} />
            <Stat label="Receivables" value={fmtMoney(data.receivables_payables.receivables.total)} hint={`90+ days: ${fmtMoney(data.aging.buckets["90+"])}`} />
            <Stat label="Payables" value={fmtMoney(data.receivables_payables.payables.total)} hint="UZS" />
          </div>

          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <Card title="Cash and bank, last 90 days">
              <div className="h-64">
                <ResponsiveContainer>
                  <LineChart data={data.cash_bank.cash.series.map((p, i) => ({ date: p.date.slice(5), cash: Number(p.balance), bank: Number(data.cash_bank.bank.series[i]?.balance ?? 0) }))}>
                    <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tick={axisTick} interval={14} />
                    <YAxis tick={axisTick} tickFormatter={fmtCompact} width={56} />
                    <Tooltip formatter={(v) => fmtMoney(v as number)} />
                    <Legend />
                    <Line type="monotone" dataKey="cash" name="Cash" stroke={C.primary} dot={false} strokeWidth={2} />
                    <Line type="monotone" dataKey="bank" name="Bank" stroke={C.secondary} dot={false} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card title="Open audit findings" actions={<button className="link text-xs" onClick={() => navigate("/findings")}>All findings →</button>}>
              <div className="grid grid-cols-2 gap-2">
                {(["critical", "high", "medium", "low"] as const).map((s) => (
                  <button key={s} onClick={() => navigate(`/findings${qs({ severity: s })}`)} className="rounded-lg border border-slate-200 p-3 text-left hover:border-brand-500 dark:border-slate-800">
                    <div className="text-xs capitalize text-slate-500">{s}</div>
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
                title={kind === "receivables" ? "Receivables, top 10" : "Payables, top 10"}
                actions={<button className="btn-ghost text-xs" onClick={() => download(`/api/analytics/receivables${qs({ company_id: companyId, date: on, format: "xlsx" })}`, "receivables_payables.xlsx")}>Excel</button>}
              >
                <Table>
                  <thead>
                    <tr>
                      <th className="th">Counterparty</th>
                      <th className="th num">Balance, UZS</th>
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
                        <td className="td text-slate-500" colSpan={2}>Nothing outstanding</td>
                      </tr>
                    )}
                  </tbody>
                </Table>
              </Card>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Debt aging (receivables)" actions={<button className="btn-ghost text-xs" onClick={() => download(`/api/analytics/aging${qs({ company_id: companyId, date: on, format: "xlsx" })}`, "debt_aging.xlsx")}>Excel</button>}>
              <div className="h-56">
                <ResponsiveContainer>
                  <BarChart data={Object.entries(data.aging.buckets).map(([bucket, v]) => ({ bucket, amount: Number(v) }))}>
                    <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="bucket" tick={axisTick} />
                    <YAxis tick={axisTick} tickFormatter={fmtCompact} width={56} />
                    <Tooltip formatter={(v) => fmtMoney(v as number)} />
                    <Bar dataKey="amount" name="Amount" fill={C.primary} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card title="Sales and purchases by month" actions={<button className="btn-ghost text-xs" onClick={() => download(`/api/analytics/sales${qs({ company_id: companyId, from, to: on, format: "xlsx" })}`, "sales_purchases.xlsx")}>Excel</button>}>
              <div className="h-56">
                <ResponsiveContainer>
                  <BarChart data={data.sales_purchases.map((r) => ({ month: r.month, sales: Number(r.sales), purchases: Number(r.purchases) }))} onClick={(e) => { const m = e?.activeLabel as string | undefined; if (m) docs({ type: "sale,purchase", from: `${m}-01`, to: monthEnd(m) }); }}>
                    <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="month" tick={axisTick} />
                    <YAxis tick={axisTick} tickFormatter={fmtCompact} width={56} />
                    <Tooltip formatter={(v) => fmtMoney(v as number)} />
                    <Legend />
                    <Bar dataKey="sales" name="Sales" fill={C.primary} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="purchases" name="Purchases" fill={C.secondary} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <Card title="VAT: output vs input" actions={<button className="btn-ghost text-xs" onClick={() => download(`/api/analytics/vat${qs({ company_id: companyId, from, to: on, format: "xlsx" })}`, "vat.xlsx")}>Excel</button>}>
            <Table>
              <thead>
                <tr>
                  <th className="th">Month</th>
                  <th className="th num">Output (6410)</th>
                  <th className="th num">Input (4410)</th>
                  <th className="th num">Payable</th>
                  <th className="th num">On invoices</th>
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
            title="Trial balance (ОСВ)"
            actions={
              <>
                <input type="date" className="input w-auto py-1" value={tbFrom} onChange={(e) => setTbFrom(e.target.value)} />
                <input type="date" className="input w-auto py-1" value={tbTo} onChange={(e) => setTbTo(e.target.value)} />
                <button className="btn-ghost text-xs" onClick={() => download(`/api/analytics/trial-balance${qs({ company_id: companyId, from: tbFrom, to: tbTo, format: "xlsx" })}`, "trial_balance.xlsx")}>Excel</button>
              </>
            }
          >
            <ErrorBox error={tb.error} />
            <Table>
              <thead>
                <tr>
                  <th className="th">Account</th>
                  <th className="th num">Opening Dt</th>
                  <th className="th num">Opening Kt</th>
                  <th className="th num">Turnover Dt</th>
                  <th className="th num">Turnover Kt</th>
                  <th className="th num">Closing Dt</th>
                  <th className="th num">Closing Kt</th>
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
