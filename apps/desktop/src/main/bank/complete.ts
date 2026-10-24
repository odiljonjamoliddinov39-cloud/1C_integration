/**
 * What a payment document needs to post, whatever it was made from. A payment's breakdown row has, besides the amount,
 * the way the debt is repaid («Погашение задолженности») and the account of advances («Счет авансов»). When the way is
 * empty 1C treats the whole payment as an advance, books it to the account of advances, finds it empty, and refuses to
 * post: "the debit account is not filled" on a payment to a supplier, "the credit account" on a receipt from a buyer. A
 * document copied from one that was never posted, or made from the description, has them empty; one copied from a
 * posted payment has them. So every payment document the program makes is completed here, from 1C's own description of
 * the columns (by name and by the title the form shows), with the way «Автоматически» and the account the rules name for
 * advances (checked against the chart, a currency one for a contract in a currency).
 */
import type { ChangeInput } from "@platform/shared";

import { type Context, type OperationType, choosePosting } from "../engine/posting-rules.js";
import type { BankCache, BankDeps } from "./resolve.js";
import {
  type EnumValue,
  OPERATIONS,
  type Operation,
  accountRefs,
  currencyAccount,
  describeCached,
  enumValues,
  newScaffoldCache,
  valueLike,
} from "./scaffold.js";

const empty = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === "" ||
  (typeof value === "object" && value !== null && !("ref" in value && (value as { ref?: unknown }).ref));

/** The operation a document is, from the value its ВидОперации carries. */
function operationOf(kind: unknown): Operation | null {
  const text =
    typeof kind === "string"
      ? kind
      : kind && typeof kind === "object"
        ? String((kind as { ref?: unknown }).ref ?? "")
        : "";
  if (/ОплатаПоставщику/i.test(text)) return "supplierPays";
  if (/ВозвратПокупателю/i.test(text)) return "buyerRefund";
  if (/ОплатаПокупателя/i.test(text)) return "buyerPays";
  if (/ВозвратОтПоставщика|ВозвратПоставщиком/i.test(text)) return "supplierRefund";
  return null;
}

const isBuyer = (operation: Operation) => operation === "buyerPays" || operation === "buyerRefund";

export async function completePayment(
  deps: BankDeps,
  cache: BankCache,
  change: ChangeInput,
  options: { posting?: Context; contractCurrency?: string | null; date: string },
): Promise<string[]> {
  const sc = (cache.scaffold ??= newScaffoldCache());
  const described = await describeCached(deps, sc, change.object);
  const section = described?.tabularSections.find((s) => s.attributes.some((a) => a.name === "СуммаПлатежа"));
  const rows = section ? change.tables?.[section.name] : undefined;
  const operation = operationOf(change.fields?.["ВидОперации"]);
  if (!described || !section || !rows || rows.length === 0 || !operation) return [];

  const notes: string[] = [];
  const money = choosePosting(
    { type: OPERATIONS[operation].money as OperationType, date: options.date },
    options.posting,
  );
  const advance = choosePosting(
    { type: OPERATIONS[operation].advance as OperationType, date: options.date },
    options.posting,
  );
  const settlementCode = isBuyer(operation) ? money.credit : money.debit;
  const advanceCode = isBuyer(operation) ? advance.credit : advance.debit;
  const inCurrency = Boolean(options.contractCurrency && options.contractCurrency !== "UZS");
  const refOfCode = async (code: string | undefined): Promise<string | null> => {
    if (!code) return null;
    if (inCurrency) {
      const found = await currencyAccount(deps, sc, code);
      if ("message" in found) {
        notes.push(`${found.message}: left for 1C to fill; check it`);
        return null;
      }
      return found.ref;
    }
    return (await accountRefs(deps, sc, [code])).get(code) ?? null;
  };

  const chart = (a: { types: string[] }) => a.types.some((t) => t.startsWith("ПланСчетов"));
  const title = (a: { name: string; synonym?: string }) => `${a.name} ${a.synonym ?? ""}`;
  const advanceColumn = section.attributes.find((a) => chart(a) && /аванс/iu.test(title(a)));
  const settlementColumn = section.attributes.find(
    (a) => chart(a) && /расчет|расчёт/iu.test(title(a)) && !/аванс/iu.test(title(a)),
  );
  const repayColumn = section.attributes.find(
    (a) => a.types.some((t) => t.startsWith("Перечисление")) && /погашен|зачет|зачёт/iu.test(title(a)),
  );
  let repay: EnumValue | undefined;
  const repayType = repayColumn?.types.find((t) => t.startsWith("Перечисление"));
  if (repayColumn && repayType) {
    const values = await enumValues(deps, sc, repayType);
    repay = values ? valueLike(values, ["автоматически"]) : undefined;
    if (!repay)
      notes.push(
        `1C has no repayment way «Автоматически» (it has ${(values ?? []).map((v) => v.name).join(", ")}): left for 1C to fill`,
      );
  }

  const advanceRef = advanceColumn ? await refOfCode(advanceCode) : null;
  const settlementRef = settlementColumn ? await refOfCode(settlementCode) : null;
  const filled = new Set<string>();
  for (const row of rows) {
    if (advanceColumn && advanceRef && empty(row[advanceColumn.name])) {
      row[advanceColumn.name] = { type: "ПланСчетов.Хозрасчетный", ref: advanceRef };
      filled.add(`the account of advances ${advanceCode}`);
    }
    if (settlementColumn && settlementRef && empty(row[settlementColumn.name])) {
      row[settlementColumn.name] = { type: "ПланСчетов.Хозрасчетный", ref: settlementRef };
      filled.add(`the settlement account ${settlementCode}`);
    }
    if (repayColumn && repay && empty(row[repayColumn.name])) {
      row[repayColumn.name] = repay.ref;
      filled.add(`the repayment way «${repay.name}»`);
    }
  }
  // The header's own settlement account, when the document keeps one and it is empty.
  const header = described.attributes.find(
    (a) => a.name === "СчетУчетаРасчетовСКонтрагентом" && a.types.some((t) => t.startsWith("ПланСчетов")),
  );
  if (header && change.fields && empty(change.fields[header.name])) {
    const ref = await refOfCode(settlementCode);
    if (ref) {
      change.fields[header.name] = { type: "ПланСчетов.Хозрасчетный", ref };
      filled.add(`the settlement account ${settlementCode} in the header`);
    }
  }
  if (filled.size > 0)
    notes.push(
      `${[...filled].join(", ")} filled in: without them 1C books the payment to an empty account of advances and refuses to post it; check them`,
    );
  return notes;
}
