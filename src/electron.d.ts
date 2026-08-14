export {};
declare global {
  interface Window {
    mavatDesktop?: {
      selectDataFile(): Promise<string>;
      copyText(text: string): Promise<boolean>;
      navigateRoute(route: string): Promise<boolean>;
      showWindow(): Promise<boolean>;
      extension: {
        getPath(): Promise<string>;
        showFolder(): Promise<string>;
      };
      automationEngine: {
        command<T = unknown>(command: string, payload?: Record<string, unknown>): Promise<T>;
        status(): Promise<AutomationEngineLifecycleStatus>;
        connect(): Promise<AutomationEngineLifecycleStatus>;
        disconnect(): Promise<AutomationEngineLifecycleStatus>;
        configure(settings: AutomationEngineLifecycleSettings): Promise<AutomationEngineLifecycleStatus>;
        onEvent(listener: (event: AutomationEngineEvent) => void): () => void;
      };
      layout: {
        split(profileDir?: string): Promise<{ ok: boolean }>;
        maximize(): Promise<boolean>;
        getLinked(): Promise<boolean>;
        setLinked(enabled: boolean): Promise<boolean>;
      };
      platform: string;
    };
  }

  type AutomationEngineEvent = {
    kind: "event";
    type: string;
    at: string;
    status?: AutomationEngineStatus;
    [key: string]: unknown;
  };

  type AutomationEngineStatus = {
    ready: boolean;
    browserOpen: boolean;
    profilePreparing: boolean;
    running: boolean;
    mode: string;
    profileDir: string;
    page: { title: string; url: string } | null;
    layout?: { ok: boolean; error?: string };
  };

  type AutomationEngineLifecycleSettings = {
    autoConnect: boolean;
    keepConnected: boolean;
    idleMinutes: number;
  };

  type AutomationEngineLifecycleStatus = AutomationEngineLifecycleSettings & {
    state: "ready" | "connected" | "active";
    processRunning: boolean;
    activeRequests: number;
    lastActivityAt: string | null;
    disconnectAt: string | null;
  };
}
