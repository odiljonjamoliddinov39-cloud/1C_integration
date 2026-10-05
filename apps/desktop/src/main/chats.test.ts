import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ChatStore, MAX_CHATS, type StoredChat } from "./chats.js";
import type { SecretBox } from "./store.js";

const secrets: SecretBox = {
  encrypt: (plain) => Buffer.from(plain).toString("base64").split("").reverse().join(""),
  decrypt: (enc) => Buffer.from(enc.split("").reverse().join(""), "base64").toString(),
};

function chat(companyId: string, title: string, updatedAt = new Date().toISOString()): StoredChat {
  return {
    id: randomUUID(),
    companyId,
    title,
    createdAt: updatedAt,
    updatedAt,
    messages: [{ role: "user", content: title }],
    entries: [{ kind: "user", text: title }],
  };
}

describe("chat store", () => {
  it("saves, lists newest first, loads and deletes chats, encrypted on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "chats-"));
    const store = new ChatStore(dir, secrets);
    const company = randomUUID();
    const first = chat(company, "5110 qoldig'i?");
    const second = chat(company, "Акт сверки с ООО Тест");
    store.save(first);
    store.save(second);
    expect(store.list(company).map((c) => c.title)).toEqual(["Акт сверки с ООО Тест", "5110 qoldig'i?"]);
    expect(store.load(company, first.id)).toEqual(first);

    // Saving an older chat again moves it to the top.
    store.save(first);
    expect(store.list(company).map((c) => c.id)).toEqual([first.id, second.id]);

    const files = readdirSync(join(dir, company));
    expect(files.sort()).toEqual(["chats.enc", `${first.id}.enc`, `${second.id}.enc`].sort());
    for (const file of files) expect(readFileSync(join(dir, company, file), "utf8")).not.toContain("qoldig");

    store.delete(company, first.id);
    expect(store.list(company).map((c) => c.id)).toEqual([second.id]);
    expect(store.load(company, first.id)).toBeNull();

    store.deleteCompany(company);
    expect(store.list(company)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("keeps the newest chats only", () => {
    const store = new ChatStore(mkdtempSync(join(tmpdir(), "chats-")), secrets);
    const company = randomUUID();
    const chats = Array.from({ length: MAX_CHATS + 2 }, (_, i) => chat(company, `q${i}`));
    for (const c of chats) store.save(c);
    expect(store.list(company)).toHaveLength(MAX_CHATS);
    expect(store.load(company, chats[0]!.id)).toBeNull();
    expect(store.load(company, chats[1]!.id)).toBeNull();
    expect(store.load(company, chats.at(-1)!.id)).not.toBeNull();
  });

  it("refuses ids that are not UUIDs, so no id points outside its folder", () => {
    const store = new ChatStore(mkdtempSync(join(tmpdir(), "chats-")), secrets);
    expect(() => store.load(randomUUID(), "../../platform")).toThrow("Bad chat id");
    expect(() => store.list("..")).toThrow("Bad company id");
  });

  it("treats a file it cannot decrypt as missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "chats-"));
    const company = randomUUID();
    const saved = chat(company, "x");
    new ChatStore(dir, secrets).save(saved);
    const otherUser: SecretBox = {
      encrypt: (p) => p,
      decrypt: () => {
        throw new Error("DPAPI: wrong user");
      },
    };
    expect(new ChatStore(dir, otherUser).load(company, saved.id)).toBeNull();
    expect(new ChatStore(dir, otherUser).list(company)).toEqual([]);
  });
});
