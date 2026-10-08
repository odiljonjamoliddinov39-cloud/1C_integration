export function usd(value: number): string {
  if (value === 0) return "$0";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

export function compact(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function date(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : "—";
}

export function dateTime(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
}

/** "3 h ago", "in 12 days". */
export function relative(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  const [value, unit] =
    abs < 3_600_000
      ? [Math.round(abs / 60_000), "min"]
      : abs < 86_400_000
        ? [Math.round(abs / 3_600_000), "h"]
        : [Math.round(abs / 86_400_000), abs < 2 * 86_400_000 ? "day" : "days"];
  return diff < 0 ? `${value} ${unit} ago` : `in ${value} ${unit}`;
}
