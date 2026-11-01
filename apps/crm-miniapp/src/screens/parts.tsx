/** Small pieces the screens share. */

export function Stage({ name, color }: { name: string; color: string }) {
  return (
    <span className="stage" style={{ color, backgroundColor: `${color}22` }}>
      {name}
    </span>
  );
}

/** "3 daqiqa/soat/kun" is not translated here: a short date is clearer in every language. */
export function since(iso: string | null, never: string): string {
  if (!iso) return never;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const duration = (seconds: number | null): string =>
  seconds === null ? "" : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
