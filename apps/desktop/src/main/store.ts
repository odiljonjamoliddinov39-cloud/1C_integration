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
  Session,
} from "../shared/ipc.js";
import { infobaseKey } from "./onec-jobs.js";

export interface SecretBox {
  encrypt(plain: string): string;
  decrypt(encrypted: string): string;
}

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
}

interface StoreFile {
  version: 1;
  session: Session | null;
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

  // --- session (stub until the control system exists) ------------------------------------------

  get session(): Session | null {
    return this.data.session;
  }

  setSession(session: Session | null): void {
    this.data.session = session;
    this.save();
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
  };
}
