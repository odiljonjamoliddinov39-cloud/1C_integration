/**
 * The cash side of cash paid into the bank or taken out of it. Cash to the bank is two steps through the transit account
 * 5710: the cash order Dt 5710 / Cr 5010 (the cashier's), then the bank receipt Dt 5110 / Cr 5710 (the statement's line, made
 * by build.ts). Cash from the bank is the reverse: the bank write-off Dt 5710 / Cr 5110, then the cash receipt Dt 5010 / Cr
 * 5710. The statement shows only the bank's step, so the other is looked for in 1C (the same amount within a few days of the
 * line) and, when the company has not entered it, made from 1C's own description of the cash order, so that 5710 closes to
 * zero. Nothing is chosen that 1C does not show: no single cash desk, no matching operation or no account in the chart says
 * what is missing instead.
 */
import type { ChangeInput } from "@platform/shared";

import { refOf, textOf } from "../didox/resolve.js";
import { type Context, choosePosting } from "../engine/posting-rules.js";
import { correspondenceAttribute } from "./build.js";
import type { BankCache, BankDeps } from "./resolve.js";
import { accountRefs, describeCached, enumValues, newScaffoldCache, soumRef, valueLike } from "./scaffold.js";
import type { BankPayment } from "./statement.js";

export type CashOrder =
  | { status: "found"; note: string }
  | { status: "made"; change: ChangeInput; note: string }
  | { status: "missing"; note: string };

const ORDERS = {
  /** Cash paid into the bank: the cashier's expense order. */
  toBank: {
    object: "Документ.РасходныйКассовыйОрдер",
    phrases: ["сдача наличных в банк", "взнос наличных в банк", "наличные в банк", "сдачаналичных"],
    op: "cash_to_bank_order" as const,
    side: "credit" as const,
    what: "the cash order (Dt 5710 / Cr 5010)",
  },
  /** Cash taken out of the bank: the cashier's receipt order. */
  fromBank: {
    object: "Документ.ПриходныйКассовыйОрдер",
    phrases: ["получение наличных в банке", "получение наличных", "снятие наличных"],
    op: "cash_from_bank_order" as const,
    side: "debit" as const,
    what: "the cash receipt (Dt 5010 / Cr 5710)",
  },
};

const shift = (day: string, days: number) =>
  new Date(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export async function cashOrderFor(
  deps: BankDeps,
  cache: BankCache,
  input: {
    direction: "toBank" | "fromBank";
    payment: BankPayment;
    organization: string | null;
    ownAccount: string | null;
    posting?: Context;
  },
): Promise<CashOrder> {
  const order = ORDERS[input.direction];
  const short = order.object.replace("Документ.", "");
  const amount = input.payment.amount / 100;
  const day = input.payment.date.slice(0, 10);

  // The step the cashier already entered: the same amount within three days either side.
  const found = await deps.query({
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ ${order.object} КАК Т ГДЕ НЕ Т.ПометкаУдаления И Т.Дата МЕЖДУ &с И &по И Т.СуммаДокумента = &сумма`,
    params: { с: `${shift(day, -3)}T00:00:00`, по: `${shift(day, 3)}T23:59:59`, сумма: amount },
    limit: 1,
    refs: true,
  });
  if (!found.ok)
    return {
      status: "missing",
      note: `${order.what} could not be looked for in 1C (${short} is not readable): check that 5710 closes to zero`,
    };
  if (refOf((found.data as { rows?: unknown[][] }).rows?.[0]?.[0]))
    return { status: "found", note: `${order.what} is already in 1C: 5710 closes` };

  const sc = (cache.scaffold ??= newScaffoldCache());
  const missing = (why: string): CashOrder => ({
    status: "missing",
    note: `${order.what} is not in 1C and cannot be made from its description (${why}): enter it, or 5710 stays open`,
  });
  const described = await describeCached(deps, sc, order.object);
  if (!described) return missing(`1C did not describe ${short}`);
  const have = new Set(described.attributes.map((a) => a.name));
  const kindType = described.attributes
    .find((a) => a.name === "ВидОперации")
    ?.types.find((t) => t.startsWith("Перечисление"));
  const values = kindType ? await enumValues(deps, sc, kindType) : null;
  const operation = values ? valueLike(values, order.phrases) : undefined;
  if (!operation) return missing(`${short} has no operation like «${order.phrases[0]}»`);

  const deskAttribute = described.attributes.find((a) => a.types.includes("Справочник.Кассы"))?.name;
  if (!deskAttribute) return missing(`${short} has no cash desk`);
  const desks = await deps.query({
    query:
      "ВЫБРАТЬ Т.Ссылка КАК Ссылка, Т.Наименование КАК Наименование ИЗ Справочник.Кассы КАК Т ГДЕ НЕ Т.ПометкаУдаления",
    limit: 20,
    refs: true,
  });
  const options = (desks.ok ? ((desks.data as { rows?: unknown[][] }).rows ?? []) : []).flatMap((cells) => {
    const ref = refOf(cells[0]);
    return ref ? [{ ref, name: textOf(cells[1]) || textOf(cells[0]) }] : [];
  });
  const [desk] = options;
  if (options.length !== 1 || !desk)
    return missing(
      options.length === 0
        ? "1C has no cash desk"
        : `the company has several cash desks (${options.map((o) => o.name).join(", ")}) and the line does not say which`,
    );

  const decision = choosePosting({ type: order.op, date: day }, input.posting);
  const code = (order.side === "credit" ? decision.credit : decision.debit) ?? "";
  const account = code ? ((await accountRefs(deps, sc, [code])).get(code) ?? null) : null;
  const correspondence = correspondenceAttribute(described);
  if (!correspondence || !account)
    return missing(
      !correspondence ? `${short} has no account attribute` : `the chart has no account ${code}`,
    );

  const fields: Record<string, unknown> = {
    Дата: day,
    ВидОперации: operation.ref,
    [deskAttribute]: { type: "Справочник.Кассы", ref: desk.ref },
    СуммаДокумента: amount,
    [correspondence]: { type: "ПланСчетов.Хозрасчетный", ref: account },
  };
  const put = (name: string, value: unknown) => {
    if (have.has(name)) fields[name] = value;
  };
  if (input.organization) put("Организация", { type: "Справочник.Организации", ref: input.organization });
  const bankAccount = described.attributes.find((a) => a.types.includes("Справочник.БанковскиеСчета"))?.name;
  if (bankAccount && input.ownAccount)
    fields[bankAccount] = { type: "Справочник.БанковскиеСчета", ref: input.ownAccount };
  put("Основание", input.payment.purpose);
  put("Комментарий", `Bank statement line ${input.payment.number || input.payment.row} of ${day}`);
  sc.soum ??= await soumRef(deps);
  if (sc.soum && have.has("ВалютаДокумента"))
    fields["ВалютаДокумента"] = { type: "Справочник.Валюты", ref: sc.soum };
  return {
    status: "made",
    change: { action: "create", object: order.object, fields, post: false },
    note: `${order.what} was not in 1C: made from 1C's description of ${short} (operation «${operation.name}», cash desk ${desk.name}, account ${code}); check it`,
  };
}
