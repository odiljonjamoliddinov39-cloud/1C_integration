/**
 * The catalog item of a currency, for a base that lacks it (a cleared base, or one that never kept the ruble): what the
 * rates need before they can be written, because 1C writes a rate to the currency's own item. Only what 1C's catalog
 * always has: the numeric code (the one the rate loader looks the item up by), the short name, the full name and the
 * spelling of the amount in words. How the rate is set (by hand, from the Central Bank) is the accountant's choice and is
 * left to 1C's default.
 */
export interface CurrencyItem {
  code: string;
  name: string;
  fullName: string;
  /** "рубль, рубля, рублей, м, копейка, копейки, копеек, ж, 2": the parameters 1C spells amounts in words by. */
  spelling: string;
}

const ITEMS: Record<string, CurrencyItem> = {
  USD: {
    code: "840",
    name: "USD",
    fullName: "Доллар США",
    spelling: "доллар, доллара, долларов, м, цент, цента, центов, м, 2",
  },
  EUR: {
    code: "978",
    name: "EUR",
    fullName: "Евро",
    spelling: "евро, евро, евро, м, цент, цента, центов, м, 2",
  },
  RUB: {
    code: "643",
    name: "RUB",
    fullName: "Российский рубль",
    spelling: "рубль, рубля, рублей, м, копейка, копейки, копеек, ж, 2",
  },
  GBP: {
    code: "826",
    name: "GBP",
    fullName: "Фунт стерлингов",
    spelling: "фунт, фунта, фунтов, м, пенс, пенса, пенсов, м, 2",
  },
};

export const currencyItem = (currency: string): CurrencyItem | null => ITEMS[currency] ?? null;
