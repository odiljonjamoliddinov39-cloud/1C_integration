/**
 * Exact decimal numbers for the money of a customs declaration. A value is whole units over a power of ten, so nothing is
 * ever a float: 25 000 × 11 972.34 is 299 308 500.00 to the last digit, and a share of a fee that does not divide is
 * rounded in one place, on purpose (allocate.ts).
 */

export interface Dec {
  units: bigint;
  /** Digits after the point. */
  scale: number;
}

const TEN = 10n;
const pow10 = (n: number) => TEN ** BigInt(n);

/**
 * A number as the declaration or the model wrote it: "11972.34", "11 972,34", "1,030,000.00", 25000. Null when it is not a
 * number (an empty cell, a word); never a guess.
 */
export function dec(value: string | number | null | undefined): Dec | null {
  if (value === null || value === undefined) return null;
  let text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : value;
  text = text.replace(/[\s\u00a0\u202f]/g, "").replace(/^\+/, "");
  if (/e/i.test(text) && typeof value === "number") text = value.toFixed(6).replace(/\.?0+$/, "");
  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    // Both marks: the later one is the decimal point, the other groups thousands.
    text = comma > dot ? text.replaceAll(".", "").replace(",", ".") : text.replaceAll(",", "");
  } else if (comma >= 0) {
    // One comma: a decimal comma unless it groups exactly three digits more than once ("1,030,000").
    text = /^-?\d{1,3}(,\d{3}){2,}$/.test(text) ? text.replaceAll(",", "") : text.replace(",", ".");
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[3] ?? "";
  const units = BigInt(`${match[2]}${fraction}`) * (match[1] ? -1n : 1n);
  return { units, scale: fraction.length };
}

export const ZERO: Dec = { units: 0n, scale: 0 };

const align = (a: Dec, b: Dec): [bigint, bigint, number] => {
  const scale = Math.max(a.scale, b.scale);
  return [a.units * pow10(scale - a.scale), b.units * pow10(scale - b.scale), scale];
};

export function add(a: Dec, b: Dec): Dec {
  const [x, y, scale] = align(a, b);
  return { units: x + y, scale };
}

export function sub(a: Dec, b: Dec): Dec {
  const [x, y, scale] = align(a, b);
  return { units: x - y, scale };
}

export function mul(a: Dec, b: Dec): Dec {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

export function cmp(a: Dec, b: Dec): -1 | 0 | 1 {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export const isZero = (a: Dec) => a.units === 0n;
export const abs = (a: Dec): Dec => ({ units: a.units < 0n ? -a.units : a.units, scale: a.scale });

/** Rounded to `scale` digits, halves away from zero (the way the customs system and 1C round). */
export function round(a: Dec, scale: number): Dec {
  if (a.scale <= scale) return { units: a.units * pow10(scale - a.scale), scale };
  const factor = pow10(a.scale - scale);
  const negative = a.units < 0n;
  const magnitude = negative ? -a.units : a.units;
  let quotient = magnitude / factor;
  if ((magnitude % factor) * 2n >= factor) quotient += 1n;
  return { units: negative ? -quotient : quotient, scale };
}

/** a × b ÷ c rounded to `scale` digits; null when c is zero. */
export function mulDiv(a: Dec, b: Dec, c: Dec, scale: number): Dec | null {
  if (c.units === 0n) return null;
  const numerator = a.units * b.units;
  const denominator = c.units;
  // value = numerator / denominator × 10^-(a.scale+b.scale-c.scale); bring it to `scale` digits before dividing.
  const shift = scale - (a.scale + b.scale - c.scale);
  const scaled = shift >= 0 ? numerator * pow10(shift) : numerator;
  const divisor = shift >= 0 ? denominator : denominator * pow10(-shift);
  const negative = scaled < 0n !== divisor < 0n;
  const n = scaled < 0n ? -scaled : scaled;
  const d = divisor < 0n ? -divisor : divisor;
  let quotient = n / d;
  if ((n % d) * 2n >= d) quotient += 1n;
  return { units: negative ? -quotient : quotient, scale };
}

/** "1030000.00": always `places` digits after the point (the number is rounded first). */
export function fixed(a: Dec, places = 2): string {
  const r = round(a, places);
  const negative = r.units < 0n;
  const digits = (negative ? -r.units : r.units).toString().padStart(places + 1, "0");
  const whole = places === 0 ? digits : digits.slice(0, -places);
  const fraction = places === 0 ? "" : `.${digits.slice(-places)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** The number as short text, trailing zeros of the fraction dropped: "2078", "0.25". */
export function plain(a: Dec): string {
  const text = fixed(a, a.scale);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

export function sum(list: Dec[]): Dec {
  return list.reduce(add, ZERO);
}
