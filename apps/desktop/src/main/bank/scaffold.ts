/**
 * A bank document made when the base has no earlier one of its kind to copy (a new base, or one whose documents were
 * deleted). The program does not guess a document's fields: it reads the object's own description from 1C (which
 * attributes and breakdown columns it has, and of which enumerations and directories they are), finds the operation
 * from the contract's kind and the direction of the money, takes the settlement accounts from the table of account
 * rules (checked against the company's chart), the VAT from the payment's purpose, and builds the same
 * `Template` the copy path works from. Everything the program is not sure of is said in a note, never silently chosen.
 *
 * Only the plain case is made here: a payment with a counterparty that 1C knows and that has a contract of a kind
 * that settles the operation (a buyer's payment, a payment to a supplier, and their refunds). A salary, a loan, a bank
 * fee, a transfer between the company's own accounts, a payment in a foreign currency, and a counterparty with no
 * contract are the accountant's decision (or an earlier document of the same kind), and are said so.
 */
import { type QueryOutcome, lookup, refOf, textOf } from "../didox/resolve.js";
import { type Context, type OperationType, choosePosting } from "../engine/posting-rules.js";
import type { BankCache, BankDeps, Template, Who } from "./resolve.js";
import { currencyFromText } from "./policy.js";
import { THEIR_ACCOUNT_NAMES, ownAccountOf } from "./roles.js";
import type { BankPayment } from "./statement.js";

export type Field = { name: string; types: string[]; synonym?: string };
export interface Described {
  attributes: Field[];
  tabularSections: { name: string; attributes: Field[] }[];
}
export interface EnumValue {
  type: string;
  /** The value's name, which is what a change writes. */
  ref: string;
  /** What the person sees ("Оплата покупателя"). */
  name: string;
}
interface ContractRow {
  ref: string;
  number: string;
  date: string;
  /** The currency the contract is settled in, in letters ("" when 1C did not say). */
  currency: string;
  /** "buyer", "supplier" or "other". */
  kind: "buyer" | "supplier" | "other";
}

export interface ScaffoldCache {
  described: Map<string, Described | null>;
  enums: Map<string, EnumValue[] | null>;
  accounts: Map<string, string | null>;
  contracts: Map<string, ContractRow[] | null>;
  /** Accounts that can hold settlements in a currency, by the code the rules name (see `currencyAccount`). */
  currencyAccounts: Map<string, { ref: string; code: string } | { ref: null; message: string }>;
  soum?: string | null;
}

export interface ScaffoldInput {
  object: "Документ.ПоступлениеНаРасчетныйСчет" | "Документ.СписаниеСРасчетногоСчета";
  payment: BankPayment;
  who: Who | null;
  /** The company's organization in 1C. */
  organization: string | null;
  /** The company's own posting rules and its chart of accounts. */
  posting?: Context;
  /** The contract the purpose names, when it has already been found. */
  contract?: string | null;
  /** The account's currency in letters ("" or "UZS": soums) and its item in 1C's catalog, for an account in a currency. */
  currency?: string;
  currencyRef?: string | null;
}

export type Scaffolded =
  | { ok: true; template: Template; contract: string | null; contractCurrency: string; notes: string[] }
  | { ok: false; message: string };

/** Payments whose operation and accounts are the company's own choice, not a supplier's or a buyer's payment. */
const NOT_PLAIN =
  /зарплат|заработн|ish\s*haq|oylik|аванс\p{L}*\s+(?:сотрудн|работник|по\s+зп)|комисси|komissiya|xizmat\s+haqi\s+bank|кредит|займ|ссуд|процент|foiz|qarz\s+(?:berish|qaytar)|дивиденд|dividend|подотч|hisobdor|командиров|алимент|штраф|jarima|конвертац|konvertats|собственн\p{L}*\s+сч[её]т|o['‘’ʻ`]z\s+hisob/iu;

const rounded = (n: number) => Math.round(n * 1e12) / 1e12;

const attributeNames = (d: Described) => new Set(d.attributes.map((a) => a.name));

export async function describeCached(
  deps: BankDeps,
  cache: ScaffoldCache,
  object: string,
): Promise<Described | null> {
  if (cache.described.has(object)) return cache.described.get(object) ?? null;
  const outcome = await deps.describe([object]);
  const data = outcome.ok ? (outcome.data as Described[])[0] : undefined;
  const described =
    data && Array.isArray(data.attributes)
      ? { attributes: data.attributes, tabularSections: data.tabularSections ?? [] }
      : null;
  cache.described.set(object, described);
  return described;
}

/** The values of an enumeration, as 1C writes them: the name to write, and the presentation a person reads. */
export async function enumValues(
  deps: BankDeps,
  cache: ScaffoldCache,
  enumeration: string,
): Promise<EnumValue[] | null> {
  if (cache.enums.has(enumeration)) return cache.enums.get(enumeration) ?? null;
  const outcome: QueryOutcome = await deps.query({
    query: `ВЫБРАТЬ Т.Ссылка КАК Ссылка ИЗ ${enumeration} КАК Т`,
    limit: 100,
    refs: true,
  });
  const values = outcome.ok
    ? ((outcome.data as { rows?: unknown[][] }).rows ?? []).flatMap((cells) => {
        const ref = refOf(cells[0]);
        return ref ? [{ type: enumeration, ref, name: textOf(cells[0]) || ref }] : [];
      })
    : null;
  cache.enums.set(enumeration, values);
  return values;
}

const squash = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");

/** The enumeration value whose name or presentation contains one of the phrases. */
export const valueLike = (values: EnumValue[], phrases: string[]) =>
  values.find((v) => phrases.some((p) => squash(`${v.name} ${v.ref}`).includes(squash(p))));

/** The refs of ledger accounts by their codes (one read), null for a code the chart does not have. */
export async function accountRefs(
  deps: BankDeps,
  cache: ScaffoldCache,
  codes: string[],
): Promise<Map<string, string | null>> {
  const missing = codes.filter((c) => !cache.accounts.has(c));
  if (missing.length > 0) {
    const rows = await lookup(
      deps,
      (ph) =>
        `ВЫБРАТЬ Т.Код КАК Код, Т.Ссылка КАК Ссылка ИЗ ПланСчетов.Хозрасчетный КАК Т ГДЕ Т.Код В (${ph})`,
      missing,
    );
    for (const code of missing) cache.accounts.set(code, null);
    for (const { cells } of rows ?? []) {
      const ref = refOf(cells[1]);
      if (ref) cache.accounts.set(String(cells[0] ?? ""), ref);
    }
  }
  return new Map(codes.map((c) => [c, cache.accounts.get(c) ?? null]));
}

/**
 * An account of the chart that can hold settlements in a currency, for the code a rule names. 1C refuses a currency
 * contract on an account that is not a currency one ("the account is not meant for settlements in a currency"), so the
 * account is checked for the chart's own flag; when the named one is not, the currency one of the same group is used if
 * there is exactly one, else the answer says which there are.
 */
export async function currencyAccount(
  deps: BankDeps,
  cache: ScaffoldCache,
  code: string,
): Promise<{ ref: string; code: string } | { ref: null; message: string }> {
  const known = cache.currencyAccounts.get(code);
  if (known) return known;
  const answer = async (): Promise<{ ref: string; code: string } | { ref: null; message: string }> => {
    const rows = await lookup(
      deps,
      (ph) =>
        `ВЫБРАТЬ Т.Код КАК Код, Т.Ссылка КАК Ссылка, Т.Валютный КАК Валютный ИЗ ПланСчетов.Хозрасчетный КАК Т ГДЕ Т.Код В (${ph})`,
      [code],
    );
    const first = rows?.[0]?.cells;
    const ref = first ? refOf(first[1]) : null;
    // The chart could not be asked about the flag: the account is taken as it is, and the card shows 1C's own opinion.
    if (rows === null) {
      const plain = (await accountRefs(deps, cache, [code])).get(code) ?? null;
      return plain
        ? { ref: plain, code }
        : { ref: null, message: `the company's chart has no account ${code}` };
    }
    if (!first || !ref) return { ref: null, message: `the company's chart has no account ${code}` };
    if (first[2] === true) return { ref, code };
    const group = await deps.query({
      query:
        "ВЫБРАТЬ Т.Код КАК Код, Т.Ссылка КАК Ссылка ИЗ ПланСчетов.Хозрасчетный КАК Т ГДЕ Т.Код ПОДОБНО &Группа И Т.Валютный УПОРЯДОЧИТЬ ПО Т.Код",
      params: { Группа: `${code.slice(0, 2)}%` },
      limit: 20,
      refs: true,
    });
    const options = group.ok
      ? ((group.data as { rows?: unknown[][] }).rows ?? []).flatMap((cells) => {
          const r = refOf(cells[1]);
          return r ? [{ ref: r, code: String(cells[0] ?? "") }] : [];
        })
      : [];
    const [only] = options;
    if (options.length === 1 && only) return only;
    return {
      ref: null,
      message: `account ${code} is not meant for settlements in a currency, and ${options.length === 0 ? "the chart has no currency account of its group" : `the chart has several currency accounts of its group (${options.map((o) => o.code).join(", ")})`}: the accountant says which`,
    };
  };
  const result = await answer();
  cache.currencyAccounts.set(code, result);
  return result;
}

async function contractsOf(deps: BankDeps, cache: ScaffoldCache, who: Who): Promise<ContractRow[] | null> {
  const key = who.key;
  if (cache.contracts.has(key)) return cache.contracts.get(key) ?? null;
  const rows = await lookup(
    deps,
    (ph) =>
      `ВЫБРАТЬ Т.Владелец.${who.field} КАК Ключ, Т.Ссылка КАК Ссылка, Т.Номер КАК Номер, Т.Дата КАК Дата, Т.ВидДоговора КАК Вид, Т.ВалютаВзаиморасчетов.Код КАК Валюта ИЗ Справочник.ДоговорыКонтрагентов КАК Т ГДЕ Т.Владелец.${who.field} В (${ph}) И НЕ Т.ПометкаУдаления`,
    [who.value],
  );
  const list: ContractRow[] | null = rows
    ? rows.flatMap(({ cells }) => {
        const ref = refOf(cells[1]);
        if (!ref) return [];
        const kind = squash(`${textOf(cells[4])} ${(cells[4] as { ref?: string } | null)?.ref ?? ""}`);
        return [
          {
            ref,
            number: String(cells[2] ?? ""),
            date: String(cells[3] ?? "").slice(0, 10),
            currency: currencyFromText(String(cells[5] ?? "")),
            kind:
              kind.includes("спокупател") || kind.includes("покупател")
                ? ("buyer" as const)
                : kind.includes("споставщик") || kind.includes("поставщик")
                  ? ("supplier" as const)
                  : ("other" as const),
          },
        ];
      })
    : null;
  cache.contracts.set(key, list);
  return list;
}

/** The VAT rate a purpose states ("в т.ч. НДС 12%"), or 0 when it says none. */
export function vatRateIn(purpose: string): number | null {
  if (
    /без\s+(?:учета\s+)?(?:ндс|ққс|qqs)|(?:ндс|ққс|qqs)\s+не\s+облагается|qqs\s+siz|ққс\s+сиз/iu.test(purpose)
  )
    return 0;
  const found = /(?:ндс|ққс|qqs|ккс)[^\d%]{0,20}(\d{1,2}(?:[.,]\d)?)\s*%/iu.exec(purpose);
  return found ? Number((found[1] ?? "0").replace(",", ".")) : null;
}

export const OPERATIONS = {
  buyerPays: {
    phrases: ["оплата покупателя", "оплатапокупателя"],
    money: "payment_from_buyer",
    advance: "advance_from_buyer",
  },
  supplierPays: {
    phrases: ["оплата поставщику", "оплатапоставщику"],
    money: "payment_to_supplier",
    advance: "advance_to_supplier",
  },
  buyerRefund: {
    phrases: ["возврат покупателю", "возвратпокупателю"],
    money: "payment_from_buyer",
    advance: "advance_from_buyer",
  },
  supplierRefund: {
    phrases: ["возврат от поставщика", "возвратотпоставщика", "возврат поставщиком"],
    money: "payment_to_supplier",
    advance: "advance_to_supplier",
  },
} as const;
export type Operation = keyof typeof OPERATIONS;

const operationOf = (direction: "in" | "out", kind: ContractRow["kind"]): Operation | null =>
  kind === "buyer"
    ? direction === "in"
      ? "buyerPays"
      : "buyerRefund"
    : kind === "supplier"
      ? direction === "out"
        ? "supplierPays"
        : "supplierRefund"
      : null;

/** Of a counterparty's contracts, the one the payment is under: the one the purpose names, else the newest not after the payment. */
function pickContract(
  list: ContractRow[],
  payment: BankPayment,
  kind: ContractRow["kind"],
  named: string | null,
) {
  if (named) {
    const found = list.find((c) => c.ref === named);
    if (found) return found;
  }
  const ofKind = list.filter((c) => c.kind === kind).sort((a, b) => b.date.localeCompare(a.date));
  return ofKind.find((c) => c.date <= payment.date) ?? ofKind[0] ?? null;
}

export function newScaffoldCache(): ScaffoldCache {
  return {
    described: new Map(),
    enums: new Map(),
    accounts: new Map(),
    contracts: new Map(),
    currencyAccounts: new Map(),
  };
}

export async function scaffoldTemplate(
  deps: BankDeps,
  cache: BankCache,
  input: ScaffoldInput,
): Promise<Scaffolded> {
  const sc = (cache.scaffold ??= newScaffoldCache());
  const { object, payment, who } = input;
  const short = object.replace("Документ.", "");
  const refuse = (why: string): Scaffolded => ({
    ok: false,
    message: `no earlier ${short} to copy, and one cannot be made from 1C's own description: ${why}`,
  });
  if (NOT_PLAIN.test(payment.purpose))
    return refuse(
      "the purpose is not a plain payment to or from a counterparty (pay, a loan, a bank fee…): its operation and accounts are the company's own choice, so post one such document by hand, or tell the program how to book it",
    );
  if (!who) return refuse("the statement names no counterparty (no INN) to find a contract for");
  const described = await describeCached(deps, sc, object);
  if (!described) return refuse(`1C did not describe ${object}`);
  const have = attributeNames(described);
  if (!have.has("ВидОперации")) return refuse(`${object} has no ВидОперации`);

  const contracts = await contractsOf(deps, sc, who);
  if (!contracts) return refuse("1C could not be asked for the counterparty's contracts");
  const contractKind: ContractRow["kind"] =
    payment.direction === "in"
      ? contracts.some((c) => c.kind === "buyer")
        ? "buyer"
        : "supplier"
      : contracts.some((c) => c.kind === "supplier")
        ? "supplier"
        : "buyer";
  const operation = operationOf(payment.direction, contractKind);
  const chosen =
    contracts.length > 0 && operation
      ? pickContract(contracts, payment, contractKind, input.contract ?? null)
      : null;
  if (!operation || !chosen)
    return refuse(
      contracts.length === 0
        ? "the counterparty has no contract in 1C"
        : "the counterparty has no contract «с покупателем» or «с поставщиком» that this payment can be under",
    );

  // The operation: the value of the document's own enumeration.
  const operationType = described.attributes
    .find((a) => a.name === "ВидОперации")
    ?.types.find((t) => t.startsWith("Перечисление"));
  const values = operationType ? await enumValues(deps, sc, operationType) : null;
  if (!values) return refuse("the operations of the document could not be read from 1C");
  const kindValue = valueLike(values, [...OPERATIONS[operation].phrases]);
  if (!kindValue)
    return refuse(
      `1C has no operation like «${OPERATIONS[operation].phrases[0]}» (it has ${values.map((v) => v.name).join(", ")})`,
    );

  // The breakdown of the payment.
  const section = described.tabularSections.find((s) => s.attributes.some((a) => a.name === "СуммаПлатежа"));
  const columns = new Set(section?.attributes.map((a) => a.name) ?? []);
  if (!section || columns.size === 0) return refuse(`${object} has no breakdown of the payment`);

  const notes: string[] = [];
  // Accounts: the table of rules (the company's own first), checked against its chart.
  const money = choosePosting(
    { type: OPERATIONS[operation].money as OperationType, date: payment.date },
    input.posting,
  );
  const advance = choosePosting(
    { type: OPERATIONS[operation].advance as OperationType, date: payment.date },
    input.posting,
  );
  const settlementCode =
    operation === "buyerPays" || operation === "buyerRefund" ? money.credit : money.debit;
  const advanceCode =
    operation === "buyerPays" || operation === "buyerRefund" ? advance.credit : advance.debit;
  const codes = [settlementCode, advanceCode].filter((c): c is string => Boolean(c));
  const refs = await accountRefs(deps, sc, codes);
  // A contract in a currency needs accounts that can hold settlements in it; 1C refuses the soum ones.
  const inCurrency = chosen.currency !== "" && chosen.currency !== "UZS";
  const currencyOnes = new Map<string, { ref: string; code: string }>();
  if (inCurrency) {
    for (const code of codes) {
      const found = await currencyAccount(deps, sc, code);
      if ("message" in found) notes.push(`${found.message}: that column is left for 1C to fill; check it`);
      else currencyOnes.set(code, found);
    }
  }
  const account = (code: string | undefined) => {
    if (!code) return null;
    const ref = inCurrency ? currencyOnes.get(code)?.ref : refs.get(code);
    return ref ? { type: "ПланСчетов.Хозрасчетный", ref } : null;
  };
  const settlement = columns.has("СчетРасчетов")
    ? "СчетРасчетов"
    : [...columns].find((c) => /^СчетУчетаРасчетов/.test(c));
  const advances = columns.has("СчетАвансов")
    ? "СчетАвансов"
    : [...columns].find((c) => /^СчетУчетаАвансов/.test(c));
  for (const [label, code, column] of [
    ["settlement", settlementCode, settlement],
    ["advance", advanceCode, advances],
  ] as const) {
    if (column && !inCurrency && !account(code))
      notes.push(
        `the ${label} account ${code ?? "(none)"} is not in the company's chart: that column is left for 1C to fill; check it`,
      );
  }
  if (money.source !== "rule" || money.needsApproval) notes.push(`accounts: ${money.reason}`);

  // VAT from the purpose.
  let vatEnum: EnumValue | undefined;
  let vatShare = 0;
  const vatType = section.attributes
    .find((a) => a.name === "СтавкаНДС")
    ?.types.find((t) => t.startsWith("Перечисление"));
  if (vatType) {
    const rates = await enumValues(deps, sc, vatType);
    const stated = vatRateIn(payment.purpose);
    if (rates) {
      if (stated !== null && stated > 0) {
        vatEnum = rates.find(
          (r) =>
            squash(r.name) === `${stated}%` ||
            squash(r.name) === `ндс${stated}%` ||
            squash(r.ref) === `ндс${stated}`,
        );
        if (vatEnum) vatShare = rounded(stated / (100 + stated));
        else
          notes.push(
            `the purpose states VAT ${stated}%, which 1C's rates do not have (${rates.map((r) => r.name).join(", ")}): the document is made without VAT; check it`,
          );
      }
      vatEnum ??= valueLike(rates, ["без ндс", "безндс"]);
      if (stated === null)
        notes.push("the purpose does not state VAT: the document is made without VAT («Без НДС»); check it");
    }
  }

  // The header: only the attributes 1C describes.
  const fields: Record<string, unknown> = {};
  const put = (name: string, value: unknown) => {
    if (have.has(name)) fields[name] = value;
  };
  put("ВидОперации", kindValue);
  put("СуммаДокумента", 1);
  const ownKey = ownAccountOf(described.attributes);
  for (const name of [
    "НазначениеПлатежа",
    "НомерВходящегоДокумента",
    "ДатаВходящегоДокумента",
    ...(ownKey ? [ownKey] : []),
    "Контрагент",
    ...THEIR_ACCOUNT_NAMES,
  ])
    put(name, null);
  put("ДоговорКонтрагента", null);
  if (have.has("Организация") && input.organization)
    fields["Организация"] = { type: "Справочник.Организации", ref: input.organization };
  const foreign = input.currency !== undefined && input.currency !== "" && input.currency !== "UZS";
  if (have.has("ВалютаДокумента")) {
    if (foreign) {
      if (!input.currencyRef) return refuse(`1C has no currency ${input.currency} in its catalog`);
      fields["ВалютаДокумента"] = { type: "Справочник.Валюты", ref: input.currencyRef };
    } else {
      sc.soum ??= await soumRef(deps);
      if (sc.soum) fields["ВалютаДокумента"] = { type: "Справочник.Валюты", ref: sc.soum };
      else notes.push("the soum is not in 1C's currencies: the document's currency is left for 1C to fill");
    }
  } else if (foreign) return refuse(`${object} has no currency of the document`);
  // The rate of the document's currency: the copy puts the day's rate in.
  put("КурсДокумента", 1);
  put("КратностьДокумента", 1);
  if (!("Контрагент" in fields)) return refuse(`${object} has no Контрагент`);

  // One row, as the company's own payments have: sums of 1 that the copy scales to the payment's amount.
  const row: Record<string, unknown> = {};
  const set = (name: string, value: unknown) => {
    if (columns.has(name)) row[name] = value;
  };
  set("ДоговорКонтрагента", null);
  set("СуммаПлатежа", 1);
  set("КурсВзаиморасчетов", 1);
  set("КратностьВзаиморасчетов", 1);
  set("СуммаВзаиморасчетов", 1);
  if (vatEnum) set("СтавкаНДС", vatEnum);
  set("СуммаНДС", vatShare);
  if (settlement && account(settlementCode)) row[settlement] = account(settlementCode);
  if (advances && account(advanceCode)) row[advances] = account(advanceCode);

  notes.push(
    `no earlier ${short} in 1C: the document is made from 1C's own description of it. Operation «${kindValue.name}», settlement account ${settlementCode ?? "?"}, advances ${advanceCode ?? "?"}, contract ${chosen.number} of ${chosen.date.split("-").reverse().join(".")}${vatEnum ? `, VAT ${vatEnum.name}` : ""}; check the first documents`,
  );
  return {
    ok: true,
    template: {
      object,
      ref: "(made from 1C's description)",
      fields,
      tables: { [section.name]: [row] },
      synthetic: true,
    },
    contract: chosen.ref,
    contractCurrency: chosen.currency || "UZS",
    notes,
  };
}

/** The soum item of the currencies catalog, whichever code the base keeps it under. */
export async function soumRef(deps: BankDeps): Promise<string | null> {
  for (const code of ["860", "UZS", "000", "сўм", "сум"]) {
    const outcome = await deps.query({
      query: "ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ Справочник.Валюты КАК Т ГДЕ Т.Код = &Код",
      params: { Код: code },
      limit: 1,
      refs: true,
    });
    const found = outcome.ok ? refOf((outcome.data as { rows?: unknown[][] }).rows?.[0]?.[0]) : null;
    if (found) return found;
  }
  return null;
}
