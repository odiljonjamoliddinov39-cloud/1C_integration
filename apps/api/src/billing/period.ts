/** Dates of billing periods, all in UTC. */

/** A Free subscription has no end: this is what its ends_at holds. */
export const FREE_END = new Date("2999-01-01T00:00:00Z");
export const DAY_MS = 86_400_000;

export function addMonths(date: Date, months: number): Date {
  const target = new Date(date);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return target;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** The end of a paid period that starts at `start`. */
export function periodEndOf(start: Date, cycle: "month" | "year"): Date {
  return addMonths(start, cycle === "year" ? 12 : 1);
}

/**
 * Where the month of counting that contains `now` began, counted from the period start: a yearly
 * plan still gets its monthly limits again each month. Free counts calendar months.
 */
export function monthlyAnchor(periodStart: Date, now: Date): Date {
  let months =
    (now.getUTCFullYear() - periodStart.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - periodStart.getUTCMonth());
  if (months < 0) months = 0;
  let anchor = addMonths(periodStart, months);
  if (anchor.getTime() > now.getTime()) anchor = addMonths(periodStart, Math.max(0, months - 1));
  return anchor;
}

export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.ceil((to.getTime() - from.getTime()) / DAY_MS));
}

/** Rounds a sum up to whole thousands. */
export function roundUpThousand(sum: number): number {
  return Math.ceil(sum / 1000) * 1000;
}
