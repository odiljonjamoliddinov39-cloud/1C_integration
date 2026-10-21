/**
 * Local data of the desktop app. Phase 0 keeps companies in a JSON file in the user profile;
 * phase 1 moves them into SQLite (better-sqlite3) with the inbox and rules (TD §4, §10).
 * 1C passwords are never stored in plain text: they go through SecretBox (Electron safeStorage,
 * i.e. Windows DPAPI).
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type {
  AddCompanyInput,
  CompanyView,
  ConnectionInput,
  ConnectorStatus,
  InfobaseInput,
} from "../shared/ipc.js";
import { infobaseKey } from "./onec-jobs.js";

export interface SecretBox {
  encrypt(plain: string): string;
  decrypt(encrypted: string): string;
}

/** The most rules kept per company, and how long one can be. */
export const MAX_RULES = 40;
const MAX_RULE_CHARS = 400;

interface StoredCompany {
  id: string;
  backendCompanyId: string | null;
  name: string;
  inn: string;
  organizationRef: string;
  infobase: InfobaseInput;
  user: string;
  passwordEnc: string;
  extensionVersion: string | null;
  createdAt: string;
  lastStatus: ConnectorStatus | null;
  lastSyncAt: string | null;
  /** The AI assistant may read this company's 1C (TD §11: off by default, turned on with consent). */
  aiEnabled?: boolean;
  /** How this company reaches Didox (the API address and the E-IMZO key to sign in with). */
  didox?: { baseUrl: string; serialNumber: string };
  /** What the accountant decided about how this company is booked ("12% is written under the base's 15%"), kept for every chat. */
  rules?: string[];
  /** The accountant's decisions the program applies by itself when it writes documents from Didox. */
  bookkeeping?: Bookkeeping;
}

/** How lines are written: a VAT rate under another the base has, and the ledger accounts. */
export interface Bookkeeping {
  vatRateMap?: { from: number; to: number }[];
  accounts?: { goods?: string; service?: string };
  accountRules?: { match: string; account: string }[];
}

/** Signed-in state. The refresh token is encrypted; the license token is signed, not secret. */
export interface StoredSession {
  email: string;
  name: string;
  accountName: string;
  serverUrl: string;
  signedInAt: string;
  refreshTokenEnc: string;
  licenseToken: string | null;
  /** Public key that signs license tokens (baked into the build, or fetched at first sign-in). */
  publicKey: string;
  checkedAt: string;
}

interface StoreFile {
  version: 1;
  session: StoredSession | null;
  /** Used when the OS gives no machine id. */
  machineIdFallback?: string;
  companies: StoredCompany[];
}

export class StoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class LocalStore {
  private data: StoreFile;

  constructor(
    private readonly file: string,
    private readonly secrets: SecretBox,
  ) {
    this.data = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as StoreFile)
      : { version: 1, session: null, companies: [] };
  }

  // --- session ------------------------------------------------------------------------------------

  get session(): StoredSession | null {
    return this.data.session;
  }

  setSession(session: StoredSession | null): void {
    this.data.session = session;
    this.save();
  }

  encrypt(plain: string): string {
    return this.secrets.encrypt(plain);
  }

  decrypt(encrypted: string): string {
    return this.secrets.decrypt(encrypted);
  }

  machineIdFallback(create: () => string): string {
    if (!this.data.machineIdFallback) {
      this.data.machineIdFallback = create();
      this.save();
    }
    return this.data.machineIdFallback;
  }

  // --- companies --------------------------------------------------------------------------------

  listCompanies(): CompanyView[] {
    return this.data.companies.map(view);
  }

  addCompany(input: AddCompanyInput, status: ConnectorStatus): CompanyView {
    const key = infobaseKey(input.infobase);
    if (
      this.data.companies.some(
        (c) => infobaseKey(c.infobase) === key && c.organizationRef === input.organization.ref,
      )
    ) {
      throw new StoreError("DUPLICATE", "This organization of this infobase is already connected");
    }
    const company: StoredCompany = {
      id: randomUUID(),
      backendCompanyId: null,
      name: input.organization.name,
      inn: input.organization.inn,
      organizationRef: input.organization.ref,
      infobase: input.infobase,
      user: input.user,
      passwordEnc: this.secrets.encrypt(input.password),
      extensionVersion: status.ok ? status.ping.extensionVersion : null,
      createdAt: new Date().toISOString(),
      lastStatus: status,
      lastSyncAt: null,
    };
    this.data.companies.push(company);
    this.save();
    return view(company);
  }

  connection(id: string): ConnectionInput {
    const c = this.find(id);
    return { infobase: c.infobase, user: c.user, password: this.secrets.decrypt(c.passwordEnc) };
  }

  setStatus(id: string, status: ConnectorStatus): CompanyView {
    const c = this.find(id);
    c.lastStatus = status;
    if (status.ok) c.extensionVersion = status.ping.extensionVersion;
    this.save();
    return view(c);
  }

  setAiEnabled(id: string, enabled: boolean): CompanyView {
    const c = this.find(id);
    c.aiEnabled = enabled;
    this.save();
    return view(c);
  }

  bookkeeping(id: string): Bookkeeping {
    return structuredClone(this.find(id).bookkeeping ?? {});
  }

  /** Keeps what the accountant decided for how lines are written; a later decision on the same thing replaces the earlier. */
  mergeBookkeeping(id: string, add: Bookkeeping): Bookkeeping {
    const c = this.find(id);
    const held: Bookkeeping = c.bookkeeping ?? {};
    const vat = new Map((held.vatRateMap ?? []).map((m) => [m.from, m.to]));
    for (const m of add.vatRateMap ?? []) vat.set(m.from, m.to);
    const rules = new Map((held.accountRules ?? []).map((r) => [r.match.toLowerCase(), r]));
    for (const r of add.accountRules ?? []) rules.set(r.match.toLowerCase(), r);
    const accounts = { ...held.accounts, ...add.accounts };
    const next: Bookkeeping = {
      ...(vat.size ? { vatRateMap: [...vat].map(([from, to]) => ({ from, to })) } : {}),
      ...(Object.keys(accounts).length ? { accounts } : {}),
      ...(rules.size ? { accountRules: [...rules.values()].slice(-MAX_RULES) } : {}),
    };
    if (JSON.stringify(next) !== JSON.stringify(held)) {
      c.bookkeeping = next;
      this.save();
    }
    return structuredClone(next);
  }

  /** The accountant's rules for this company, in the order they were given. */
  rules(id: string): string[] {
    return [...(this.find(id).rules ?? [])];
  }

  /** Keeps a rule (a short sentence); the same one twice is kept once. Returns the rules now held. */
  addRule(id: string, rule: string): string[] {
    const c = this.find(id);
    const text = rule.trim().replace(/\s+/g, " ").slice(0, MAX_RULE_CHARS);
    const held = c.rules ?? [];
    if (text && !held.some((r) => r.toLowerCase() === text.toLowerCase())) {
      // The oldest goes when there are too many: the newest decision is the one the accountant just made.
      c.rules = [...held, text].slice(-MAX_RULES);
      this.save();
    }
    return [...(c.rules ?? [])];
  }

  /** Forgets the rule with this number (1 is the first), or the one that has these words. */
  removeRule(id: string, which: number | string): string[] {
    const c = this.find(id);
    const held = c.rules ?? [];
    const at =
      typeof which === "number"
        ? which - 1
        : held.findIndex((r) => r.toLowerCase().includes(which.trim().toLowerCase()));
    if (at >= 0 && at < held.length) {
      c.rules = held.filter((_, i) => i !== at);
      if (c.rules.length === 0) delete c.rules;
      this.save();
    }
    return [...(c.rules ?? [])];
  }

  setDidox(id: string, didox: { baseUrl: string; serialNumber: string } | null): CompanyView {
    const c = this.find(id);
    if (didox) c.didox = didox;
    else delete c.didox;
    this.save();
    return view(c);
  }

  company(id: string): CompanyView {
    return view(this.find(id));
  }

  removeCompany(id: string): void {
    this.data.companies = this.data.companies.filter((c) => c.id !== id);
    this.save();
  }

  private find(id: string): StoredCompany {
    const c = this.data.companies.find((x) => x.id === id);
    if (!c) throw new StoreError("NOT_FOUND", "Company not found");
    return c;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file); // never leave a half-written file
  }
}

function view(c: StoredCompany): CompanyView {
  return {
    id: c.id,
    name: c.name,
    inn: c.inn,
    infobase: c.infobase,
    user: c.user,
    createdAt: c.createdAt,
    lastStatus: c.lastStatus,
    lastSyncAt: c.lastSyncAt,
    aiEnabled: c.aiEnabled ?? false,
    didox: c.didox ?? null,
  };
}
