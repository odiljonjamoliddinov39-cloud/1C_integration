/**
 * Bank documents with no counterparty and no contract (a bank fee, a move between the company's own accounts, the two
 * legs of a currency purchase), made when the base has no earlier document of the kind to copy. As in scaffold.ts the
 * program does not guess a document's fields: it reads the object's own description from 1C (which attributes it has
 * and of which enumerations and directories they are), finds the operation by its name among the values 1C has, takes
 * the correspondence account from the table of account rules (checked against the company's chart), and says in a note
 * what it chose.
 *
 *  - fee: «Прочее списание» to the expense account of bank services;
 *  - transfer, out and in: «Перевод на другой счёт организации» / «Перевод с другого счёта» through the transit account;
 *  - conversion, the soum leg and the currency leg: «Прочее списание» and «Перевод с другого счёта» through the transit
 *    account, each in its own account's currency (1C refuses a transfer between accounts of two currencies).
 */
import type { ChangeInput } from "@platform/shared";

import { refOf, textOf } from "../didox/resolve.js";
import type { PostingOperation } from "@platform/shared";

import { type Context, choosePosting } from "../engine/posting-rules.js";
import type { BankCache, BankDeps } from "./resolve.js";
import { ownAccountOf } from "./roles.js";
import {
  type Described,
  type EnumValue,
  accountRefs,
  describeCached,
  enumValues,
  newScaffoldCache,
  soumRef,
  valueLike,
} from "./scaffold.js";
import type { BankPayment } from "./statement.js";
import { TAX_ACCOUNT, type TaxKind, isPenaltyPurpose, taxItemFor } from "./tax.js";

export type BuildKind =
  | "fee"
  | "transferOut"
  | "transferIn"
  | "conversionOut"
  | "conversionIn"
  | "tax"
  | "cashIn"
  | "cashOut"
  | "capital";

/** The bank documents (the same names as `OBJECT` in resolve.ts, which this file cannot import at load time). */
const OBJECT = {
  in: "Документ.ПоступлениеНаРасчетныйСчет",
  out: "Документ.СписаниеСРасчетногоСчета",
} as const;

/** The transit account the company's own transfers pass through (5710 in its base). */
export const TRANSIT_ACCOUNT = "5710";

/**
 * The conversion (transit) accounts of a currency purchase and of a sale: the money of a conversion passes through
 * them and they close to zero. Read from the company's chart before anything is made; never used when the chart lacks them.
 */
export const CONVERSION_ACCOUNT = { buy: "5730", sell: "5740" } as const;

const KINDS: Record<
  BuildKind,
  {
    object: string;
    phrases: string[];
    what: string;
    correspondence: "expense" | "transit" | "conversion" | "tax" | "rule";
    other: boolean;
    /** For "rule": the operation of the table of account rules and which side of its entry is the account of this document. */
    rule?: { op: PostingOperation; side: "debit" | "credit" };
  }
> = {
  fee: {
    object: OBJECT.out,
    phrases: ["прочее списание", "прочеесписание"],
    what: "bank fee",
    correspondence: "expense",
    other: false,
  },
  // A move between the company's accounts is «Прочее списание» to the transit account and «Прочее поступление» from it: the
  // entry of such a document is its header's account against the bank's (Dt 5710 / Kt 5110, then Dt 5530 / Kt 5710), as 1C posts
  // the conversion legs. The documents of the operations «Перевод на другой счет» / «Перевод с другого счета» written without
  // the form posted to the wrong account, or not at all.
  transferOut: {
    object: OBJECT.out,
    phrases: ["прочее списание", "прочеесписание"],
    what: "transfer to another account of the company",
    correspondence: "transit",
    other: false,
  },
  transferIn: {
    object: OBJECT.in,
    phrases: ["прочее поступление", "прочеепоступление"],
    what: "transfer from another account of the company",
    correspondence: "transit",
    other: false,
  },
  conversionOut: {
    object: OBJECT.out,
    phrases: ["прочее списание", "прочеесписание"],
    what: "conversion, the paying leg",
    correspondence: "conversion",
    other: false,
  },
  tax: {
    object: OBJECT.out,
    phrases: ["уплата налога", "уплатыналога"],
    what: "payment to the budget",
    correspondence: "tax",
    other: false,
  },
  cashIn: {
    object: OBJECT.in,
    phrases: ["взнос наличными", "взнос наличных", "внесение наличных", "поступление наличных"],
    what: "cash paid into the account",
    correspondence: "rule",
    other: false,
    rule: { op: "cash_deposit", side: "credit" },
  },
  cashOut: {
    object: OBJECT.out,
    phrases: ["снятие наличных", "получение наличных", "выдача наличных"],
    what: "cash taken out of the account",
    correspondence: "rule",
    other: false,
    rule: { op: "cash_withdrawal", side: "debit" },
  },
  capital: {
    object: OBJECT.in,
    phrases: [
      "взнос учредителя",
      "вклад учредителя",
      "взнос в уставный",
      "вклад в уставный",
      "прочее поступление",
    ],
    what: "a founder's contribution to the charter capital",
    correspondence: "rule",
    other: false,
    rule: { op: "capital_contribution", side: "credit" },
  },
  conversionIn: {
    object: OBJECT.in,
    phrases: ["прочее поступление", "прочеепоступление", "перевод с другого счета", "переводсдругогосчета"],
    what: "conversion, the receiving leg",
    correspondence: "conversion",
    other: false,
  },
};

/** The operation of the receiving leg of a currency purchase (the accountant's rule, the same for every company). */
const CURRENCY_PURCHASE_PHRASES = [
  "приобретение иностранной валюты",
  "приобретениеиностраннойвалюты",
  "приобретение валюты",
];

export interface BuildSpec {
  kind: BuildKind;
  /** The founder, for a contribution to the charter capital (a counterparty of 1C). */
  counterparty?: string | null;
  /** A payment to the budget: which tax, its period ("YYYY-MM-01T00:00:00"), and the tax office as a counterparty of 1C when it has one. */
  tax?: { kind: TaxKind; period: string | null; office: string | null };
  payment: BankPayment;
  /** The company's organization in 1C. */
  organization: string | null;
  /** The company's bank account this document is on (its reference). */
  ownAccount: string;
  /** The other account of a transfer (its reference): the receiving one on the paying side and the paying one on the other. */
  otherAccount?: string | null;
  /** The currency of the account in letters ("UZS", "USD", "RUB") and the currency item of 1C's catalog for it. */
  currency: string;
  currencyRef?: string | null;
  /** Soums per unit of the currency on the payment's day (1C's rate or the conversion's own), when the currency is not the soum. */
  rate?: number | null;
  posting?: Context;
  /**
   * A leg of a currency conversion: its id, which way it goes, and the bank it is with. The two legs of one conversion
   * share the id (written in each document's comment), the bank is the counterparty of both, and each is with the bank's
   * contract of kind «Прочее» in the leg's own currency.
   */
  conversion?: {
    id: string;
    direction: "buy" | "sell";
    leg: "out" | "in";
    bank?: { counterparty: string | null; contract: string | null };
  };
}

export type Built = { ok: true; change: ChangeInput; notes: string[] } | { ok: false; message: string };

/** Where a document keeps the account its other side is booked to: the header's reference to the chart of accounts. */
export function correspondenceAttribute(described: Described): string | null {
  const charted = described.attributes.filter((a) => a.types.some((t) => t.startsWith("ПланСчетов")));
  for (const name of [
    "СчетУчетаРасчетовСКонтрагентом",
    "СчетУчета",
    "СчетРасчетов",
    "КорреспондирующийСчет",
    "СчетКорреспондент",
  ]) {
    if (charted.some((a) => a.name === name)) return name;
  }
  return charted.length === 1 ? (charted[0]?.name ?? null) : null;
}

/** The attribute of a transfer that holds the other account of the company. */
function otherAccountAttribute(described: Described, own: string | null): string | null {
  const accounts = described.attributes.filter(
    (a) => a.name !== own && a.types.includes("Справочник.БанковскиеСчета"),
  );
  for (const name of [
    "БанковскийСчетПолучатель",
    "СчетПолучатель",
    "БанковскийСчетОтправитель",
    "СчетОтправитель",
    "БанковскийСчетКорреспондент",
    "СчетКорреспондент",
    // The Uzbek configuration: «СчетКонтрагента» is the account of the other side, also in a move between the company's accounts.
    "СчетКонтрагента",
    "БанковскийСчетКонтрагента",
  ]) {
    if (accounts.some((a) => a.name === name)) return name;
  }
  if (accounts.length === 1) return accounts[0]?.name ?? null;
  // Several bank-account attributes (the counterparty's account is one of them): the one named for the other side of a transfer.
  const named = accounts.filter((a) =>
    /Получател|Отправител|Корреспонд|Другого|Другой|Перевод/iu.test(a.name),
  );
  return named.length === 1 ? (named[0]?.name ?? null) : null;
}

const TAX_CATALOG = "Справочник.ВидыНалоговИПлатежейВБюджет";

/** The taxes and payments to the budget of 1C's catalog, read once. */
async function taxItems(deps: BankDeps, cache: BankCache): Promise<{ ref: string; name: string }[] | null> {
  if (cache.taxItems !== undefined) return cache.taxItems;
  const outcome = await deps.query({
    query: `ВЫБРАТЬ Т.Ссылка КАК Ссылка, Т.Наименование КАК Наименование ИЗ ${TAX_CATALOG} КАК Т ГДЕ НЕ Т.ПометкаУдаления`,
    limit: 500,
    refs: true,
  });
  cache.taxItems = outcome.ok
    ? ((outcome.data as { rows?: unknown[][] }).rows ?? []).flatMap((cells) => {
        const ref = refOf(cells[0]);
        return ref ? [{ ref, name: String(cells[1] ?? textOf(cells[0])) }] : [];
      })
    : null;
  return cache.taxItems;
}

export async function buildBankDocument(deps: BankDeps, cache: BankCache, spec: BuildSpec): Promise<Built> {
  const sc = (cache.scaffold ??= newScaffoldCache());
  const kind = KINDS[spec.kind];
  const short = kind.object.replace("Документ.", "");
  const refuse = (why: string): Built => ({
    ok: false,
    message: `no earlier ${short} (${kind.what}) to copy, and one cannot be made from 1C's own description: ${why}`,
  });
  const described = await describeCached(deps, sc, kind.object);
  if (!described) return refuse(`1C did not describe ${kind.object}`);
  const have = new Set(described.attributes.map((a) => a.name));
  if (!have.has("ВидОперации")) return refuse(`${kind.object} has no ВидОперации`);
  const own = ownAccountOf(described.attributes);
  if (!own) {
    return refuse(
      `${kind.object} has no attribute for the company's bank account (it has ${[...have].join(", ")})`,
    );
  }

  // The operation: the value of the document's own enumeration.
  const operationType = described.attributes
    .find((a) => a.name === "ВидОперации")
    ?.types.find((t) => t.startsWith("Перечисление"));
  const values: EnumValue[] | null = operationType ? await enumValues(deps, sc, operationType) : null;
  if (!values) return refuse("the operations of the document could not be read from 1C");
  // The first phrase 1C has a value for (the usual name before the alternative one).
  // A payment to the budget is «Уплата налога» itself, never the one «за третьих лиц» (another payer, a contract, 6010).
  const usable = kind.correspondence === "tax" ? values.filter((v) => !/третьих/iu.test(v.name)) : values;
  // The currency taken in by a purchase is «Приобретение иностранной валюты» in every company, whatever its earlier documents
  // say (a «Прочее поступление» there was the first run's mistake); a base that has no such value keeps the usual phrases.
  const phrases =
    spec.kind === "conversionIn" && spec.conversion?.direction === "buy"
      ? [...CURRENCY_PURCHASE_PHRASES, ...kind.phrases]
      : kind.phrases;
  const operation = phrases.map((p) => valueLike(usable, [p])).find((v) => v !== undefined);
  if (!operation)
    return refuse(
      `1C has no operation like «${phrases[0]}» (it has ${values.map((v) => v.name).join(", ")})`,
    );

  const notes: string[] = [];
  // The account the other side of the entry is booked to.
  let code: string;
  if (kind.correspondence === "expense") {
    const decision = choosePosting({ type: "bank_fee", date: spec.payment.date }, spec.posting);
    code = decision.debit ?? "";
    if (decision.source !== "rule" || decision.needsApproval) notes.push(`accounts: ${decision.reason}`);
  } else if (kind.correspondence === "conversion") {
    code = CONVERSION_ACCOUNT[spec.conversion?.direction ?? "buy"];
  } else if (kind.correspondence === "tax") {
    code = spec.tax ? TAX_ACCOUNT[spec.tax.kind] : "";
  } else if (kind.correspondence === "rule" && kind.rule) {
    const decision = choosePosting({ type: kind.rule.op, date: spec.payment.date }, spec.posting);
    code = (kind.rule.side === "credit" ? decision.credit : decision.debit) ?? "";
    if (decision.source !== "rule" || decision.needsApproval) notes.push(`accounts: ${decision.reason}`);
  } else code = TRANSIT_ACCOUNT;
  const refs = await accountRefs(deps, sc, code ? [code] : []);
  const accountRef = code ? (refs.get(code) ?? null) : null;

  // A payment to the budget: the tax of 1C's own catalog (by its name), and the account that tax item itself names, when it has one.
  let taxItem: { ref: string; name: string } | null = null;
  const taxAttribute =
    kind.correspondence === "tax"
      ? described.attributes.find((a) => a.types.includes(TAX_CATALOG))?.name
      : undefined;
  if (kind.correspondence === "tax") {
    if (!spec.tax) return refuse("no tax is given");
    if (!taxAttribute) return refuse(`${kind.object} has no attribute for the tax (of ${TAX_CATALOG})`);
    const found = await taxItems(deps, cache);
    if (!found) return refuse("the taxes of 1C's catalog could not be read");
    const named = found.filter((t) => taxItemFor(spec.tax?.kind ?? "vat", t.name, spec.payment.purpose));
    const [only] = named;
    if (named.length !== 1 || !only)
      return refuse(
        named.length === 0
          ? `1C's catalog of taxes has none like ${spec.tax.kind} (it has ${found.map((t) => t.name).join(", ") || "none"})`
          : `several taxes of 1C's catalog could be ${spec.tax.kind}: ${named.map((t) => t.name).join(", ")}; the accountant says which`,
      );
    taxItem = only;
  }
  // A payment to the budget: «Счет учета» of the document is the bank's own ledger account (5110), not the tax's. The account of
  // the tax is 1C's: it works it out from the tax and the kind of liability, so nothing is written to the account attribute.
  const correspondence = kind.correspondence === "tax" ? null : correspondenceAttribute(described);
  if (kind.correspondence === "tax")
    notes.push(
      "the account of the tax (e.g. 4420.1 for personal income tax) is the one 1C itself takes from the tax and the kind of liability; check it on the first document",
    );
  else if (!correspondence)
    notes.push("the document has no single account attribute: the account is left for 1C to fill");
  else if (!accountRef && kind.correspondence === "rule")
    return refuse(
      `the company's chart has no account ${code || "(none)"}: ${kind.what} is booked to it and the program does not book it anywhere else`,
    );
  else if (!accountRef && kind.correspondence === "conversion")
    return refuse(
      `the company's chart has no conversion account ${code}: a conversion passes through it and the program does not book it anywhere else`,
    );
  else if (!accountRef)
    notes.push(
      `the account ${code || "(none)"} is not in the company's chart: it is left for 1C to fill; check it`,
    );

  // The two legs of a conversion are entered in order: the paying leg first, the receiving one a second later.
  const when = spec.conversion
    ? `${spec.payment.date}T10:00:0${spec.conversion.leg === "out" ? "0" : "1"}`
    : spec.payment.date;
  const fields: Record<string, unknown> = {
    Дата: when,
    ВидОперации: operation.ref,
    [own]: { type: "Справочник.БанковскиеСчета", ref: spec.ownAccount },
    СуммаДокумента: spec.payment.amount / 100,
  };
  const put = (name: string, value: unknown) => {
    if (have.has(name)) fields[name] = value;
  };
  put("НазначениеПлатежа", spec.payment.purpose);
  if (spec.payment.number) put("НомерВходящегоДокумента", spec.payment.number);
  put("ДатаВходящегоДокумента", spec.payment.date);
  if (have.has("Организация") && spec.organization)
    fields["Организация"] = { type: "Справочник.Организации", ref: spec.organization };
  if (correspondence && accountRef)
    fields[correspondence] = { type: "ПланСчетов.Хозрасчетный", ref: accountRef };
  if (kind.correspondence === "rule" && spec.counterparty && have.has("Контрагент"))
    fields["Контрагент"] = { type: "Справочник.Контрагенты", ref: spec.counterparty };
  if (taxItem && taxAttribute) {
    fields[taxAttribute] = { type: TAX_CATALOG, ref: taxItem.ref };
    // The kind of liability: the tax itself, or its penalty.
    const liability = described.attributes.find(
      (a) => a.name === "ВидОбязательства" && a.types.some((t) => t.startsWith("Перечисление")),
    );
    const liabilityType = liability?.types.find((t) => t.startsWith("Перечисление"));
    const liabilities = liabilityType ? await enumValues(deps, sc, liabilityType) : null;
    const wanted = liabilities
      ? valueLike(liabilities, isPenaltyPurpose(spec.payment.purpose) ? ["пеня", "пени"] : ["налог"])
      : undefined;
    if (liability && wanted) fields[liability.name] = wanted.ref;
    if (have.has("НалоговыйПериод") && spec.tax?.period) fields["НалоговыйПериод"] = spec.tax.period;
    if (have.has("Контрагент") && spec.tax?.office)
      fields["Контрагент"] = { type: "Справочник.Контрагенты", ref: spec.tax.office };
  }
  if (spec.conversion) {
    for (const name of ["Комментарий", "Содержание"]) {
      if (have.has(name)) {
        fields[name] = `Conversion ${spec.conversion.id}`;
        break;
      }
    }
    const { bank } = spec.conversion;
    if (have.has("Контрагент") && bank?.counterparty)
      fields["Контрагент"] = { type: "Справочник.Контрагенты", ref: bank.counterparty };
    if (have.has("ДоговорКонтрагента") && bank?.contract)
      fields["ДоговорКонтрагента"] = { type: "Справочник.ДоговорыКонтрагентов", ref: bank.contract };
  }

  // The other account of a move is told on the document when it has a place for it; the entry does not depend on it.
  if ((spec.kind === "transferOut" || spec.kind === "transferIn") && spec.otherAccount) {
    const key = otherAccountAttribute(described, own);
    if (key) fields[key] = { type: "Справочник.БанковскиеСчета", ref: spec.otherAccount };
  }
  if (kind.other) {
    const key = otherAccountAttribute(described, own);
    if (!key || !spec.otherAccount)
      return refuse(
        key
          ? "the other account of the transfer is not known"
          : `${kind.object} has no attribute for the other account of the company`,
      );
    fields[key] = { type: "Справочник.БанковскиеСчета", ref: spec.otherAccount };
  }

  // The document's currency: the item of the catalog, and the rate of the day for a currency that is not the soum.
  if (have.has("ВалютаДокумента")) {
    const foreign = spec.currency !== "" && spec.currency !== "UZS";
    const item = foreign ? (spec.currencyRef ?? null) : (sc.soum ??= await soumRef(deps));
    if (!item)
      return refuse(
        foreign
          ? `1C has no currency ${spec.currency} in its catalog: the document in ${spec.currency} cannot be made`
          : "the soum is not in 1C's currencies",
      );
    fields["ВалютаДокумента"] = { type: "Справочник.Валюты", ref: item };
    if (foreign) {
      if (!spec.rate)
        return refuse(`the exchange rate of ${spec.currency} on ${spec.payment.date} was not found in 1C`);
      put("КурсДокумента", spec.rate);
      put("КратностьДокумента", 1);
      put("КурсВалюты", spec.rate);
    }
  }
  notes.push(
    `no earlier ${short} in 1C: the ${kind.what} is made from 1C's own description of the document. Operation «${operation.name}»${code ? `, account ${code}` : ""}; check the first documents`,
  );
  return {
    ok: true,
    change: { action: "create", object: kind.object, fields, post: false },
    notes,
  };
}
