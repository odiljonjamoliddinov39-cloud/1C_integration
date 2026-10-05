/**
 * Saved assistant chats, on this PC only. One encrypted file per chat (what the model saw, and
 * what the window showed) plus an encrypted list per company, in the user profile. They hold the
 * company's figures and the attached files, so they go through SecretBox like the 1C passwords.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AiMessage } from "@platform/shared";

import type { ChatSummary } from "../shared/ipc.js";
import type { ChatEntry } from "../shared/transcript.js";
import type { SecretBox } from "./store.js";

/** Older chats beyond this many per company are deleted. */
export const MAX_CHATS = 200;

export interface StoredChat extends ChatSummary {
  companyId: string;
  /** The conversation as the model sees it, sent back every turn. */
  messages: AiMessage[];
  entries: ChatEntry[];
}

// Ids become file names: only UUIDs, so no id can point outside the chats folder.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ChatStore {
  constructor(
    private readonly dir: string,
    private readonly secrets: SecretBox,
  ) {}

  list(companyId: string): ChatSummary[] {
    return this.read<ChatSummary[]>(this.indexFile(companyId)) ?? [];
  }

  load(companyId: string, chatId: string): StoredChat | null {
    return this.read<StoredChat>(this.chatFile(companyId, chatId));
  }

  save(chat: StoredChat): void {
    this.write(this.chatFile(chat.companyId, chat.id), chat);
    const summary: ChatSummary = {
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    };
    const list = [summary, ...this.list(chat.companyId).filter((c) => c.id !== chat.id)];
    for (const old of list.splice(MAX_CHATS)) rmSync(this.chatFile(chat.companyId, old.id), { force: true });
    this.write(this.indexFile(chat.companyId), list);
  }

  delete(companyId: string, chatId: string): void {
    const file = this.chatFile(companyId, chatId);
    this.write(
      this.indexFile(companyId),
      this.list(companyId).filter((c) => c.id !== chatId),
    );
    rmSync(file, { force: true });
  }

  /** All chats of a company, when the company is removed from the app. */
  deleteCompany(companyId: string): void {
    rmSync(this.companyDir(companyId), { recursive: true, force: true });
  }

  private companyDir(companyId: string): string {
    if (!UUID.test(companyId)) throw new Error("Bad company id");
    return join(this.dir, companyId.toLowerCase());
  }

  private indexFile(companyId: string): string {
    return join(this.companyDir(companyId), "chats.enc");
  }

  private chatFile(companyId: string, chatId: string): string {
    if (!UUID.test(chatId)) throw new Error("Bad chat id");
    return join(this.companyDir(companyId), `${chatId.toLowerCase()}.enc`);
  }

  private read<T>(file: string): T | null {
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(this.secrets.decrypt(readFileSync(file, "utf8"))) as T;
    } catch {
      return null; // written by another Windows user, or damaged: as if it were not there
    }
  }

  private write(file: string, value: unknown): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, this.secrets.encrypt(JSON.stringify(value)));
    renameSync(tmp, file); // never leave a half-written file
  }
}
