import { describe, expect, it } from "vitest";

import { Api, ApiError } from "./api.js";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the CRM Mini App's API client", () => {
  it("signs in once with Telegram's data, then calls with the session token", async () => {
    const seen: { url: string; auth: string }[] = [];
    const http = (async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization ?? "";
      seen.push({ url, auth });
      if (url === "/v1/crm/session")
        return reply(200, {
          accessToken: "T1",
          me: { id: "a", name: "Ali", role: "manager", seesAll: false },
        });
      return reply(200, { total: 0, leads: [] });
    }) as unknown as typeof fetch;
    const api = new Api(() => "signed-init-data", http);
    await api.leads("", "");
    await api.leads("ali", "");
    expect(seen.map((s) => s.auth)).toEqual(["tma signed-init-data", "Bearer T1", "Bearer T1"]);
    expect(seen[2]?.url).toContain("q=ali");
  });

  it("signs in again when the token is refused", async () => {
    let session = 0;
    const http = (async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization ?? "";
      if (url === "/v1/crm/session") return reply(200, { accessToken: `T${++session}`, me: {} });
      return auth === "Bearer T2"
        ? reply(200, { id: "x" })
        : reply(401, { code: "UNAUTHORIZED", message: "Sign in again" });
    }) as unknown as typeof fetch;
    const api = new Api(() => "d", http);
    await expect(api.lead("11111111-1111-1111-1111-111111111111")).resolves.toEqual({ id: "x" });
    expect(session).toBe(2);
  });

  it("raises the server's code, and NETWORK when there is no connection", async () => {
    const refusing = (async () =>
      reply(403, { code: "NOT_LINKED", message: "no" })) as unknown as typeof fetch;
    await expect(new Api(() => "d", refusing).session()).rejects.toMatchObject({
      code: "NOT_LINKED",
      status: 403,
    });
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const error = await new Api(() => "d", offline).me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("NETWORK");
  });
});
