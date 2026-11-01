/**
 * The admin API (apps/api, /v1/admin). The session token lives in sessionStorage: it is gone when
 * the tab closes, and an expired or revoked one sends the admin back to the sign-in screen.
 */
import type {
  AddonSaveInput,
  AdminAccountCredits,
  AdminCreditAdjustInput,
  AdminCreditRateInput,
  AdminCreditDecisionInput,
  AdminCreditRequestsResponse,
  AdminCreditsReport,
  AdminRestartPaymentsResult,
  AdminBillingDetail,
  AdminPlansView,
  AdminSubscriptionRow,
  PlanSaveInput,
  PromoInput,
  PromoView,
  RevenueReport,
  SubscriptionActionInput,
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
  CreatedAdmin,
  CrmCallInput,
  CrmCallView,
  CrmImportFileInput,
  CrmImportJobView,
  CrmLeadDetail,
  CrmLeadInput,
  CrmLeadRow,
  CrmLeadSaved,
  CrmLeadUpdate,
  CrmLeadsQuery,
  CrmLeadsResponse,
  CrmManagerView,
  CrmNoteView,
  CrmPipelineView,
  CrmReport,
  CrmStageInput,
  CrmStageUpdate,
  Overview,
  QueryTemplateInput,
  QueryTemplateView,
  TemplateGroupView,
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
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  base = "/v1/admin",
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const error = (data ?? {}) as { code?: string; message?: string };
    if (res.status === 401 && path !== "/login" && !path.endsWith("/password")) setToken(null);
    throw new ApiError(res.status, error.code ?? `HTTP_${res.status}`, error.message ?? res.statusText);
  }
  return data as T;
}

const crm = <T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown) =>
  request<T>(method, path, body, "/v1/crm");

/** Fetches a file (an .xlsx export) with the session's token and hands it to the browser as a download. */
export async function downloadFile(path: string, fileName: string): Promise<void> {
  const token = getToken();
  const res = await fetch(`/v1/crm${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new ApiError(res.status, error.code ?? `HTTP_${res.status}`, error.message ?? res.statusText);
  }
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The query string of the lead filters (also used for the export). */
export function leadParams(query: Partial<CrmLeadsQuery>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== "") params.set(key, String(value));
  return params.toString();
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
  templateGroups: () => request<TemplateGroupView[]>("GET", "/template-groups"),
  /** Runs the engine's reasoning now, for every account. */
  runEngine: () => request<{ decided: number; made: number }>("POST", "/engine/run"),
  saveQueryTemplate: (input: QueryTemplateInput) =>
    request<QueryTemplateView>("PUT", "/query-templates", input),
  deleteQueryTemplate: (id: string) => request<null>("DELETE", `/query-templates/${id}`),
  audit: () => request<AuditEntry[]>("GET", "/audit"),
  creditsReport: () => request<AdminCreditsReport>("GET", "/credits"),
  accountCredits: (id: string) => request<AdminAccountCredits>("GET", `/credits/by-account/${id}`),
  adjustCredits: (id: string, input: AdminCreditAdjustInput) =>
    request<{ balanceCredits: number }>("POST", `/credits/${id}/adjust`, input),
  creditRequests: () => request<AdminCreditRequestsResponse>("GET", "/credits/requests"),
  approveCreditRequest: (id: string, input: AdminCreditDecisionInput) =>
    request<AdminCreditRequestsResponse>("POST", `/credits/requests/${id}/approve`, input),
  rejectCreditRequest: (id: string, input: AdminCreditDecisionInput) =>
    request<AdminCreditRequestsResponse>("POST", `/credits/requests/${id}/reject`, input),
  restartPayments: (id: string) =>
    request<AdminRestartPaymentsResult>("POST", `/credits/${id}/restart-payments`),
  setCreditRate: (input: AdminCreditRateInput) => request<AdminCreditsReport>("POST", "/credits/rate", input),
  billingPlans: () => request<AdminPlansView>("GET", "/billing/plans"),
  savePlan: (code: string, input: PlanSaveInput) => request<AdminPlansView>("PUT", `/plans/${code}`, input),
  saveAddon: (code: string, input: AddonSaveInput) =>
    request<AdminPlansView>("PUT", `/addons/${code}`, input),
  subscriptions: (q: string, plan: string, status: string) => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (plan) params.set("plan", plan);
    if (status) params.set("status", status);
    return request<AdminSubscriptionRow[]>("GET", `/subscriptions?${params}`);
  },
  billingDetail: (accountId: string) =>
    request<AdminBillingDetail>("GET", `/subscriptions/by-account/${accountId}`),
  subscriptionAction: (subscriptionId: string, input: Partial<SubscriptionActionInput>) =>
    request<AdminBillingDetail>("POST", `/subscriptions/${subscriptionId}/extend`, input),
  revenue: () => request<RevenueReport>("GET", "/revenue"),
  promoCodes: () => request<PromoView[]>("GET", "/promo-codes"),
  createPromo: (input: Partial<PromoInput>) => request<PromoView[]>("POST", "/promo-codes", input),
  setPromoDisabled: (code: string, disabled: boolean) =>
    request<PromoView[]>("POST", `/promo-codes/${code}/${disabled ? "disable" : "enable"}`),
  admins: () => request<AdminView[]>("GET", "/admins"),
  createAdmin: (input: CreateAdminInput) => request<CreatedAdmin>("POST", "/admins", input),
  setAdminTelegram: (id: string, telegramId: string | null) =>
    request<AdminView>("POST", `/admins/${id}/telegram`, { telegramId }),
  resetAdminPassword: (id: string) =>
    request<{ tempPassword: string }>("POST", `/admins/${id}/reset-password`),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<AdminView>("POST", "/password", { currentPassword, newPassword }),

  // --- CRM ---
  crmFunnel: () => crm<CrmPipelineView>("GET", "/funnel"),
  crmAddStage: (input: Partial<CrmStageInput>) => crm<CrmPipelineView>("POST", "/stages", input),
  crmUpdateStage: (id: string, input: CrmStageUpdate) =>
    crm<CrmPipelineView>("PATCH", `/stages/${id}`, input),
  crmReorderStages: (ids: string[]) => crm<CrmPipelineView>("PUT", "/stages/order", { ids }),
  crmDeleteStage: (id: string, moveTo?: string) =>
    crm<CrmPipelineView>("DELETE", `/stages/${id}${moveTo ? `?moveTo=${moveTo}` : ""}`),
  crmLeads: (query: Partial<CrmLeadsQuery>) => crm<CrmLeadsResponse>("GET", `/leads?${leadParams(query)}`),
  crmLead: (id: string) => crm<CrmLeadDetail>("GET", `/leads/${id}`),
  crmAddLead: (input: CrmLeadInput) => crm<CrmLeadSaved>("POST", "/leads", input),
  crmUpdateLead: (id: string, input: CrmLeadUpdate) => crm<CrmLeadRow>("PATCH", `/leads/${id}`, input),
  crmMoveLead: (id: string, stageId: string) => crm<CrmLeadRow>("POST", `/leads/${id}/stage`, { stageId }),
  crmAddNote: (id: string, text: string) => crm<CrmNoteView>("POST", `/leads/${id}/notes`, { text }),
  crmAddCall: (id: string, input: CrmCallInput) => crm<CrmCallView>("POST", `/leads/${id}/calls`, input),
  crmTeam: () => crm<CrmManagerView[]>("GET", "/team"),
  crmSources: () => crm<string[]>("GET", "/sources"),
  crmImportJobs: () => crm<CrmImportJobView[]>("GET", "/import/jobs"),
  crmImportFile: (input: CrmImportFileInput) => crm<CrmImportJobView>("POST", "/import/file", input),
  crmImportSheet: (url: string) => crm<CrmImportJobView>("POST", "/import/sheet", { url }),
  crmGoogle: () => crm<{ enabled: boolean; serviceEmail: string | null }>("GET", "/import/google"),
  crmReport: (from: string, to: string) =>
    crm<CrmReport>("GET", `/reports?${leadParams({ from, to } as Partial<CrmLeadsQuery>)}`),
  setAdminDisabled: (id: string, disabled: boolean) =>
    request<AdminView>("POST", `/admins/${id}/${disabled ? "disable" : "enable"}`),
};
