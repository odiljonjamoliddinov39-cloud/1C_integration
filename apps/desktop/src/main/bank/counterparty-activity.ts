/**
 * One INN, two counterparties in 1C (a duplicate made by hand, a twin from an old import): when the statement's own name does not
 * tell them apart, the one the company really deals with is the one its bank documents are written to. The twin with a history is
 * taken, and the other is said to be the likely duplicate; with no clear winner the accountant is still asked.
 */
import { refOf } from "../didox/resolve.js";
import type { BankCandidate, BankDeps } from "./resolve.js";

const OBJECTS = ["Документ.ПоступлениеНаРасчетныйСчет", "Документ.СписаниеСРасчетногоСчета"] as const;

/** How many bank documents (not marked for deletion) are written to each counterparty with this INN; null when 1C cannot say. */
export async function documentCounts(deps: BankDeps, inn: string): Promise<Map<string, number> | null> {
  const counts = new Map<string, number>();
  for (const object of OBJECTS) {
    const outcome = await deps.query({
      query: `ВЫБРАТЬ Т.Контрагент КАК Контрагент, КОЛИЧЕСТВО(*) КАК Количество ИЗ ${object} КАК Т ГДЕ НЕ Т.ПометкаУдаления И Т.Контрагент.ИНН = &инн СГРУППИРОВАТЬ ПО Т.Контрагент`,
      params: { инн: inn },
      limit: 50,
      refs: true,
    });
    if (!outcome.ok) return null;
    for (const cells of (outcome.data as { rows?: unknown[][] }).rows ?? []) {
      const ref = refOf(cells[0]);
      const n = typeof cells[1] === "number" ? cells[1] : 0;
      if (ref && n > 0) counts.set(ref, (counts.get(ref) ?? 0) + n);
    }
  }
  return counts;
}

/**
 * The twin the company deals with: it has at least three documents and at least three times the others' together. Otherwise none
 * (two twins that are both in use are two counterparties for the accountant to tell apart).
 */
export function pickMostUsed(
  candidates: BankCandidate[],
  counts: Map<string, number>,
): { pick: BankCandidate; own: number; others: number } | null {
  const ranked = candidates.map((c) => ({ c, n: counts.get(c.ref) ?? 0 })).sort((a, b) => b.n - a.n);
  const top = ranked[0];
  if (!top || top.n < 3) return null;
  const others = ranked.slice(1).reduce((sum, r) => sum + r.n, 0);
  return top.n >= 3 * others ? { pick: top.c, own: top.n, others } : null;
}
