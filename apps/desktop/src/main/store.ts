/**
 * Local data of the desktop app. Phase 0 keeps companies in a JSON file in the user profile;
 * phase 1 moves them into SQLite (better-sqlite3) with the inbox and rules (TD §4, §10).
 * 1C passwords are never stored in plain text: they go through SecretBox (Electron safeStorage,
 * i.e. Windows DPAPI).
 */
import { MAX_CORRECTIONS, MAX_OPERATIONS, type Correction, type Operation } from "./engine/journal.js";
import type { PostingRule } from "./engine/posting-rules.js";
import { type GtdRecord, remember } from "./gtd/registry.js";
import type { TaxProfile } from "./engine/tax-tables.js";
import type { BankLineType } from "@platform/shared";
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
  /** The engine's own data for this company (see engine/): tax profile, posting rules, journal of operations. */
  engine?: EngineData;
  /** The customs declarations (GTD) the program has read for this company: a later release links to them. */
  gtd?: GtdRecord[];
}

/** A row of the table of bank statement lines by counterparty account that the accountant confirmed or changed. */
export interface BankMapping {
  prefix: string;
  type: BankLineType;
  account?: string;
  updatedAt: string;
}

/** A document the program wrote from a bank statement: what it was read as, and whether it has been taken back. */
export interface BankWrite {
  ref: string;
  object: string;
  presentation: string;
  /** Which card it was written on, and its place in the order of writing. */
  runId: string;
  seq: number;
  file: string;
  row: number;
  /** What the line was read as and by which rule (see bank/classify.ts). */
  rule: string;
  /** The conversion a document is a leg of: all its legs go together. */
  conversionId?: string;
  createdAt: string;
  reversedAt?: string;
}

export interface EngineData {
  /** The log of what was written from bank statements, so that each write can be taken back (see propose_undo_bank). */
  bankWrites?: BankWrite[];
  taxProfile?: TaxProfile;
  postingRules?: PostingRule[];
  /** The accountant's confirmed rows of the table of statement lines by counterparty account (see bank/classify.ts). */
  bankMappings?: BankMapping[];
  operations?: Operation[];
  corrections?: Correction[];
  /** The cost method of the company's stock (the accountant's decision; the program never chooses it). */
  stockCostMethod?: "average" | "fifo";
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

  taxProfile(id: string): TaxProfile | null {
    const p = this.find(id).engine?.taxProfile;
    return p ? structuredClone(p) : null;
  }

  /** Keeps the company's tax profile (filled once, changed with a date). */
  setTaxProfile(id: string, profile: TaxProfile): void {
    const c = this.find(id);
    c.engine = { ...c.engine, taxProfile: structuredClone(profile) };
    this.save();
  }

  organizationRef(id: string): string {
    return this.find(id).organizationRef;
  }

  stockCostMethod(id: string): "average" | "fifo" | null {
    return this.find(id).engine?.stockCostMethod ?? null;
  }

  setStockCostMethod(id: string, method: "average" | "fifo"): void {
    const c = this.find(id);
    c.engine = { ...c.engine, stockCostMethod: method };
    this.save();
  }

  postingRules(id: string): PostingRule[] {
    return structuredClone(this.find(id).engine?.postingRules ?? []);
  }

  bankWrites(id: string): BankWrite[] {
    return structuredClone(this.find(id).engine?.bankWrites ?? []);
  }

  addBankWrites(id: string, list: BankWrite[]): void {
    const c = this.find(id);
    c.engine = {
      ...c.engine,
      bankWrites: [...(c.engine?.bankWrites ?? []), ...structuredClone(list)].slice(-5000),
    };
    this.save();
  }

  markBankReversed(id: string, refs: string[], now: Date = new Date()): void {
    const c = this.find(id);
    const taken = new Set(refs);
    c.engine = {
      ...c.engine,
      bankWrites: (c.engine?.bankWrites ?? []).map((w) =>
        taken.has(w.ref) && !w.reversedAt ? { ...w, reversedAt: now.toISOString() } : w,
      ),
    };
    this.save();
  }

  bankMappings(id: string): BankMapping[] {
    return structuredClone(this.find(id).engine?.bankMappings ?? []);
  }

  /** Keeps rows the accountant confirmed; a row of the same prefix replaces the earlier one. */
  saveBankMappings(
    id: string,
    rows: Omit<BankMapping, "updatedAt">[],
    now: Date = new Date(),
  ): BankMapping[] {
    const c = this.find(id);
    const prefixes = new Set(rows.map((r) => r.prefix));
    const held = (c.engine?.bankMappings ?? []).filter((r) => !prefixes.has(r.prefix));
    const stamped = rows.map((r) => ({ ...r, updatedAt: now.toISOString() }));
    c.engine = { ...c.engine, bankMappings: [...held, ...stamped].slice(-200) };
    this.save();
    return structuredClone(c.engine.bankMappings ?? []);
  }

  /** Keeps a rule the accountant decided; the same id replaces the earlier one. */
  addPostingRule(id: string, rule: PostingRule): PostingRule[] {
    const c = this.find(id);
    const held = (c.engine?.postingRules ?? []).filter((r) => r.id !== rule.id);
    c.engine = { ...c.engine, postingRules: [...held, structuredClone(rule)].slice(-MAX_RULES) };
    this.save();
    return structuredClone(c.engine.postingRules ?? []);
  }

  /** The newest operations first. */
  operations(id: string, limit = 20): Operation[] {
    return structuredClone([...(this.find(id).engine?.operations ?? [])].reverse().slice(0, limit));
  }

  addOperation(id: string, op: Operation): void {
    const c = this.find(id);
    c.engine = {
      ...c.engine,
      operations: [...(c.engine?.operations ?? []), structuredClone(op)].slice(-MAX_OPERATIONS),
    };
    this.save();
  }

  addCorrection(id: string, correction: Correction): void {
    const c = this.find(id);
    c.engine = {
      ...c.engine,
      corrections: [...(c.engine?.corrections ?? []), structuredClone(correction)].slice(-MAX_CORRECTIONS),
    };
    this.save();
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

  /** The customs declarations read for this company, oldest first. */
  gtdDeclarations(id: string): GtdRecord[] {
    return [...(this.find(id).gtd ?? [])];
  }

  /** Keeps what was read of a declaration (the same number twice: the later reading). */
  rememberGtd(id: string, record: GtdRecord): void {
    const c = this.find(id);
    c.gtd = remember(c.gtd ?? [], record);
    this.save();
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
