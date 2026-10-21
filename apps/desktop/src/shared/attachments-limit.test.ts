import { describe, expect, it } from "vitest";

import { ATTACHMENTS, AssistantInput } from "./ipc.js";

const file = (n: number) => ({ name: `vypiska-${n}.csv`, data: new Uint8Array([1, 2, 3]) });
const ask = (count: number) =>
  AssistantInput.safeParse({
    companyId: "c1",
    text: "kirit",
    files: Array.from({ length: count }, (_, i) => file(i)),
  });

describe("files per question", () => {
  it("takes at least ten, up to the limit, and no more", () => {
    expect(ATTACHMENTS.maxFiles).toBeGreaterThanOrEqual(10);
    expect(ask(10).success).toBe(true);
    expect(ask(ATTACHMENTS.maxFiles).success).toBe(true);
    expect(ask(ATTACHMENTS.maxFiles + 1).success).toBe(false);
  });
});
