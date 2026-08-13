export type ExtensionStep = {
  index: number;
  name: string;
  type: string;
  target: string;
  value: string;
  page_url: string;
  enabled: boolean;
  confidence: number;
  locator_strategy: string;
  recorded_at: string;
  has_screenshot: boolean;
  secret_status: "" | "saved" | "missing";
};

export type ExtensionState = {
  ok: true;
  revision: number;
  automation: { id: string; name: string };
  recording: { state: string; message: string };
  browser: {
    connected: boolean;
    display_name: string;
    target_title: string;
    target_url: string;
  };
  steps: ExtensionStep[];
};

type Connection = { port: number; token: string };
type ApiResult<T> = T & { ok?: boolean; error?: string; message?: string };

const STORAGE_KEY = "mavatRecorderConnection";
const PORTS = Array.from({ length: 21 }, (_, index) => 18473 + index);

async function readConnection(): Promise<Connection | null> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY] as Partial<Connection> | undefined;
  if (!value?.port || !value.token) return null;
  return { port: Number(value.port), token: String(value.token) };
}

async function writeConnection(connection: Connection | null) {
  if (connection) await browser.storage.local.set({ [STORAGE_KEY]: connection });
  else await browser.storage.local.remove(STORAGE_KEY);
}

async function request<T>(port: number, path: string, init: RequestInit = {}, token = "") {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Mavat-Extension-Id": browser.runtime.id,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  const data = (await response.json().catch(() => ({}))) as ApiResult<T>;
  if (!response.ok || data.ok === false)
    throw new Error(data.error || data.message || "הפעולה נכשלה");
  return data as T;
}

export async function discoverBackend(): Promise<{ port: number; paired: boolean }> {
  const stored = await readConnection();
  const probe = async (port: number) => {
    const ping = await request<{ paired: boolean; service: string }>(
      port,
      "/api/extension/ping",
      // A cold Python/Electron startup can legitimately take longer than a
      // few hundred milliseconds. The probes run concurrently, so this does
      // not multiply the discovery time by the number of reserved ports.
      { signal: AbortSignal.timeout(1_500) },
      stored?.token || "",
    );
    if (ping.service !== "mavat-automation") throw new Error("שירות מקומי אחר משתמש בפורט");
    return { port, paired: Boolean(ping.paired) };
  };

  if (stored) {
    try {
      return await probe(stored.port);
    } catch {
      // The previous port may have changed after an application restart.
    }
  }

  try {
    return await Promise.any(
      PORTS.filter((port) => port !== stored?.port).map((port) => probe(port)),
    );
  } catch {
    throw new Error("תוכנת מבא״ת אינה פועלת או אינה זמינה");
  }
}

export async function connectStored(): Promise<{
  connection: Connection;
  state: ExtensionState;
} | null> {
  const connection = await readConnection();
  if (!connection) return null;
  try {
    return {
      connection,
      state: await request<ExtensionState>(
        connection.port,
        "/api/extension/state",
        {},
        connection.token,
      ),
    };
  } catch {
    await writeConnection(null);
    return null;
  }
}

export async function pair(port: number, code: string) {
  const result = await request<{ token: string; state: ExtensionState }>(
    port,
    "/api/extension/pair",
    {
      method: "POST",
      body: JSON.stringify({ code }),
    },
  );
  const connection = { port, token: result.token };
  await writeConnection(connection);
  return { connection, state: result.state };
}

export async function loadState(connection: Connection) {
  return request<ExtensionState>(connection.port, "/api/extension/state", {}, connection.token);
}

export async function command<T = { state?: ExtensionState }>(
  connection: Connection,
  path: string,
  body?: Record<string, unknown>,
) {
  return request<T>(
    connection.port,
    path,
    {
      method: "POST",
      body: JSON.stringify(body || {}),
    },
    connection.token,
  );
}

export async function loadThumbnail(connection: Connection, index: number) {
  const response = await fetch(
    `http://127.0.0.1:${connection.port}/api/extension/steps/${index}/thumbnail`,
    {
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "X-Mavat-Extension-Id": browser.runtime.id,
      },
    },
  );
  if (!response.ok) throw new Error("טעינת הצילום נכשלה");
  return URL.createObjectURL(await response.blob());
}

export function eventSocket(connection: Connection) {
  return new WebSocket(
    `ws://127.0.0.1:${connection.port}/ws/extension?token=${encodeURIComponent(connection.token)}&extension_id=${encodeURIComponent(browser.runtime.id)}`,
  );
}

export async function forgetConnection() {
  await writeConnection(null);
}

export type { Connection };
import { browser } from "wxt/browser";
