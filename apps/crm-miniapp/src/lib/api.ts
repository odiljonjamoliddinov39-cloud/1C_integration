/**
 * The Mini App's calls to the server. The page proves who it is once, with Telegram's signed initData, and gets a session token for
 * the working day; if the token is refused (a restart, a day passed) it asks again with the same initData.
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

export class Api {
  private token: string | null = null;

  constructor(
    private readonly initData: () => string,
    private readonly http: Fetch = (...args) => fetch(...args),
  ) {}

  private async send(path: string, init: RequestInit, auth: string): Promise<Response> {
    try {
      return await this.http(path, {
        ...init,
        headers: { authorization: auth, ...(init.headers as Record<string, string> | undefined) },
      });
    } catch {
      throw new ApiError("NETWORK", "No connection");
    }
  }

  private async fail(res: Response): Promise<never> {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new ApiError(body.code ?? "UNKNOWN", body.message ?? `HTTP ${res.status}`, res.status);
  }

  /** Trades Telegram's initData for a session token. */
  async session(): Promise<CrmMe> {
    const res = await this.send("/v1/crm/session", { method: "POST" }, `tma ${this.initData()}`);
    if (!res.ok) return this.fail(res);
    const body = (await res.json()) as { accessToken: string; me: CrmMe };
    this.token = body.accessToken;
    return body.me;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.token) await this.session();
    let res = await this.send(path, init, `Bearer ${this.token}`);
    if (res.status === 401) {
      await this.session();
      res = await this.send(path, init, `Bearer ${this.token}`);
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
