import type { BootstrapPayload, BrowserSession, CrmErrorBody, CrmTask, ListPayload } from "./types";

export class CrmApiError extends Error {
  status: number;
  body: CrmErrorBody;

  constructor(status: number, body: CrmErrorBody = {}) {
    super(body.message || body.message_key || body.code || `HTTP ${status}`);
    this.name = "CrmApiError";
    this.status = status;
    this.body = body;
  }
}

function safeSessionValue(key: string) {
  try {
    return window.sessionStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeSessionValue(key: string, value: string) {
  try { window.sessionStorage.setItem(key, value); } catch { /* storage may be disabled */ }
}

function removeSessionValue(key: string) {
  try { window.sessionStorage.removeItem(key); } catch { /* storage may be disabled */ }
}

export function adminWorkspaceContext() {
  const params = new URLSearchParams(window.location.search);
  const adminMeta = document.querySelector<HTMLMetaElement>('meta[name="admin-console-session"]')?.content;
  const workspaceMeta = document.querySelector<HTMLMetaElement>('meta[name="admin-workspace-user-id"]')?.content || "";
  const isAdmin = adminMeta === "1" || params.get("admin_console") === "1" || safeSessionValue("vecto-admin-console-context") === "1";
  const workspaceId = [
    workspaceMeta,
    params.get("admin_workspace_user_id") || "",
    params.get("manage_user_id") || "",
    safeSessionValue("vecto-admin-workspace-user-id"),
  ].find((value) => /^\d+$/.test(String(value).trim())) || "";
  return { isAdmin, workspaceId: String(workspaceId) };
}

function requestHeaders(body?: unknown) {
  const headers = new Headers({ Accept: "application/json" });
  if (body !== undefined && !(body instanceof FormData)) headers.set("Content-Type", "application/json");
  const { isAdmin, workspaceId } = adminWorkspaceContext();
  if (isAdmin) headers.set("X-Admin-Console", "1");
  if (isAdmin && workspaceId) headers.set("X-Admin-Workspace-User-ID", workspaceId);
  return headers;
}

function loginRedirect() {
  const returnUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const query = new URLSearchParams({ login: "1", return_url: returnUrl });
  window.location.assign(`/?${query}`);
}

type CrmRequestInit = Omit<RequestInit, "body"> & { body?: BodyInit | Record<string, unknown> };

export async function request<T>(path: string, init: CrmRequestInit = {}): Promise<T> {
  const body = init.body;
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: requestHeaders(body),
    body: body === undefined || body instanceof FormData || typeof body === "string" ? body : JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : { message: await response.text().catch(() => "") };
  if (response.status === 401) {
    loginRedirect();
    throw new CrmApiError(response.status, payload as CrmErrorBody);
  }
  if (!response.ok) throw new CrmApiError(response.status, payload as CrmErrorBody);
  return payload as T;
}

export const crmApi = {
  me: () => request<Record<string, unknown>>("/api/auth/me"),
  bootstrap: () => request<BootstrapPayload>("/api/crm/v1/bootstrap"),
  analyzeDemand: (payload: Record<string, unknown>) => request<Record<string, unknown>>(
    "/api/crm/v1/demand/analyze",
    { method: "POST", body: payload },
  ),
  generateCommentDrafts: (payload: Record<string, unknown>) => request<Record<string, unknown>>(
    "/api/crm/v1/comments/drafts",
    { method: "POST", body: payload },
  ),
  generateFollowupDraft: (payload: Record<string, unknown>) => request<Record<string, unknown>>(
    "/api/crm/v1/comments/followup-draft",
    { method: "POST", body: payload },
  ),
  searchHotspots: (payload: Record<string, unknown>) => request<Record<string, unknown>>(
    "/api/crm/v1/hotspots/search",
    { method: "POST", body: payload },
  ),
  queryOpcHistory: (payload: Record<string, unknown>) => request<Record<string, unknown>>(
    "/api/crm/v1/opc/history/query",
    { method: "POST", body: payload },
  ),
  list: (resource: string, cursor = "", limit = 50) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return request<ListPayload>(`/api/crm/v1/${resource}?${query}`);
  },
  resource: (resource: string, resourceId: string) => request<Record<string, unknown>>(
    `/api/crm/v1/${encodeURIComponent(resource)}/${encodeURIComponent(resourceId)}`,
  ),
  createResource: (resource: string, payload: Record<string, unknown>) => request<Record<string, unknown>>(
    `/api/crm/v1/${encodeURIComponent(resource)}`,
    { method: "POST", body: payload },
  ),
  updateResource: (resource: string, resourceId: string, payload: Record<string, unknown>) => request<Record<string, unknown>>(
    `/api/crm/v1/${encodeURIComponent(resource)}/${encodeURIComponent(resourceId)}`,
    { method: "PATCH", body: payload },
  ),
  deleteResource: (resource: string, resourceId: string) => request<Record<string, unknown>>(
    `/api/crm/v1/${encodeURIComponent(resource)}/${encodeURIComponent(resourceId)}`,
    { method: "DELETE" },
  ),
  poolMembers: (poolId: string, cursor = "", limit = 50) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return request<ListPayload>(`/api/crm/v1/pools/${encodeURIComponent(poolId)}/members?${query}`);
  },
  uploadMedia: (upload: File) => {
    const body = new FormData();
    body.append("upload", upload, upload.name);
    return request<Record<string, unknown>>("/api/crm/v1/media", { method: "POST", body });
  },
  importOpcHistory: (payload: Record<string, unknown>) => request<Record<string, unknown>>(
    "/api/crm/v1/opc/history/import",
    { method: "POST", body: payload },
  ),
  runSchedule: (scheduleId: string, payload: Record<string, unknown> = {}) => request<{ task_id?: string; status?: string }>(
    `/api/crm/v1/schedules/${encodeURIComponent(scheduleId)}/run`,
    { method: "POST", body: payload },
  ),
  stopSchedule: (scheduleId: string) => request<Record<string, unknown>>(
    `/api/crm/v1/schedules/${encodeURIComponent(scheduleId)}/stop`,
    { method: "POST", body: {} },
  ),
  analytics: () => request<Record<string, unknown>>("/api/crm/v1/analytics"),
  tasks: (cursor = "", limit = 50) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return request<{ items?: CrmTask[]; tasks?: CrmTask[]; next_cursor?: string | null; has_more?: boolean } | CrmTask[]>(`/api/crm/v1/tasks?${query}`);
  },
  task: (taskId: string) => request<Record<string, unknown>>(`/api/crm/v1/tasks/${encodeURIComponent(taskId)}`),
  deleteTask: (taskId: string, confirmed = true) => request<Record<string, unknown>>(
    `/api/crm/v1/tasks/${encodeURIComponent(taskId)}`,
    { method: "DELETE", body: { confirmed } },
  ),
  taskEvidence: (taskId: string) => request<{ items?: Array<Record<string, unknown>>; evidence?: Array<Record<string, unknown>> }>(
    `/api/crm/v1/tasks/${encodeURIComponent(taskId)}/evidence`,
  ),
  createWorkflow: (payload: Record<string, unknown>) => request<{ task_id: string; status: string; idempotency_key?: string; status_url?: string }>("/api/crm/v1/tasks", { method: "POST", body: payload }),
  preflight: (payload: Record<string, unknown>) => request<{
    actions?: Array<Record<string, unknown>>;
    preflight_token: string;
    expires_at?: number | string;
    total_count?: number;
    allowed_count?: number;
    duplicate_count?: number;
    blocked_count?: number;
    actions_hash?: string;
    quote?: { total_points?: number; items?: Array<Record<string, unknown>> };
    decisions?: Array<{ index?: number; action_type?: string; target_key?: string; allowed?: boolean; reason_code?: string; duplicate_action_id?: string }>;
  }>("/api/crm/v1/preflight", { method: "POST", body: payload }),
  taskAction: async (taskId: string, action: "pause" | "resume" | "cancel" | "retry" | "takeover" | "confirm" | "reconcile") => {
    const operation = action;
    const storageKey = `crm-retry-idempotency:${taskId}`;
    let idempotencyKey = "";
    if (action === "retry") {
      idempotencyKey = safeSessionValue(storageKey) || `crm-ui-retry:${taskId}:${window.crypto.randomUUID()}`;
      writeSessionValue(storageKey, idempotencyKey);
    }
    const result = await request<Record<string, unknown>>(`/api/crm/v1/tasks/${encodeURIComponent(taskId)}/${operation}`, {
      method: "POST",
      body: action === "retry" ? { idempotency_key: idempotencyKey } : {},
    });
    if (action === "retry") removeSessionValue(storageKey);
    return result;
  },
  openLogin: (accountId: string) => request<{ session_url?: string; live_browser_url?: string; task_id?: string }>(`/api/crm/v1/accounts/${encodeURIComponent(accountId)}/open-login`, { method: "POST", body: {} }),
  verifyRelationships: (payload: { account_id: string; lead_ids: string[]; idempotency_key: string }) => request<{ task_id: string; status: string }>(
    "/api/crm/v1/relationships/verify",
    { method: "POST", body: payload },
  ),
  resetRotation: (accountId: string) => request<Record<string, unknown>>(
    `/api/crm/v1/accounts/${encodeURIComponent(accountId)}/rotation/reset`,
    { method: "POST", body: { confirmed_follow_action: true } },
  ),
  deduplicatePoolMembers: (poolId: string) => request<Record<string, unknown>>(
    `/api/crm/v1/pools/${encodeURIComponent(poolId)}/members/deduplicate`,
    { method: "POST", body: {} },
  ),
  verifyAccount: (accountId: string) => request<{ task_id: string; status: string }>(
    "/api/crm/v1/tasks",
    {
      method: "POST",
      body: {
        workflow_type: "account_check",
        title: "CRM account verification",
        idempotency_key: `crm-account-check:${accountId}:${window.crypto.randomUUID()}`,
        input: { account_id: accountId },
        actions: [{ action_type: "account_check", account_id: accountId, target_key: `account:${accountId}`, payload: { account_id: accountId } }],
        confirmed: true,
      },
    },
  ),
  reviewAction: (taskId: string, actionId: string, state: "confirmed" | "failed", evidence: Record<string, unknown> = {}) => request<Record<string, unknown>>(
    `/api/crm/v1/tasks/${encodeURIComponent(taskId)}/actions/${encodeURIComponent(actionId)}/review`,
    { method: "POST", body: { state, evidence } },
  ),
  browserSessions: () => request<{ ok?: boolean; sessions?: BrowserSession[] }>("/api/persona_dashboard/automation/browser_sessions"),
};

export function payloadItems(payload: ListPayload | Array<Record<string, unknown>> | undefined) {
  if (Array.isArray(payload)) return payload;
  return payload?.items || payload?.results || payload?.data || [];
}

export function taskItems(payload: Awaited<ReturnType<typeof crmApi.tasks>> | undefined) {
  if (Array.isArray(payload)) return payload;
  return payload?.items || payload?.tasks || [];
}
