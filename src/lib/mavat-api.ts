export type ProfileStatus = { name: string; username: string; has_password: boolean };
export type WorkflowStep = {
  name: string;
  type: string;
  scope?: string;
  target?: string;
  value?: string;
  timeout_seconds?: number;
  enabled?: boolean;
  credential_profile_id?: string;
  _secret_status?: "saved" | "missing";
};
export type WorkflowData = {
  workflow: { name: string; steps: WorkflowStep[] };
  profiles: Record<string, ProfileStatus>;
};
export type AutomationSummary = {
  id: string;
  name: string;
  description: string;
  status: "active" | "draft";
  created_at: string;
  steps_count: number;
  active: boolean;
};
export type AutomationsData = { automations: AutomationSummary[]; active_id: string };
export type RunState = {
  state: string;
  message: string;
  current_row: number;
  total_rows: number;
  manual_message: string;
  current_step?: number;
  current_step_name?: string;
  current_step_action?: string;
  current_step_target?: string;
  started_at?: string;
  paused_from?: string;
  last_error?: {
    row?: number;
    step?: number;
    step_name?: string;
    action?: string;
    target?: string;
    url?: string;
    error?: string;
    screenshot?: string;
  };
};
export type SettingsData = {
  data_file: string;
  data_file_name: string;
  preview: Record<string, unknown>[];
  error: string;
  run: RunState;
};
export type LogEvent = { id: number; timestamp: string; message: string; status: string };
export type LogsData = {
  events: LogEvent[];
  summary: { total: number; errors: number; success: number; manual: number };
};

export async function mavatApi<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    ok?: boolean;
    error?: string;
    message?: string;
  };
  if (!response.ok || data.ok === false)
    throw new Error(data.error || data.message || "הפעולה נכשלה");
  return data;
}

export async function copyMavatText(text: string) {
  if (window.mavatDesktop?.copyText) return window.mavatDesktop.copyText(text);
  return navigator.clipboard.writeText(text);
}
