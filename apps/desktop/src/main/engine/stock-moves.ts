/**
 * Moving stock between warehouses and writing it off (stock.transfer, stock.writeOff): the plan checks the balance of
 * every line before anything is written (no operation takes the stock below zero, and the cause is named), and the
 * document is built from the base's own description of it, never from assumed field names: a name it cannot find is
 * reported with the names the object has, so it is settled once, not guessed.
 */
import type { StockRow } from "./financial.js";

export type MovementKind = "transfer" | "write_off";

export interface MovementLine {
  item: string;
  qty: number;
}

export interface MovementPlan {
  ok: boolean;
  lines: { item: string; qty: number; available: number; cost: number }[];
  problems: string[];
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The item as the stock holds it: exact name, else the one name that contains it; null when there is none or many. */
function findItem(rows: StockRow[], wanted: string): { name: string } | "many" | null {
  const names = [...new Set(rows.map((r) => r.item))];
  const exact = names.filter((n) => same(n, wanted));
  if (exact.length === 1) return { name: exact[0] as string };
  const partial = names.filter((n) => n.toLowerCase().includes(wanted.trim().toLowerCase()));
  if (exact.length === 0 && partial.length === 1) return { name: partial[0] as string };
  return exact.length > 1 || partial.length > 1 ? "many" : null;
}

export function planMovement(
  kind: MovementKind,
  lines: MovementLine[],
  stock: StockRow[],
  warehouses: { from: string; to?: string },
  reason?: string,
): MovementPlan {
  const problems: string[] = [];
  if (kind === "transfer") {
    if (!warehouses.to) problems.push("A transfer needs the warehouse it goes to.");
    else if (same(warehouses.from, warehouses.to)) problems.push("The two warehouses are the same.");
  }
  if (kind === "write_off" && !reason?.trim())
    problems.push("A write-off needs its reason (damage, shortage, own use): the accountant names it.");
  const here = stock.filter((r) => same(r.warehouse, warehouses.from));
  if (here.length === 0) problems.push(`The warehouse «${warehouses.from}» holds no stock on this date.`);
  const planned: MovementPlan["lines"] = [];
  for (const line of lines) {
    if (!(line.qty > 0)) {
      problems.push(`${line.item}: the quantity must be positive.`);
      continue;
    }
    const found = findItem(here, line.item);
    if (found === "many") {
      problems.push(`${line.item}: more than one item has this name; give the exact one.`);
      continue;
    }
    if (!found) {
      problems.push(`${line.item}: not in «${warehouses.from}».`);
      continue;
    }
    // The same item twice in the request is one line of the plan.
    const rows = here.filter((r) => r.item === found.name);
    const available = rows.reduce((a, r) => a + r.qty, 0);
    const cost = rows.reduce((a, r) => a + r.amount, 0);
    const already = planned.filter((p) => p.item === found.name).reduce((a, p) => a + p.qty, 0);
    if (line.qty + already > available + 1e-9)
      problems.push(
        `${found.name}: ${line.qty + already} asked, ${available} in «${warehouses.from}»: it would take the stock below zero.`,
      );
    else
      planned.push({
        item: found.name,
        qty: line.qty,
        available,
        cost: available > 0 ? (cost / available) * line.qty : 0,
      });
  }
  return { ok: problems.length === 0 && planned.length > 0, lines: planned, problems };
}

// --- Building the document from the object's description ------------------------------------------------------------

export interface Described {
  attributes: { name: string }[];
  tabularSections: { name: string; attributes: { name: string }[] }[];
}

const OBJECT: Record<MovementKind, string> = {
  transfer: "Документ.ПеремещениеТоваров",
  write_off: "Документ.СписаниеТоваров",
};
export const movementObject = (kind: MovementKind) => OBJECT[kind];

export interface BuiltMovement {
  object: string;
  fields: Record<string, unknown>;
  tables: Record<string, Record<string, unknown>[]>;
}

type Ref = { type: string; ref: string };

/** The document's fields from its description; a name that cannot be found comes back with the names it has. */
export function buildMovement(
  kind: MovementKind,
  described: Described,
  data: {
    date: string;
    organization: Ref;
    from: Ref;
    to?: Ref;
    comment?: string;
    lines: { item: Ref; qty: number }[];
  },
): { ok: true; movement: BuiltMovement } | { ok: false; message: string } {
  const names = described.attributes.map((a) => a.name);
  const find = (...res: RegExp[]) => res.map((re) => names.find((n) => re.test(n))).find(Boolean);
  const header: Record<string, unknown> = {};
  const missing: string[] = [];
  const set = (label: string, name: string | undefined, value: unknown) => {
    if (name) header[name] = value;
    else missing.push(label);
  };
  set("organization", find(/^Организация$/), data.organization);
  if (kind === "transfer") {
    set("sending warehouse", find(/^Склад(Отправитель|Источник|Отправления)$/i, /^Склад$/), data.from);
    set("receiving warehouse", find(/^Склад(Получатель|Назначения|Приемник)$/i), data.to);
  } else set("warehouse", find(/^Склад$/), data.from);
  const comment = find(/^Комментарий$/);
  if (comment && data.comment) header[comment] = data.comment;
  const section =
    described.tabularSections.find((s) => /^Товары$/i.test(s.name)) ??
    described.tabularSections.find((s) => /товар/i.test(s.name));
  const columns = section?.attributes.map((a) => a.name) ?? [];
  const itemColumn = columns.find((n) => /^Номенклатура$/i.test(n));
  const qtyColumn = columns.find((n) => /^Количество$/i.test(n));
  if (!section || !itemColumn || !qtyColumn) missing.push("the goods table (item, quantity)");
  if (missing.length > 0 || !section || !itemColumn || !qtyColumn)
    return {
      ok: false,
      message: `The base's ${OBJECT[kind]} has no field for: ${missing.join(", ")}. It has ${names.join(", ") || "no fields"}; tables: ${described.tabularSections.map((s) => `${s.name} (${s.attributes.map((a) => a.name).join(", ")})`).join("; ") || "none"}.`,
    };
  return {
    ok: true,
    movement: {
      object: OBJECT[kind],
      fields: { Дата: data.date, ...header },
      tables: { [section.name]: data.lines.map((l) => ({ [itemColumn]: l.item, [qtyColumn]: l.qty })) },
    },
  };
}
