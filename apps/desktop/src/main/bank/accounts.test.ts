import { describe, expect, it } from "vitest";

import { type AccountCandidate, candidateOf, pickAccount } from "./accounts.js";

const NUMBER = "22613000405733821001";
const own = (ref: string, over: Partial<AccountCandidate> = {}): AccountCandidate => ({
  ref,
  inn: "311012912",
  owner: "TEXMASH IMPORT MCHJ",
  org: true,
  ...over,
});

describe("which bank account of 1C a number is", () => {
  it("is the organization's when the company is a counterparty of itself with the same number and INN", () => {
    const picked = pickAccount(
      NUMBER,
      [own("as-counterparty", { org: false }), own("as-organization")],
      "311012912",
    );
    expect(picked).toEqual({ ok: true, ref: "as-organization" });
  });

  it("is the only account of the number when 1C did not say who owns it (old answers)", () => {
    expect(pickAccount(NUMBER, [own("only", { org: null })], "311012912")).toEqual({ ok: true, ref: "only" });
    // an owner with another INN is not the company's
    expect(pickAccount(NUMBER, [own("x", { org: null, inn: "999999999" })], "311012912").ok).toBe(false);
  });

  it("says so when two accounts of the organization have the number, with their owners", () => {
    const picked = pickAccount(NUMBER, [own("a"), own("b")], "311012912");
    expect(picked.ok).toBe(false);
    if (!picked.ok) expect(picked.why).toContain("2 bank accounts of the company have the number");
  });

  it("says so when the number is only under another owner, and when 1C has none", () => {
    const foreign = pickAccount(
      NUMBER,
      [own("a", { org: false, inn: "207117389", owner: "KAPITALBANK" })],
      "311012912",
    );
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.why).toContain("only under another owner: KAPITALBANK");
    const none = pickAccount(NUMBER, [], "311012912");
    expect(none).toEqual({ ok: false, why: `1C has no bank account ${NUMBER}` });
  });

  it("reads the owner columns of a query row", () => {
    expect(candidateOf("r", ["n", {}, "311 012 912", "TEXMASH", 1], 2)).toEqual({
      ref: "r",
      inn: "311 012 912",
      owner: "TEXMASH",
      org: true,
    });
    expect(candidateOf("r", ["n", {}], 2).org).toBeNull();
  });
});
