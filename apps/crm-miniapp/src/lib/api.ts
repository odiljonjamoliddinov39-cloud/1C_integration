/**
 * The Mini App's calls to the server. A person signs in with their own email and password and gets a session token for the working
 * day (good for the CRM only); it is kept on the phone, and when the server refuses it (a day passed, the person was disabled)
 * the app asks for the password again.
 */
import type {
  CallResult,
  CrmCallView,
  CrmLeadDetail,
  CrmLeadInput,
  CrmLeadRow,
  CrmLeadSaved,
  CrmLeadsResponse,
  CrmMe,
  CrmNoteView,
  CrmPipelineView,
  CrmSession,
} from "@platform/shared";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

/** Where the session token waits between visits (the phone's local storage; a test hands in its own). */
export interface TokenStore {
  get(): string | null;
  set(token: string | null): void;
}

const KEY = "crm-token";
export const browserStore: TokenStore = {
  get() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set(token) {
    try {
      if (token) localStorage.setItem(KEY, token);
      else localStorage.removeItem(KEY);
    } catch {
      // Not kept: the person signs in again next time.
    }
  },
};

export class Api {
  constructor(
    private readonly store: TokenStore = browserStore,
    private readonly http: Fetch = (...args) => fetch(...args),
  ) {}

  get signedIn(): boolean {
    return this.store.get() !== null;
  }

  signOut(): void {
    this.store.set(null);
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    const token = this.store.get();
    try {
      return await this.http(path, {
        ...init,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch {
      throw new ApiError("NETWORK", "No connection");
    }
  }

  private async fail(res: Response): Promise<never> {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new ApiError(body.code ?? "UNKNOWN", body.message ?? `HTTP ${res.status}`, res.status);
  }

  /** Signs in with the person's email and password; the token is kept. */
  async login(email: string, password: string): Promise<CrmSession> {
    const res = await this.send("/v1/crm/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email.trim(), password }),
    });
    if (!res.ok) return this.fail(res);
    const session = (await res.json()) as CrmSession;
    this.store.set(session.accessToken);
    return session;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.send(path, init);
    if (res.status === 401) {
      this.store.set(null);
      return this.fail(res);
    }
    if (!res.ok) return this.fail(res);
    return (await res.json()) as T;
  }

  private json<T>(method: string, path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** Replaces a one-time password with the person's own. */
  changePassword = (currentPassword: string, newPassword: string) =>
    this.json<unknown>("POST", "/v1/crm/password", { currentPassword, newPassword });
  me = () => this.request<CrmMe>("/v1/crm/me");
  funnel = () => this.request<CrmPipelineView>("/v1/crm/funnel");
  leads = (q: string, stageId: string, offset = 0) => {
    const params = new URLSearchParams({ limit: "40", offset: String(offset) });
    if (q.trim()) params.set("q", q.trim());
    if (stageId) params.set("stageId", stageId);
    return this.request<CrmLeadsResponse>(`/v1/crm/leads?${params}`);
  };
  lead = (id: string) => this.request<CrmLeadDetail>(`/v1/crm/leads/${id}`);
  addLead = (input: CrmLeadInput) => this.json<CrmLeadSaved>("POST", "/v1/crm/leads", input);
  moveLead = (id: string, stageId: string) =>
    this.json<CrmLeadRow>("POST", `/v1/crm/leads/${id}/stage`, { stageId });
  addNote = (id: string, text: string) =>
    this.json<CrmNoteView>("POST", `/v1/crm/leads/${id}/notes`, { text });
  addCall = (id: string, result: CallResult, durationSec?: number, note?: string) =>
    this.json<CrmCallView>("POST", `/v1/crm/leads/${id}/calls`, { result, durationSec, note });
}
