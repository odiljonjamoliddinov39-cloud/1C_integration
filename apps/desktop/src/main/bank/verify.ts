/**
 * What 1C actually posted for the documents the program wrote, judged against what each case needs (operations.ts). A document
 * written through the API is not a document written on its form: the same operation can post the right entry from the form and
 * the wrong one, or none, from here. So after the accountant posts what the program entered, the entries are read back; a
 * document whose entries are not those of its case is named with the entry it made, and the operation is remembered as wrong for
 * that case in this company (the chooser does not take it again), whatever the company's earlier documents say.
 */
import { refOf, textOf } from "../didox/resolve.js";
import { rowsOfPeriod } from "../query-window.js";
import type { BuildKind } from "./build.js";
import { EXPECTED, type OperationMemory, type Pair, fits, verdictKey } from "./operations.js";
import type { BankDeps } from "./resolve.js";

export interface WrittenDoc {
  ref: string;
  object: string;
  /** The case it was written as (a key of EXPECTED). */
  case: string;
  /** Its day, "YYYY-MM-DD". */
  day: string;
}

export interface Verdict {
  ref: string;
  object: string;
  case: BuildKind;
  /** The operation as 1C shows it, "" when it could not be read. */
  operation: string;
  ok: boolean;
  /** The entries it posted. */
  pairs: Pair[];
  /** For a wrong one: what was wrong, in a line. */
  problem?: string;
}

/** The cases whose entries are certain enough to judge an operation by (a budget payment, cash and capital have many right shapes). */
const VERIFIED = new Set<string>(["fee", "transferOut", "transferIn", "conversionOut", "conversionIn"]);
const isCase = (c: string): c is BuildKind => VERIFIED.has(c) && Object.hasOwn(EXPECTED, c);

/** The entries of the documents, judged. Null when 1C cannot be read (nothing is then said, nothing remembered). */
export async function verifyPosted(deps: BankDeps, docs: WrittenDoc[]): Promise<Verdict[] | null> {
  const verdicts: Verdict[] = [];
  const byObject = new Map<string, WrittenDoc[]>();
  for (const d of docs) if (isCase(d.case)) byObject.set(d.object, [...(byObject.get(d.object) ?? []), d]);
  for (const [object, list] of byObject) {
    const days = list.map((d) => d.day).sort();
    const from = days[0];
    const to = days.at(-1);
    if (!from || !to) continue;
    const entries = await rowsOfPeriod(
      deps,
      "ВЫБРАТЬ Т.Регистратор КАК Док, Т.СчетДт.Код КАК Дт, Т.СчетКт.Код КАК Кт " +
        "ИЗ РегистрБухгалтерии.Хозрасчетный КАК Т " +
        `ГДЕ Т.Период МЕЖДУ &начало И &конец И Т.Активность И Т.Регистратор ССЫЛКА ${object}`,
      from,
      to,
    );
    if (!entries) return null;
    const names = await rowsOfPeriod(
      deps,
      `ВЫБРАТЬ Д.Ссылка КАК Ссылка, Д.ВидОперации КАК Вид ИЗ ${object} КАК Д ГДЕ Д.Дата МЕЖДУ &начало И &конец`,
      from,
      to,
    );
    const operationOf = new Map<string, string>();
    for (const cells of names ?? []) {
      const ref = refOf(cells[0]);
      if (ref) operationOf.set(ref, textOf(cells[1]));
    }
    const pairsOf = new Map<string, Pair[]>();
    for (const cells of entries) {
      const ref = refOf(cells[0]);
      if (!ref) continue;
      const pairs = pairsOf.get(ref) ?? [];
      pairs.push({ debit: String(cells[1] ?? ""), credit: String(cells[2] ?? ""), count: 1 });
      pairsOf.set(ref, pairs);
    }
    for (const doc of list) {
      if (!isCase(doc.case)) continue;
      const pairs = pairsOf.get(doc.ref) ?? [];
      const operation = operationOf.get(doc.ref) ?? "";
      const right = pairs.some((p) => fits(doc.case as BuildKind, p));
      verdicts.push({
        ref: doc.ref,
        object,
        case: doc.case as BuildKind,
        operation,
        ok: right,
        pairs,
        ...(right
          ? {}
          : {
              problem:
                pairs.length === 0
                  ? "it posted no entry"
                  : `it posted ${pairs.map((p) => `Dt ${p.debit} / Kt ${p.credit}`).join("; ")}`,
            }),
      });
    }
  }
  return verdicts;
}

/** The verdicts as what the company's memory keeps: per object, case and operation, how many right and how many wrong. */
export function toMemory(verdicts: Verdict[]): OperationMemory["verdicts"] {
  const out = new Map<string, OperationMemory["verdicts"][number]>();
  for (const v of verdicts) {
    if (!v.operation) continue;
    const key = verdictKey(v.object, v.case, v.operation);
    const known = out.get(key) ?? { key, case: v.case, operation: v.operation, good: 0, bad: 0 };
    if (v.ok) known.good += 1;
    else {
      known.bad += 1;
      known.lastBad = v.problem;
    }
    out.set(key, known);
  }
  return [...out.values()];
}

/** What the accountant is told after a posting: how many were right, and for each wrong operation the entry it made. */
export function describeVerdicts(verdicts: Verdict[]): string[] {
  const wrong = verdicts.filter((v) => !v.ok);
  const lines = [
    `${verdicts.length - wrong.length} of ${verdicts.length} posted documents made the entry their case needs`,
  ];
  const byOperation = new Map<string, Verdict[]>();
  for (const v of wrong)
    byOperation.set(`${v.case}|${v.operation}`, [...(byOperation.get(`${v.case}|${v.operation}`) ?? []), v]);
  for (const list of byOperation.values()) {
    const first = list[0];
    if (first)
      lines.push(
        `«${first.operation || "?"}» as ${first.case}: ${list.length} document(s) went wrong, ${first.problem}. The program will not use this operation for this case again`,
      );
  }
  return lines;
}
