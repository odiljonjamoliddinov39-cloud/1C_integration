import { describe, expect, it } from "vitest";

import { daysBetween, fetchCbuRates, parseCbu, planRates } from "./cbu.js";

const answer = (ccy: string, rate: string, nominal = "1") => [
  { id: 69, Code: "840", Ccy: ccy, Nominal: nominal, Rate: rate, Date: "31.12.2024" },
];

describe("cbu rates", () => {
  it("lists every day of a period, leap years included", () => {
    expect(daysBetween("2024-02-27", "2024-03-01")).toEqual([
      "2024-02-27",
      "2024-02-28",
      "2024-02-29",
      "2024-03-01",
    ]);
  });

  it("reads the bank's answer, with a comma or a dot and a nominal", () => {
    expect(parseCbu(answer("USD", "12807.69"), "USD", "2024-12-31")).toEqual({
      date: "2024-12-31",
      rate: 12807.69,
      multiplicity: 1,
    });
    expect(parseCbu(answer("JPY", "84,5", "10"), "JPY", "2024-12-31")).toMatchObject({
      rate: 84.5,
      multiplicity: 10,
    });
    expect(parseCbu([], "USD", "2024-12-31")).toBeNull();
    expect(parseCbu(answer("USD", "oops"), "USD", "2024-12-31")).toBeNull();
    expect(parseCbu({ error: 1 }, "USD", "2024-12-31")).toBeNull();
  });

  it("asks the bank for each day, asks again once on a failure, and counts the days it could not ask", async () => {
    const asked: string[] = [];
    let flaky = 0;
    const fake = (async (url: string) => {
      asked.push(url);
      if (url.includes("2024-01-02")) throw new Error("offline");
      if (url.includes("2024-01-03") && flaky++ === 0) return new Response("", { status: 500 });
      return new Response(JSON.stringify(answer("USD", "12000.5")), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await fetchCbuRates("USD", "2024-01-01", "2024-01-04", { fetch: fake });
    expect(out.rates.map((r) => r.date)).toEqual(["2024-01-01", "2024-01-03", "2024-01-04"]);
    expect(out.failed).toBe(1);
    expect(asked[0]).toBe("https://cbu.uz/ru/arkhiv-kursov-valyut/json/USD/2024-01-01/");
  });

  it("refuses a period too long for one call", async () => {
    await expect(fetchCbuRates("USD", "2020-01-01", "2024-12-31")).rejects.toThrow("At most");
  });

  it("writes only the days 1C has no rate for, and not a day that repeats the rate before it", () => {
    const bank = [
      { date: "2024-01-01", rate: 12000, multiplicity: 1 },
      { date: "2024-01-02", rate: 12000, multiplicity: 1 },
      { date: "2024-01-03", rate: 12010, multiplicity: 1 },
      { date: "2024-01-04", rate: 12020, multiplicity: 1 },
      { date: "2024-01-05", rate: 12020, multiplicity: 1 },
    ];
    const existing = new Map([
      ["2024-01-04", 12020],
      ["2024-01-05", 9999],
    ]);
    const plan = planRates(bank, existing);
    expect(plan.toWrite.map((d) => d.date)).toEqual(["2024-01-01", "2024-01-03"]);
    expect(plan).toMatchObject({ same: 1, differ: 1 });
  });
});
