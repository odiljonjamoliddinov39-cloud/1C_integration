import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ReportRunInput } from "../../../shared/ipc";
import { errorText } from "@/components/ConnectorStatus";
import { Button } from "@/components/ui/button";
import { Card, ErrorText } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { reportTables, toCsv } from "@/lib/report-tables";

const REPORTS = [
  "result",
  "result_explain",
  "balance",
  "receivables",
  "payables",
  "aging_receivables",
  "aging_payables",
  "stock",
  "stock_semi",
  "stock_cost",
  "tax_accrual",
  "tax_calendar",
  "tax_registers",
  "bank_reconcile",
] as const;
type Kind = (typeof REPORTS)[number];

/** What each report asks for: a period, a day, an item and a cost method. */
const NEEDS: Record<Kind, { period?: true; day?: true; item?: true; method?: true }> = {
  result: { period: true },
  result_explain: { period: true },
  balance: { day: true },
  receivables: { day: true },
  payables: { day: true },
  aging_receivables: { day: true },
  aging_payables: { day: true },
  stock: { day: true },
  stock_semi: { day: true },
  stock_cost: { day: true, item: true, method: true },
  tax_accrual: { period: true },
  tax_calendar: { period: true },
  tax_registers: { period: true },
  bank_reconcile: {},
};

const today = () => new Date().toISOString().slice(0, 10);

/** The financial statements and checks of a company, worked out from its 1C by the program with no model. */
export function ReportsScreen() {
  const { t, i18n } = useTranslation();
  const companies = useQuery({ queryKey: ["companies"], queryFn: () => window.platform.companies.list() });
  const [companyId, setCompanyId] = useState("");
  const [report, setReport] = useState<Kind>("result");
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(today());
  const [item, setItem] = useState("");
  const [method, setMethod] = useState<"average" | "fifo">("fifo");
  const [saved, setSaved] = useState(false);

  const selected = companyId || companies.data?.[0]?.id || "";
  const needs = NEEDS[report];
  const labels = t("reports.labels", { returnObjects: true }) as Record<string, string>;

  const run = useMutation({
    mutationFn: async () => {
      setSaved(false);
      const input: ReportRunInput = {
        companyId: selected,
        report,
        lang: i18n.language === "ru" || i18n.language === "uz" ? i18n.language : "en",
        ...(needs.period ? { from, to } : {}),
        ...(needs.day ? { date: to } : {}),
        ...(needs.item && item ? { item } : {}),
        ...(needs.method ? { method } : {}),
      };
      return window.platform.reports.run(input);
    },
  });

  const result = run.data?.ok ? run.data.data : null;
  const tables = useMemo(
    () => (result ? reportTables(result.report, result.data, labels) : []),
    [result, labels],
  );

  async function exportCsv() {
    const done = await window.platform.reports.exportCsv(`${report}-${today()}.csv`, toCsv(tables));
    if (done.ok && done.data.saved) setSaved(true);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-8">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">{t("reports.title")}</h1>
        <p className="mt-1 text-muted-foreground">{t("reports.subtitle")}</p>
      </div>

      {companies.data?.length === 0 ? (
        <Card className="p-6 text-muted-foreground">{t("reports.noCompanies")}</Card>
      ) : (
        <Card className="space-y-4 p-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="report-company">{t("reports.company")}</Label>
              <select
                id="report-company"
                className="h-10 w-full rounded-lg border border-border bg-card px-2"
                value={selected}
                onChange={(e) => setCompanyId(e.target.value)}
              >
                {(companies.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="report-kind">{t("reports.report")}</Label>
              <select
                id="report-kind"
                className="h-10 w-full rounded-lg border border-border bg-card px-2"
                value={report}
                onChange={(e) => setReport(e.target.value as Kind)}
              >
                {REPORTS.map((r) => (
                  <option key={r} value={r}>
                    {t(`reports.kinds.${r}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-4">
            {needs.period && (
              <div>
                <Label htmlFor="report-from">{t("reports.from")}</Label>
                <Input id="report-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
            )}
            {(needs.period || needs.day) && (
              <div>
                <Label htmlFor="report-to">{needs.period ? t("reports.to") : t("reports.date")}</Label>
                <Input id="report-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            )}
            {needs.item && (
              <div>
                <Label htmlFor="report-item">{t("reports.item")}</Label>
                <Input id="report-item" value={item} onChange={(e) => setItem(e.target.value)} />
              </div>
            )}
            {needs.method && (
              <div>
                <Label htmlFor="report-method">{t("reports.method")}</Label>
                <select
                  id="report-method"
                  className="h-10 w-full rounded-lg border border-border bg-card px-2"
                  value={method}
                  onChange={(e) => setMethod(e.target.value as typeof method)}
                >
                  <option value="average">{t("reports.methods.average")}</option>
                  <option value="fifo">FIFO</option>
                </select>
              </div>
            )}
          </div>
          {report === "bank_reconcile" && (
            <p className="text-sm text-muted-foreground">{t("reports.bankHint")}</p>
          )}
          <div className="flex items-center gap-3">
            <Button disabled={!selected || run.isPending} onClick={() => run.mutate()}>
              {run.isPending ? t("reports.running") : t("reports.run")}
            </Button>
            {tables.length > 0 && (
              <Button variant="outline" onClick={() => void exportCsv()}>
                {t("reports.exportCsv")}
              </Button>
            )}
            {saved && <span className="text-sm text-success">{t("reports.saved")}</span>}
          </div>
        </Card>
      )}

      {run.data && !run.data.ok && <ErrorText>{errorText(t, run.data.code, run.data.message)}</ErrorText>}
      {run.error && <ErrorText>{run.error.message}</ErrorText>}

      {tables.map((table) => (
        <Card key={table.title} className="overflow-x-auto p-0">
          <div className="border-b border-border px-5 py-3 font-semibold">{table.title}</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                {table.head.map((h) => (
                  <th key={h} className="px-5 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={i} className="border-t border-border">
                  {row.map((c, j) => (
                    <td
                      key={j}
                      className={`px-5 py-2 ${j > 0 && /^[-\d ]+(\.\d+)?$/.test(c) ? "text-right tabular-nums" : ""}`}
                    >
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}

      {result && (
        <Card className="p-5">
          <div className="mb-2 flex items-center justify-between">
            <div className="font-semibold">{t("reports.inWords")}</div>
            <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(result.text)}>
              {t("reports.copy")}
            </Button>
          </div>
          <pre className="font-sans text-sm leading-relaxed whitespace-pre-wrap">{result.text}</pre>
        </Card>
      )}
    </div>
  );
}
