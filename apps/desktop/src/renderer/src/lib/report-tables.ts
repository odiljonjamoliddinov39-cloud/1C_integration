/**
 * A report's figures as tables for the Reports screen and for the CSV file Excel opens. The shapes are the ones the
 * main process returns (engine/financial.ts and the other engine modules); a report the screen has no table for is
 * shown in words only.
 */

export interface ReportTable {
  title: string;
  head: string[];
  rows: string[][];
}

const n = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
const money = (v: unknown) => n(v).toLocaleString("en-US", { maximumFractionDigits: 2 }).replace(/,/g, " ");

interface LineShape {
  amount: number;
  sources: { account: string; name: string; amount: number }[];
}

const accounts = (l: LineShape | undefined) =>
  (l?.sources ?? [])
    .slice(0, 6)
    .map((s) => `${s.account} ${money(s.amount)}`)
    .join(", ");

type Labels = Record<string, string>;

/** `labels` carries the screen's words for the lines (keyed by the report's field names). */
export function reportTables(report: string, data: unknown, labels: Labels): ReportTable[] {
  const d = data as Record<string, unknown>;
  // The taxes line of the result is not the "Tax" column of the calendar.
  const label = (key: string) => labels[key === "tax" ? "tax_line" : key] ?? key;
  const line = (key: string, bold = false): string[] => {
    const l = d[key] as LineShape | number | undefined;
    return typeof l === "number"
      ? [(bold ? "▸ " : "") + label(key), money(l), ""]
      : [(bold ? "▸ " : "") + label(key), money(l?.amount), accounts(l)];
  };
  const head = [labels.line ?? "Line", labels.amount ?? "Amount", labels.accounts ?? "Accounts"];
  switch (report) {
    case "result":
      return [
        {
          title: labels.result ?? "Financial result",
          head,
          rows: [
            line("revenue"),
            line("costOfSales"),
            line("grossProfit", true),
            line("periodExpenses"),
            line("otherOperating"),
            line("operatingProfit", true),
            line("financialIncome"),
            line("financialExpenses"),
            line("emergency"),
            line("profitBeforeTax", true),
            line("tax"),
            line("netProfit", true),
          ].filter((r) => r[1] !== "0" || /^▸/.test(r[0] ?? "")),
        },
      ];
    case "balance":
      return [
        {
          title: labels.balance ?? "Balance",
          head,
          rows: [
            line("longTermAssets"),
            line("stock"),
            line("receivables"),
            line("money"),
            line("totalAssets", true),
            line("currentLiabilities"),
            line("longTermLiabilities"),
            line("equity"),
            line("currentResult"),
            line("totalLiabilities", true),
          ],
        },
      ];
    case "receivables":
    case "payables":
      return [
        {
          title: labels[report] ?? report,
          head: [labels.party ?? "Counterparty", labels.amount ?? "Amount"],
          rows: ((d.parties as { party: string; amount: number }[]) ?? []).map((p) => [
            p.party,
            money(p.amount),
          ]),
        },
        ...(((d.advances as unknown[]) ?? []).length > 0
          ? [
              {
                title: labels.advances ?? "Advances",
                head: [labels.party ?? "Counterparty", labels.amount ?? "Amount"],
                rows: (d.advances as { party: string; amount: number }[]).map((p) => [
                  p.party,
                  money(p.amount),
                ]),
              },
            ]
          : []),
      ];
    case "aging_receivables":
    case "aging_payables": {
      const buckets = ["0–30", "31–60", "61–90", "90+"];
      return [
        {
          title: labels[report] ?? report,
          head: [
            labels.party ?? "Counterparty",
            labels.total ?? "Total",
            ...buckets,
            labels.oldest ?? "Oldest, days",
          ],
          rows: (
            (d.parties as { party: string; total: number; buckets: number[]; oldestDays: number }[]) ?? []
          ).map((p) => [p.party, money(p.total), ...p.buckets.map(money), String(p.oldestDays)]),
        },
      ];
    }
    case "stock":
    case "stock_semi":
      return [
        {
          title: labels.stock ?? "Stock",
          head: [
            labels.item ?? "Item",
            labels.warehouse ?? "Warehouse",
            labels.qty ?? "Quantity",
            labels.amount ?? "Amount",
          ],
          rows: ((d.top as { item: string; warehouse: string; qty: number; amount: number }[]) ?? []).map(
            (r) => [r.item, r.warehouse, money(r.qty), money(r.amount)],
          ),
        },
      ];
    case "tax_calendar":
      return [
        {
          title: labels.tax_calendar ?? "Calendar",
          head: [
            labels.date ?? "Date",
            labels.tax ?? "Tax",
            labels.kind ?? "What",
            labels.period ?? "Period",
          ],
          rows: ((d.due as { date: string; tax: string; kind: string; period: string }[]) ?? []).map((x) => [
            x.date,
            labels[`tax_${x.tax}`] ?? x.tax,
            labels[`kind_${x.kind}`] ?? x.kind,
            x.period,
          ]),
        },
      ];
    case "bank_reconcile":
      return [
        {
          title: labels.bank_reconcile ?? "Bank",
          head: [
            labels.account ?? "Account",
            labels.date ?? "Date",
            labels.statement ?? "Statement",
            "1C",
            labels.difference ?? "Difference",
            labels.status ?? "Status",
          ],
          rows: (
            (d.rows as {
              account: string;
              date: string;
              statement: number | null;
              inBooks: number | null;
              difference: number | null;
              status: string;
            }[]) ?? []
          ).map((r) => [
            r.account,
            r.date,
            r.statement === null ? "" : money(r.statement),
            r.inBooks === null ? "" : money(r.inBooks),
            r.difference === null ? "" : money(r.difference),
            labels[`rec_${r.status}`] ?? r.status,
          ]),
        },
      ];
    default:
      return [];
  }
}

/** The byte-order mark Excel reads UTF-8 by. */
const BOM = String.fromCharCode(0xfeff);

const cell = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The tables as one CSV text (semicolons and a byte-order mark, as Excel in this region expects). */
export function toCsv(tables: ReportTable[]): string {
  const out: string[] = [];
  for (const t of tables) {
    out.push(cell(t.title), t.head.map(cell).join(";"), ...t.rows.map((r) => r.map(cell).join(";")), "");
  }
  return `${BOM}${out.join("\r\n")}`;
}
