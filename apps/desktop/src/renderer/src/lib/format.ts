import type { InfobaseInput } from "../../../shared/ipc";

export function describeInfobase(infobase: InfobaseInput): string {
  return infobase.kind === "file" ? infobase.file : `${infobase.server}/${infobase.ref}`;
}

export function formatTime(iso: string | null | undefined, language: string): string {
  if (!iso) return "—";
  const locale = language === "en" ? "en-GB" : "ru-RU"; // Uzbek uses the same date format as Russian
  return new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
}
