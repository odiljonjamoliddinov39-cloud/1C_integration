/**
 * A contract made from 1C's own description of the directory, for a counterparty with no earlier contract to copy (a
 * foreign supplier a SWIFT payment names, in a base that never had one). Only the attributes the directory has are set:
 * the owner, the number and the date the bank's text names, the name as the company writes it ("№GR-TI-01 от 30.01.2024"),
 * the kind (with a supplier for money paid out, with a buyer for money received), the currency the settlements are in
 * (the payment's own, and said), and the organization. The expiry date is left empty: the bank does not say it.
 */
import type { ChangeInput } from "@platform/shared";

import { type EnumValue, describeCached, enumValues, newScaffoldCache, valueLike } from "./scaffold.js";
import type { BankCache, BankDeps } from "./resolve.js";

export interface ContractInput {
  /** The counterparty's reference. */
  owner: string;
  mention: { number: string; date: string };
  direction: "in" | "out";
  /** The currency of the settlements in letters ("UZS", "USD") and its item in 1C's catalog. */
  currency: string;
  currencyRef: string | null;
  organization: string | null;
}

const OBJECT = "Справочник.ДоговорыКонтрагентов";

export async function contractFromDescription(
  deps: BankDeps,
  cache: BankCache,
  input: ContractInput,
): Promise<{ ok: true; change: ChangeInput; note: string } | { ok: false; message: string }> {
  const sc = (cache.scaffold ??= newScaffoldCache());
  const described = await describeCached(deps, sc, OBJECT);
  if (!described) return { ok: false, message: `1C did not describe ${OBJECT}` };
  const have = new Set(described.attributes.map((a) => a.name));
  const [y, m, d] = input.mention.date.split("-");
  const name = `№${input.mention.number} от ${d}.${m}.${y}`;
  const fields: Record<string, unknown> = {
    Владелец: { type: "Справочник.Контрагенты", ref: input.owner },
    Наименование: name,
  };
  const put = (attribute: string, value: unknown) => {
    if (have.has(attribute)) fields[attribute] = value;
  };
  put("Номер", input.mention.number);
  put("Дата", input.mention.date);
  const kindType = described.attributes
    .find((a) => a.name === "ВидДоговора")
    ?.types.find((t) => t.startsWith("Перечисление"));
  if (kindType) {
    const values: EnumValue[] | null = await enumValues(deps, sc, kindType);
    const kind = values
      ? valueLike(
          values,
          input.direction === "out" ? ["с поставщиком", "споставщиком"] : ["с покупателем", "спокупателем"],
        )
      : undefined;
    if (!kind) return { ok: false, message: "the kinds of contract could not be read from 1C" };
    // An enumeration is written by the name of its value.
    fields["ВидДоговора"] = kind.ref;
  }
  if (have.has("ВалютаВзаиморасчетов")) {
    if (!input.currencyRef)
      return { ok: false, message: `1C has no currency ${input.currency} in its catalog` };
    fields["ВалютаВзаиморасчетов"] = { type: "Справочник.Валюты", ref: input.currencyRef };
  }
  if (have.has("Организация") && input.organization)
    fields["Организация"] = { type: "Справочник.Организации", ref: input.organization };
  return {
    ok: true,
    change: { action: "create", object: OBJECT, fields },
    note: `contract ${name} made from 1C's description of the directory: ${input.direction === "out" ? "with a supplier" : "with a buyer"}, settled in ${input.currency}, no expiry date; check it`,
  };
}
