import { DEFAULT_AI_POLICY } from "@platform/shared";
import { describe, expect, it } from "vitest";

import { lowerEffort, routeModel } from "./router.js";

const choice = { model: "claude-sonnet-5-5", effort: "high" as const };
const messages = [{ role: "user" as const, content: "x" }];

describe("routeModel effort", () => {
  it("lets a question with files to enter think less, and leaves every other question alone", () => {
    const base = { company: "X", messages };
    const imported = routeModel(choice, DEFAULT_AI_POLICY, { ...base, kind: "import" }, false, "medium");
    expect(imported).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium", simple: false });
    expect(routeModel(choice, DEFAULT_AI_POLICY, base, false, "medium").effort).toBe("high");
    // An audit keeps its effort, and so does an import when the setting is the same as the default.
    expect(routeModel(choice, DEFAULT_AI_POLICY, { ...base, kind: "import" }, true, "medium").effort).toBe(
      "high",
    );
    expect(routeModel(choice, DEFAULT_AI_POLICY, { ...base, kind: "import" }, false, "high").effort).toBe(
      "high",
    );
  });

  it("never raises an effort that is already lower", () => {
    expect(lowerEffort("low", "medium")).toBe("low");
    expect(lowerEffort("max", "medium")).toBe("medium");
    const low = { ...choice, effort: "low" as const };
    expect(
      routeModel(low, DEFAULT_AI_POLICY, { company: "X", messages, kind: "import" }, false, "medium").effort,
    ).toBe("low");
  });
});
