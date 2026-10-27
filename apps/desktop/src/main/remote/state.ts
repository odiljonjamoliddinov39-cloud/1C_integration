/**
 * What the PC keeps for the remote control (a JSON file beside the app's other data): the device
 * token, the switches, the PIN, `remote_inbox` (the ids already run, with their answers, so a
 * delivery that arrives twice runs once) and a short journal of what was asked from the phone.
 * Answers may hold amounts and names, so they are sealed like the 1C passwords are.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { RemoteCeiling, RemoteClass, WsResult } from "@platform/shared";

import type { SecretBox } from "../store.js";

/** Ids kept in remote_inbox; the oldest go first. The server is also told the newest of these at each hello. */
export const INBOX_MAX = 1000;
const INBOX_KEEP_MS = 48 * 3_600_000;
export const JOURNAL_MAX = 200;
/** Wrong PINs in a row that lock Apply, and for how long. */
export const PIN_TRIES = 5;
export const PIN_LOCK_MS = 15 * 60_000;

interface InboxRow {
  id: string;
  at: number;
  /** `started` until the answer is kept: after a crash, a started Read runs again, a started write is failed. */
  state: "started" | "done";
  /** The answer, sealed, once done: sent again if the first send was lost. */
  resultEnc?: string;
  /** The server has it: it need not be sent again. */
  delivered?: boolean;
}

export interface JournalRow {
  at: string;
  id: string;
  type: string;
  class: RemoteClass;
  companyInn: string;
  telegramUser: string;
  status: "done" | "failed" | "refused" | "expired";
  /** The error code when it did not run; never content. */
  code?: string;
}

interface Data {
  version: 1;
  device?: { id: string; tokenEnc: string; serverUrl: string };
  /** The kill switch: off, the PC is not connected and nothing runs. */
  enabled: boolean;
  /** The highest class a phone may do on this PC, whatever the server says. */
  ceiling: RemoteCeiling;
  pin?: { salt: string; hash: string };
  pinFailures: number;
  pinLockedUntil: number;
  inbox: InboxRow[];
  journal: JournalRow[];
}

const hashPin = (pin: string, salt: string) => scryptSync(pin, Buffer.from(salt, "hex"), 32).toString("hex");

export class RemoteState {
  private data: Data = {
    version: 1,
    enabled: true,
    // Apply is allowed by default because the PIN gates it: with no PIN set on the PC, an Apply is refused.
    ceiling: "apply",
    pinFailures: 0,
    pinLockedUntil: 0,
    inbox: [],
    journal: [],
  };

  constructor(
    private readonly file: string,
    private readonly secrets: SecretBox,
    private readonly now: () => number = Date.now,
  ) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Data>;
        this.data = { ...this.data, ...parsed, version: 1 };
      } catch {
        // A damaged file starts over: the server re-sends whatever it never got answered.
      }
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
  }

  // ---- the device ----

  device(): { id: string; token: string; serverUrl: string } | null {
    const d = this.data.device;
    if (!d) return null;
    try {
      return { id: d.id, token: this.secrets.decrypt(d.tokenEnc), serverUrl: d.serverUrl };
    } catch {
      return null;
    }
  }

  setDevice(device: { id: string; token: string; serverUrl: string }): void {
    this.data.device = {
      id: device.id,
      tokenEnc: this.secrets.encrypt(device.token),
      serverUrl: device.serverUrl,
    };
    this.save();
  }

  forgetDevice(): void {
    delete this.data.device;
    this.save();
  }

  // ---- switches ----

  get enabled(): boolean {
    return this.data.enabled;
  }
  setEnabled(enabled: boolean): void {
    this.data.enabled = enabled;
    this.save();
  }

  get ceiling(): RemoteCeiling {
    return this.data.ceiling;
  }
  setCeiling(ceiling: RemoteCeiling): void {
    this.data.ceiling = ceiling;
    this.save();
  }

  // ---- the PIN that confirms writes ----

  get hasPin(): boolean {
    return Boolean(this.data.pin);
  }

  setPin(pin: string): void {
    const salt = randomBytes(16).toString("hex");
    this.data.pin = { salt, hash: hashPin(pin, salt) };
    this.data.pinFailures = 0;
    this.data.pinLockedUntil = 0;
    this.save();
  }

  clearPin(): void {
    delete this.data.pin;
    this.save();
  }

  /** "ok"; "wrong" (counts against the tries); "locked" (too many wrong ones, wait); "unset" (no PIN on this PC). */
  checkPin(pin: string | undefined): "ok" | "wrong" | "locked" | "unset" {
    const stored = this.data.pin;
    if (!stored) return "unset";
    if (this.now() < this.data.pinLockedUntil) return "locked";
    const ok =
      pin !== undefined &&
      timingSafeEqual(Buffer.from(hashPin(pin, stored.salt), "hex"), Buffer.from(stored.hash, "hex"));
    if (ok) {
      if (this.data.pinFailures > 0) {
        this.data.pinFailures = 0;
        this.save();
      }
      return "ok";
    }
    this.data.pinFailures += 1;
    if (this.data.pinFailures >= PIN_TRIES) {
      this.data.pinFailures = 0;
      this.data.pinLockedUntil = this.now() + PIN_LOCK_MS;
    }
    this.save();
    return this.data.pinLockedUntil > this.now() ? "locked" : "wrong";
  }

  // ---- remote_inbox ----

  private row(id: string): InboxRow | undefined {
    return this.data.inbox.find((r) => r.id === id);
  }

  /** What the inbox knows of a command: never seen, started and not finished, or done (with its answer). */
  seen(id: string): { state: "new" } | { state: "started" } | { state: "done"; result: WsResult } {
    const r = this.row(id);
    if (!r) return { state: "new" };
    if (r.state === "started" || !r.resultEnc) return { state: "started" };
    return { state: "done", result: JSON.parse(this.secrets.decrypt(r.resultEnc)) as WsResult };
  }

  start(id: string): void {
    const existing = this.row(id);
    if (existing) {
      existing.state = "started";
      existing.at = this.now();
    } else {
      this.data.inbox.push({ id, at: this.now(), state: "started" });
    }
    this.prune();
    this.save();
  }

  finish(id: string, result: WsResult): void {
    const r = this.row(id) ?? { id, at: this.now(), state: "started" as const };
    if (!this.row(id)) this.data.inbox.push(r);
    r.state = "done";
    r.at = this.now();
    r.resultEnc = this.secrets.encrypt(JSON.stringify(result));
    r.delivered = false;
    this.prune();
    this.save();
  }

  /** The server took the answer: it is not sent again, though the id stays so a repeat delivery is not run. */
  delivered(id: string): void {
    const r = this.row(id);
    if (!r) return;
    r.delivered = true;
    this.save();
  }

  /** Answers the server may not have: sent again at the next connection. */
  undelivered(): WsResult[] {
    return this.data.inbox
      .filter((r) => r.state === "done" && r.resultEnc && !r.delivered)
      .map((r) => JSON.parse(this.secrets.decrypt(r.resultEnc as string)) as WsResult);
  }

  /** Ids already run: sent in hello, so the server does not deliver them again. */
  doneIds(): string[] {
    return this.data.inbox
      .filter((r) => r.state === "done")
      .slice(-INBOX_MAX)
      .map((r) => r.id);
  }

  private prune(): void {
    const cutoff = this.now() - INBOX_KEEP_MS;
    this.data.inbox = this.data.inbox
      .filter((r) => r.at >= cutoff || r.state === "started")
      .slice(-INBOX_MAX);
  }

  // ---- the journal ----

  log(row: Omit<JournalRow, "at">): void {
    this.data.journal.push({ at: new Date(this.now()).toISOString(), ...row });
    if (this.data.journal.length > JOURNAL_MAX)
      this.data.journal.splice(0, this.data.journal.length - JOURNAL_MAX);
    this.save();
  }

  journal(): JournalRow[] {
    return [...this.data.journal].reverse();
  }
}

/** sha256 hex of a string. */
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
