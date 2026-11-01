/**
 * The day and the week the plan's credit limits count in. Uzbekistan has no daylight saving (UTC+5), so a day
 * starts at 00:00 Tashkent time and a week on Monday at 00:00.
 */
import { DAY_MS } from "./period.js";

const OFFSET_MS = 5 * 3_600_000;

/** The start of the Tashkent day that contains `now`. */
export function dayStart(now: Date): Date {
  const local = now.getTime() + OFFSET_MS;
  return new Date(Math.floor(local / DAY_MS) * DAY_MS - OFFSET_MS);
}

/** The start of the Tashkent week (Monday) that contains `now`. */
export function weekStart(now: Date): Date {
  const day = dayStart(now);
  // 1 January 1970 was a Thursday: with Monday as 0, the day number plus 3, modulo 7, is the weekday.
  const weekday = (Math.floor((day.getTime() + OFFSET_MS) / DAY_MS) + 3) % 7;
  return new Date(day.getTime() - weekday * DAY_MS);
}

/** What a limit of `pct` percent of the monthly credits is, in credits (null: the plan has none). */
export function limitCredits(monthlyCredits: number, pct: number): number | null {
  if (pct <= 0 || monthlyCredits <= 0) return null;
  return Math.max(1, Math.round((monthlyCredits * Math.min(100, pct)) / 100));
}
