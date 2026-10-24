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

export type BuildKind = "fee" | "transferOut" | "transferIn" | "conversionOut" | "conversionIn";

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
    correspondence: "expense" | "transit" | "conversion";
    other: boolean;
  }
> = {
  fee: {
    object: OBJECT.out,
    phrases: ["прочее списание", "прочеесписание"],
    what: "bank fee",
    correspondence: "expense",
    other: false,
  },
  transferOut: {
    object: OBJECT.out,
    phrases: ["перевод на другой счет", "переводнадругойсчет"],
    what: "transfer to another account of the company",
    correspondence: "transit",
    other: true,
  },
  transferIn: {
    object: OBJECT.in,
    phrases: ["перевод с другого счета", "переводсдругогосчета"],
    what: "transfer from another account of the company",
    correspondence: "transit",
    other: true,
  },
  conversionOut: {
    object: OBJECT.out,
    phrases: ["прочее списание", "прочеесписание"],
    what: "conversion, the paying leg",
    correspondence: "conversion",
    other: false,
  },
  conversionIn: {
    object: OBJECT.in,
    phrases: ["прочее поступление", "прочеепоступление", "перевод с другого счета", "переводсдругогосчета"],
    what: "conversion, the receiving leg",
    correspondence: "conversion",
    other: false,
  },
};

export interface BuildSpec {
  kind: BuildKind;
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
function correspondenceAttribute(described: Described): string | null {
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
  const operation = kind.phrases.map((p) => valueLike(values, [p])).find((v) => v !== undefined);
  if (!operation)
    return refuse(
      `1C has no operation like «${kind.phrases[0]}» (it has ${values.map((v) => v.name).join(", ")})`,
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
  } else code = TRANSIT_ACCOUNT;
  const refs = await accountRefs(deps, sc, code ? [code] : []);
  const accountRef = code ? (refs.get(code) ?? null) : null;
  const correspondence = correspondenceAttribute(described);
  if (!correspondence)
    notes.push("the document has no single account attribute: the account is left for 1C to fill");
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
