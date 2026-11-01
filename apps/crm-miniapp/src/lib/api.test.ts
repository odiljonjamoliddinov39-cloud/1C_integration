import { describe, expect, it } from "vitest";

import { Api, ApiError, type TokenStore } from "./api.js";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const memory = (initial: string | null = null): TokenStore & { value: string | null } => {
  const store = {
    value: initial,
    get: () => store.value,
    set: (token: string | null) => {
      store.value = token;
    },
  };
  return store;
};

describe("the CRM Mini App's API client", () => {
  it("signs in with the email and password, keeps the token and calls with it", async () => {
    const seen: { url: string; auth?: string; body?: string }[] = [];
    const http = (async (url: string, init: RequestInit) => {
      seen.push({
        url,
        auth: (init.headers as Record<string, string>).authorization,
        body: init.body as string | undefined,
      });
      if (url === "/v1/crm/login")
        return reply(200, { accessToken: "T1", expiresIn: 43200, mustChangePassword: false });
      return reply(200, { total: 0, leads: [] });
    }) as unknown as typeof fetch;
    const store = memory();
    const api = new Api(store, http);
    expect(api.signedIn).toBe(false);
    const session = await api.login("  ali@platform.uz ", "secret-password");
    expect(session.mustChangePassword).toBe(false);
    expect(store.value).toBe("T1");
    expect(api.signedIn).toBe(true);
    await api.leads("ali", "");
    expect(seen[0]).toMatchObject({ url: "/v1/crm/login", auth: undefined });
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
      email: "ali@platform.uz",
      password: "secret-password",
    });
    expect(seen[1]?.auth).toBe("Bearer T1");
    expect(seen[1]?.url).toContain("q=ali");
  });

  it("forgets a token the server refuses, so the person signs in again", async () => {
    const http = (async () =>
      reply(401, { code: "UNAUTHORIZED", message: "Sign in again" })) as unknown as typeof fetch;
    const store = memory("OLD");
    const api = new Api(store, http);
    await expect(api.me()).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
    expect(store.value).toBeNull();
    expect(api.signedIn).toBe(false);
  });

  it("keeps a token when the answer is not a refusal to sign in (a one-time password still to change)", async () => {
    const http = (async () =>
      reply(403, { code: "PASSWORD_CHANGE_REQUIRED", message: "x" })) as unknown as typeof fetch;
    const store = memory("T");
    await expect(new Api(store, http).me()).rejects.toMatchObject({
      code: "PASSWORD_CHANGE_REQUIRED",
      status: 403,
    });
    expect(store.value).toBe("T");
  });

  it("raises the server's code for a wrong password, and NETWORK when there is no connection", async () => {
    const wrong = (async () =>
      reply(401, { code: "INVALID_CREDENTIALS", message: "no" })) as unknown as typeof fetch;
    const store = memory();
    await expect(new Api(store, wrong).login("a@b.uz", "x")).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    expect(store.value).toBeNull();
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const error = await new Api(memory("T"), offline).me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("NETWORK");
  });

  it("signs out by forgetting the token", () => {
    const store = memory("T");
    new Api(store, (async () => reply(200, {})) as unknown as typeof fetch).signOut();
    expect(store.value).toBeNull();
  });
});
