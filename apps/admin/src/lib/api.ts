/**
 * The admin API (apps/api, /v1/admin). The session token lives in sessionStorage: it is gone when
 * the tab closes, and an expired or revoked one sends the admin back to the sign-in screen.
 */
import type {
  AccountAiInput,
  AccountBudgetInput,
  AccountDetail,
  AccountRow,
  AdminSession,
  AdminView,
  AiPoliciesView,
  AiPolicySaveInput,
  AiSettingsInput,
  AiSettingsView,
  AuditEntry,
  CostReport,
  CreateAdminInput,
  Overview,
  QueryTemplateInput,
  QueryTemplateView,
  TemplateCandidateView,
  SubscriptionStatus,
  UsageRow,
} from "@platform/shared";

const TOKEN_KEY = "platform-admin-token";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: the session lasts until reload */
  }
  for (const listener of listeners) listener();
}

const listeners = new Set<() => void>();
export function onTokenChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`/v1/admin${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const error = (data ?? {}) as { code?: string; message?: string };
    if (res.status === 401 && path !== "/login") setToken(null);
    throw new ApiError(res.status, error.code ?? `HTTP_${res.status}`, error.message ?? res.statusText);
  }
  return data as T;
}

export const api = {
  login: (email: string, password: string) => request<AdminSession>("POST", "/login", { email, password }),
  me: () => request<AdminView>("GET", "/me"),
  overview: () => request<Overview>("GET", "/overview"),
  accounts: (q: string, status: SubscriptionStatus | "") => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (status) params.set("status", status);
    return request<AccountRow[]>("GET", `/accounts?${params}`);
  },
  account: (id: string) => request<AccountDetail>("GET", `/accounts/${id}`),
  extend: (id: string, days: number, reason: string) =>
    request<AccountDetail>("POST", `/accounts/${id}/extend`, { days, reason }),
  recharge: (id: string, tokens: number, reason: string) =>
    request<AccountDetail>("POST", `/accounts/${id}/recharge`, { tokens, reason }),
  setAccountAi: (id: string, input: AccountAiInput) =>
    request<AccountDetail>("POST", `/accounts/${id}/ai`, input),
  aiSettings: () => request<AiSettingsView>("GET", "/ai-settings"),
  setAiSettings: (input: AiSettingsInput) => request<AiSettingsView>("POST", "/ai-settings", input),
  setBlocked: (id: string, blocked: boolean) =>
    request<AccountDetail>("POST", `/accounts/${id}/${blocked ? "block" : "unblock"}`),
  setDeviceRevoked: (id: string, revoked: boolean) =>
    request<AccountDetail>("POST", `/devices/${id}/${revoked ? "revoke" : "restore"}`),
  usage: (days: number) => request<UsageRow[]>("GET", `/usage?days=${days}`),
  aiCost: (days: number) => request<CostReport>("GET", `/ai-cost?days=${days}`),
  aiPolicies: () => request<AiPoliciesView>("GET", "/ai-policies"),
  saveAiPolicy: (input: AiPolicySaveInput) => request<AiPoliciesView>("PUT", "/ai-policies", input),
  setAccountBudget: (id: string, input: AccountBudgetInput) =>
    request<AccountDetail>("POST", `/accounts/${id}/ai-budget`, input),
  queryTemplates: () => request<QueryTemplateView[]>("GET", "/query-templates"),
  templateCandidates: () => request<TemplateCandidateView[]>("GET", "/template-candidates"),
  saveQueryTemplate: (input: QueryTemplateInput) =>
    request<QueryTemplateView>("PUT", "/query-templates", input),
  deleteQueryTemplate: (id: string) => request<null>("DELETE", `/query-templates/${id}`),
  audit: () => request<AuditEntry[]>("GET", "/audit"),
  admins: () => request<AdminView[]>("GET", "/admins"),
  createAdmin: (input: CreateAdminInput) => request<AdminView>("POST", "/admins", input),
  setAdminDisabled: (id: string, disabled: boolean) =>
    request<AdminView>("POST", `/admins/${id}/${disabled ? "disable" : "enable"}`),
};
