/**
 * A seeded random source for the simulations: the same seed gives the same thousands of cases, so a failure can be
 * reproduced from its seed and number. SIM_CASES scales every suite (default: thousands, a few seconds each).
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  /** mulberry32: a float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(list: readonly T[]): T {
    if (list.length === 0) throw new Error("pick from an empty list");
    return list[this.int(0, list.length - 1)] as T;
  }

  /** A shuffled copy. */
  shuffle<T>(list: readonly T[]): T[] {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }

  /** A sum in tiyin-safe decimals: whole soums or with two decimals. */
  money(min: number, max: number, cents = true): number {
    const whole = this.int(min, max);
    return cents ? whole + this.int(0, 99) / 100 : whole;
  }

  digits(n: number): string {
    let s = "";
    for (let i = 0; i < n; i++) s += this.int(i === 0 ? 1 : 0, 9);
    return s;
  }

  /** YYYY-MM-DD between two years. */
  date(fromYear = 2024, toYear = 2026): string {
    const y = this.int(fromYear, toYear);
    const m = this.int(1, 12);
    const d = this.int(1, 28);
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
}

/** How many cases a suite runs: `base` by default, scaled by SIM_CASES (a multiplier) for a longer soak. */
export const cases = (base: number): number =>
  Math.max(1, Math.round(base * Number(process.env.SIM_CASES ?? 1)));

/** The seed of a run: fixed by default (repeatable), SIM_SEED to try another. */
export const seed = (salt: number): number => (Number(process.env.SIM_SEED ?? 20261021) + salt) >>> 0;
