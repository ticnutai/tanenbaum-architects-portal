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
  locator?: { strategy: string; value?: string; score?: number; role?: string };
  fallbacks?: Array<{
    strategy: string;
    value?: string;
    score?: number;
    role?: string;
    x_ratio?: number;
    y_ratio?: number;
  }>;
  page_url?: string;
  position?: { x_ratio: number; y_ratio: number };
  confidence?: number;
  recorded_at?: string;
  screenshot?: string;
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
export type AutomationInputField = {
  key: string;
  label: string;
  type: "text" | "number" | "decimal" | "select" | "autocomplete" | "date";
  required: boolean;
  options?: string[];
};
export type AutomationDetail = {
  automation: AutomationSummary;
  workflow: { name: string; steps: WorkflowStep[] };
  input_schema: AutomationInputField[];
};
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
  browser_provider: "auto" | "browseros" | "chrome";
  browser: {
    connected: boolean;
    provider: "browseros" | "chrome";
    display_name: string;
    port: number;
    mcp_url?: string;
    fallback_available?: boolean;
  };
  extension_bridge: {
    paired_count: number;
    live_count: number;
    pairing_active: boolean;
    pairing_code?: string;
    pairing_expires_at?: string;
  };
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

export async function ensureMavatChromeReady(options: { focus?: boolean } = {}) {
  // Background runs must not steal focus. BrowserOS is preferred when healthy;
  // the dedicated Chrome remains a transparent fallback.
  const focus = options.focus === true;
  let status = await mavatApi<{ connected: boolean }>("/api/chrome/status");
  if (!status.connected) {
    await mavatApi("/api/chrome/open", { method: "POST" });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      status = await mavatApi<{ connected: boolean }>("/api/chrome/status");
      if (status.connected) break;
    }
    if (!status.connected) throw new Error("הדפדפן נפתח אך חיבור האוטומציה לא הושלם בזמן");
  }
  if (focus) {
    await mavatApi("/api/chrome/focus", { method: "POST" }).catch(() => undefined);
  }
  return status;
}
