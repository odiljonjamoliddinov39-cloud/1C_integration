/** A fake 1C base for the sale builder's tests and simulations. */
import type { BankDeps } from "../bank/resolve.js";
import { type DidoxDocument, parseDidoxDocument } from "./document.js";

export const OWN_INN = "300000001";
export const BUYER_INN = "201607534";
export const BUYER = "11111111-1111-4111-8111-111111111111";
export const CONTRACT = "22222222-2222-4222-8222-222222222222";
export const ITEM_SOAP = "33333333-3333-4333-8333-333333333333";
export const ITEM_RENT = "44444444-4444-4444-8444-444444444444";
export const SALE_OLD = "55555555-5555-4555-8555-555555555555";
export const SALE_SERVICES = "66666666-6666-4666-8666-666666666666";
export const UNIT_PCS = "77777777-7777-4777-8777-777777777777";

export const ref = (type: string, id: string, name: string) => ({ type, ref: id, name });

export const line = (name: string, over: Record<string, unknown> = {}) => ({
  ordno: 1,
  name,
  catalogcode: "10403003014000001",
  packagename: "шт",
  count: "10",
  summa: "1000",
  deliverysum: "10000",
  vatrate: 12,
  vatsum: "1200",
  deliverysumwithvat: "11200",
  ...over,
});

export function invoice(
  products: Record<string, unknown>[],
  over: Record<string, unknown> = {},
): DidoxDocument {
  const doc = parseDidoxDocument({
    facturaid: "abc",
    facturadoc: { facturano: "24", facturadate: "2026-09-10" },
    facturatype: 0,
    sellertin: OWN_INN,
    seller: { name: "CRYSTAL" },
    buyertin: BUYER_INN,
    buyer: { name: "NAVRO'Z-PTK" },
    contractdoc: { contractno: "17", contractdate: "2025-08-08" },
    productlist: { hasvat: true, products },
    ...over,
  });
  if (!doc) throw new Error("the fake invoice is not a Didox document");
  return doc;
}

/** The company's earlier sale: goods lines with the company's accounts, and (in another one) a service line. */
export const earlierSale = (kind: "goods" | "services", over: Record<string, unknown> = {}) => ({
  fields: {
    Номер: "РТ-000007",
    Дата: "2026-08-01T00:00:00",
    Проведен: true,
    ВидОперации: ref("Перечисление.ВидыОперацийРеализация", "Товары", "Товары"),
    Организация: ref("Справочник.Организации", "99999999-9999-4999-8999-999999999999", "CRYSTAL"),
    Контрагент: ref("Справочник.Контрагенты", "00000000-0000-4000-8000-000000000001", "старый"),
    ДоговорКонтрагента: ref(
      "Справочник.ДоговорыКонтрагентов",
      "00000000-0000-4000-8000-000000000002",
      "старый",
    ),
    Склад: ref("Справочник.Склады", "88888888-8888-4888-8888-888888888888", "Основной"),
    СуммаВключаетНДС: false,
    СуммаДокумента: 5600,
    Комментарий: "старый",
    ДокументОснование: ref("Документ.Заказ", "00000000-0000-4000-8000-000000000003", "заказ"),
    ...over,
  },
  tables:
    kind === "goods"
      ? {
          Товары: [
            {
              Номенклатура: ref(
                "Справочник.Номенклатура",
                "00000000-0000-4000-8000-000000000004",
                "старый товар",
              ),
              Количество: 5,
              Цена: 1000,
              Сумма: 5000,
              СтавкаНДС: ref("Перечисление.СтавкиНДС", "НДС12", "12%"),
              СуммаНДС: 600,
              Всего: 5600,
              СчетУчета: ref("ПланСчетов.Хозрасчетный", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "2910"),
              СчетДоходов: ref("ПланСчетов.Хозрасчетный", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "9010"),
            },
          ],
          Услуги: [],
        }
      : {
          Товары: [],
          Услуги: [
            {
              Номенклатура: ref(
                "Справочник.Номенклатура",
                "00000000-0000-4000-8000-000000000005",
                "старая услуга",
              ),
              Количество: 1,
              Цена: 5000,
              Сумма: 5000,
              СтавкаНДС: ref("Перечисление.СтавкиНДС", "НДС12", "12%"),
              СуммаНДС: 600,
              Всего: 5600,
              СчетДоходов: ref("ПланСчетов.Хозрасчетный", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "9030"),
            },
          ],
        },
});

export interface World {
  buyers?: boolean;
  contracts?: [string, string, string][];
  vat?: string[];
  items?: [string, string][];
  existing?: [string, string, number][];
  sales?: { ref: string; kind: "goods" | "services"; buyer?: boolean; over?: Record<string, unknown> }[];
}

export function deps(world: World = {}): BankDeps {
  const sales = world.sales ?? [{ ref: SALE_OLD, kind: "goods" as const, buyer: true }];
  const rows = (list: unknown[][]) => ({ ok: true as const, data: { rows: list } });
  const vat = world.vat ?? ["Без НДС", "12%"];
  return {
    async query(input) {
      const q = input.query;
      const params = Object.values(input.params ?? {});
      if (q.includes("Справочник.Контрагенты КАК Т ГДЕ Т.ИНН В"))
        return rows(
          world.buyers === false
            ? []
            : params.includes(BUYER_INN)
              ? [[BUYER_INN, ref("Справочник.Контрагенты", BUYER, "NAVRO'Z-PTK"), "NAVRO'Z-PTK"]]
              : [],
        );
      if (q.includes("ДоговорыКонтрагентов"))
        return rows(
          (world.contracts ?? [[CONTRACT, "17", "2025-08-08T00:00:00"]]).map(([id, number, date]) => [
            BUYER_INN,
            ref("Справочник.ДоговорыКонтрагентов", id, `№${number}`),
            number,
            date,
          ]),
        );
      if (q.includes("ПРЕДСТАВЛЕНИЕ(Т.Ссылка)")) return rows(vat.map((v) => [v]));
      if (q.includes("Перечисление.СтавкиНДС"))
        return rows(vat.map((v) => [ref("Перечисление.СтавкиНДС", `НДС${v.replace(/\D/g, "") || "0"}`, v)]));
      if (q.includes("Т.ЕдиницаИзмерения КАК Единица"))
        return rows(
          (
            world.items ?? [
              ["Жидкое мыло", ITEM_SOAP],
              ["Аренда офиса", ITEM_RENT],
            ]
          )
            .filter(([name]) => params.includes(name))
            .map(([, id]) => [
              ref("Справочник.Номенклатура", id, "x"),
              ref("Справочник.ЕдиницыИзмерения", UNIT_PCS, "шт"),
            ]),
        );
      if (q.includes("Справочник.Номенклатура КАК Т ГДЕ Т.Наименование В"))
        return rows(
          (
            world.items ?? [
              ["Жидкое мыло", ITEM_SOAP],
              ["Аренда офиса", ITEM_RENT],
            ]
          )
            .filter(([name]) => params.includes(name))
            .map(([name, id]) => [name, ref("Справочник.Номенклатура", id, name)]),
        );
      if (q.includes("РеализацияТоваровУслуг") && q.includes("Т.Дата МЕЖДУ"))
        return rows((world.existing ?? []).map(([inn, date, sum]) => [inn, date, sum]));
      if (q.includes("РеализацияТоваровУслуг") && q.includes("ПЕРВЫЕ 10")) {
        const byBuyer = q.includes("Контрагент.ИНН = &инн");
        return rows(
          sales
            .filter((s) => !byBuyer || s.buyer)
            .map((s) => [ref("Документ.РеализацияТоваровУслуг", s.ref, "продажа")]),
        );
      }
      return rows([]);
    },
    async describe() {
      return { ok: true, data: [] };
    },
    async getObject(object, id) {
      const found = sales.find((s) => s.ref === id);
      return found
        ? { ok: true, data: { object, ref: id, ...earlierSale(found.kind, found.over) } }
        : { ok: false, code: "NOT_FOUND", message: "no such document" };
    },
  };
}
