import { describe, expect, it } from "vitest";

import { DidoxClient, DidoxError } from "./client.js";
import { FakeDidox, FakeSigner } from "./fake.js";

function setup() {
  const server = new FakeDidox();
  const signer = new FakeSigner();
  const client = new DidoxClient(
    { baseUrl: "https://didox.test/", apiKey: "partner-key", fetch: server.fetch },
    signer,
  );
  return { server, signer, client };
}

describe("DidoxClient", () => {
  it("signs in with the key: authId for its serial number, the authId signed, the token kept", async () => {
    const { server, signer, client } = setup();
    await client.login();
    expect(client.signedIn).toBe(true);
    expect(server.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "GET /v1/auth/authId/5A3C0F",
      "POST /v1/auth/login",
    ]);
    expect(signer.signed).toEqual([JSON.stringify({ authId: "auth-5A3C0F" })]);
    expect(server.requests[1]?.body).toEqual({
      serialNumber: "5A3C0F",
      pkcs7: Buffer.from(`PKCS7:${JSON.stringify({ authId: "auth-5A3C0F" })}`).toString("base64"),
    });
    // The sign-in itself carries no token.
    expect(server.requests[0]?.headers["user-key"]).toBeUndefined();
    expect(server.requests[0]?.headers["api-key"]).toBe("partner-key");
  });

  it("signs in by itself on the first request, and lists documents with the filters as query", async () => {
    const { server, client } = setup();
    server.documents = [
      { id: "a", doctype: "001", status: 2, owner: 0 },
      { id: "b", doctype: "005", status: 3, owner: 0 },
      { id: "c", doctype: "001", status: 1, owner: 1 },
    ];
    const list = await client.listDocuments({
      owner: 0,
      doctype: "001,002",
      limit: 5,
      dateFrom: "2026-10-01",
    });
    expect(list).toEqual([{ id: "a", doctype: "001", status: 2, owner: 0 }]);
    const request = server.requests.at(-1);
    expect(request?.url.search).toBe("?owner=0&doctype=001%2C002&limit=5&dateFrom=2026-10-01");
    expect(request?.headers["user-key"]).toBe("token-1");
  });

  it("renews a token that lapsed early, once, and goes on", async () => {
    const { server, client } = setup();
    server.documents = [{ id: "a", doctype: "001", status: 2, owner: 0 }];
    await client.listDocuments();
    server.expireTokens();
    await expect(client.listDocuments()).resolves.toHaveLength(1);
    expect(server.requests.filter((r) => r.url.pathname === "/v1/auth/login")).toHaveLength(2);
  });

  it("downloads a document's archive from the link, without sending our keys to the link", async () => {
    const { server, client } = setup();
    server.archives.set("doc-1", new Uint8Array([0x50, 0x4b, 3, 4]));
    const bytes = await client.downloadArchive("doc-1");
    expect([...bytes]).toEqual([0x50, 0x4b, 3, 4]);
    const file = server.requests.at(-1);
    expect(file?.url.host).toBe("files.didox.test");
    expect(file?.headers["user-key"]).toBeUndefined();
    expect(file?.headers["api-key"]).toBeUndefined();
  });

  it("says what failed, in codes", async () => {
    const { client } = setup();
    await expect(client.documentInfo("missing")).rejects.toMatchObject({ code: "DIDOX_HTTP", status: 404 });
    const noKey = new DidoxClient({ fetch: new FakeDidox().fetch });
    await expect(noKey.profile()).rejects.toMatchObject({ code: "DIDOX_AUTH" });
    const offline = new DidoxClient({
      fetch: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
    });
    offline.setToken("t", Date.now() + 3_600_000);
    const error = await offline.profile().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DidoxError);
    expect(error).toMatchObject({ code: "DIDOX_NETWORK" });
  });
});
