export type Language = "zh-Hans" | "zh-Hant";

export type ViewId =
  | "overview"
  | "collect"
  | "pools"
  | "public"
  | "outreach"
  | "groups"
  | "relationships"
  | "tasks"
  | "analytics"
  | "schedules"
  | "templates"
  | "destinations"
  | "accounts"
  | "settings";

export type CrmErrorBody = {
  code?: string;
  message?: string;
  message_key?: string;
  details?: Record<string, unknown>;
  request_id?: string;
  retryable?: boolean;
};

export type CrmTaskStatus =
  | "draft"
  | "awaiting_confirmation"
  | "queued"
  | "running"
  | "manual_required"
  | "paused_by_user"
  | "paused_by_policy"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type CrmTask = {
  id?: string | number;
  task_id?: string;
  title?: string;
  name?: string;
  kind?: string;
  status?: CrmTaskStatus | string;
  progress?: number | null;
  processed?: number;
  total?: number;
  updated_at?: string;
  created_at?: string;
  message?: string;
  account_username?: string;
  evidence_count?: number;
  actions?: CrmAction[];
  steps?: CrmStep[];
  input?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

export type CrmAction = {
  id?: string;
  action_id?: string;
  action_type?: string;
  state?: string;
  account_id?: string | number;
  target_key?: string;
  content?: string;
  payload?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  error_code?: string;
};

export type CrmStep = {
  id?: string;
  step_type?: string;
  social_task_id?: string;
  status?: string;
  error_code?: string;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

export type CrmAccount = {
  id?: string | number;
  username?: string;
  platform?: string;
  status?: string;
  health_status?: string;
  needs_login?: boolean;
  display_name?: string;
  rotation?: {
    locked?: boolean;
    requires_follow_action?: boolean;
    consecutive_composer_failures?: number;
  };
};

export type BootstrapPayload = {
  module?: {
    enabled?: boolean;
    effective?: boolean;
    reasons?: string[];
    settings?: { enabled?: boolean; maintenance?: boolean; emergency_pause?: boolean; version?: string };
    maintenance?: boolean;
    degraded?: boolean;
    version?: string;
    message?: string;
  };
  account?: Record<string, unknown>;
  user?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  counts?: Record<string, unknown>;
  workspace?: { user_id?: number; username?: string; managed_by_admin?: boolean; operator_user_id?: number | null };
  capabilities?: Record<string, { status?: "equivalent" | "adapted" | "blocked"; enabled?: boolean; reason_code?: string }>;
  accounts?: CrmAccount[];
  tasks?: CrmTask[];
  onboarding?: { completed?: boolean; steps?: Array<{ id: string; completed?: boolean }> };
  warnings?: Array<{ code?: string; message?: string; message_key?: string }>;
};

export type BrowserSession = {
  id?: string;
  session_id?: string;
  task_id?: string;
  account_id?: string;
  browser_ready?: boolean;
  task_status?: string;
};

export type ListPayload = {
  items?: Array<Record<string, unknown>>;
  results?: Array<Record<string, unknown>>;
  data?: Array<Record<string, unknown>>;
  next_cursor?: string | null;
  has_more?: boolean;
  total?: number;
};
