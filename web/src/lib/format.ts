const money = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 });

export function fmtMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return money.format(Number(value));
}

export function fmtCompact(value: string | number): string {
  return compact.format(Number(value));
}

export function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString("ru-RU");
}

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function startOfYear(): string {
  return `${new Date().getFullYear()}-01-01`;
}

export function startOfMonth(): string {
  return today().slice(0, 8) + "01";
}

export const DOC_TYPES: Record<string, string> = {
  sale: "Реализация",
  purchase: "Поступление",
  invoice_out: "Счёт-фактура выданный",
  invoice_in: "Счёт-фактура полученный",
  cash_in: "ПКО",
  cash_out: "РКО",
  bank_in: "Поступление на р/с",
  bank_out: "Списание с р/с",
  operation: "Операция",
};

export const FIX_TYPES: Record<string, string> = {
  fill_field: "Fill missing field",
  repost: "Re-post document",
  correct_vat: "Correct VAT rate",
  reverse_duplicate: "Reverse duplicate",
  merge_counterparties: "Merge counterparties",
  restore: "Undo (restore)",
};

export const INVOICE_STATUS: Record<string, string> = {
  draft: "Draft",
  creating: "Sending to 1C…",
  created: "In 1C (unposted)",
  posting: "Posting…",
  posted: "Posted",
  ready: "Ready to send",
  sent: "Sent",
  signed: "Signed",
  rejected: "Rejected",
};

/** "2026-09" -> "2026-09-30" */
export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
}
