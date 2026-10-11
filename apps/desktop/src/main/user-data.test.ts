import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { userDataFolder } from "./user-data.js";

const appData = join("C:", "Users", "x", "AppData", "Roaming");
const has = (...paths: string[]) => {
  const set = new Set(paths.map((p) => join(p, "platform.json")));
  return (path: string) => set.has(path);
};

describe("userDataFolder", () => {
  const current = join(appData, "AI Accounting Assistant");

  it("keeps the current folder when it holds the data, or when there is no data anywhere", () => {
    expect(userDataFolder(current, appData, has(current, join(appData, "1C Platform")))).toBe(current);
    expect(userDataFolder(current, appData, has())).toBe(current);
  });

  it("goes on with the folder an earlier build used", () => {
    const old = join(appData, "1C Platform");
    expect(userDataFolder(current, appData, has(old))).toBe(old);
    const nested = join(appData, "@platform", "desktop");
    expect(userDataFolder(current, appData, has(nested))).toBe(nested);
  });
});
