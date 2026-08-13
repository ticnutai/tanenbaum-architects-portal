import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { SystemConsoleDock } from "@/components/system-console-dock";
import { FloatingRecordingControl } from "@/components/floating-recording-control";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "משרד טננבאום אדריכלות — מערכת ניהול" },
      {
        name: "description",
        content: "מערכת פנימית לניהול תכניות, לקוחות ואוטומציית מבא״ת במשרד טננבאום אדריכלות.",
      },
      { name: "author", content: "טננבאום אדריכלות" },
      { property: "og:title", content: "משרד טננבאום אדריכלות — מערכת ניהול" },
      {
        property: "og:description",
        content: "ניהול תכניות, לקוחות ואוטומציית מבא״ת במקום אחד.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:site", content: "@Lovable" },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Frank+Ruhl+Libre:wght@400;500;700;800&family=Heebo:wght@300;400;500;600;700&display=swap",
      },
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <head>
        <meta
          httpEquiv="Content-Security-Policy"
          content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:18473 http://127.0.0.1:18474 ws://127.0.0.1:18474;"
        />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [sidebarAutoHide, setSidebarAutoHide] = useState(false);
  const [sidebarHovered, setSidebarHovered] = useState(false);
  const [sidebarManualOpen, setSidebarManualOpen] = useState(false);
  const [sidebarPinnedOpen, setSidebarPinnedOpen] = useState(true);

  useEffect(() => {
    setSidebarAutoHide(window.localStorage.getItem("mavat.sidebar.autoHide") === "true");
  }, []);

  useEffect(() => {
    if (!window.mavatDesktop) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/events`);
    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as { type?: string; route?: string };
        if (event.type !== "extension-open-editor") return;
        void window.mavatDesktop?.showWindow();
        void window.mavatDesktop?.navigateRoute(event.route || "/recorder");
      } catch {
        // Diagnostics from the backend must never interrupt the desktop UI.
      }
    };
    return () => socket.close();
  }, []);

  const changeSidebarAutoHide = (autoHide: boolean) => {
    setSidebarAutoHide(autoHide);
    window.localStorage.setItem("mavat.sidebar.autoHide", String(autoHide));
    if (autoHide) {
      setSidebarManualOpen(false);
      setSidebarHovered(true);
    } else {
      setSidebarPinnedOpen(true);
      setSidebarHovered(false);
      setSidebarManualOpen(false);
    }
  };

  const sidebarOpen = sidebarAutoHide ? sidebarHovered || sidebarManualOpen : sidebarPinnedOpen;
  const goBack = () => {
    // Chromium can wedge during an SPA unmount of the live log view in the
    // packaged Electron build. Ask Electron's main process to replace the
    // document so the navigation cannot be blocked by the old renderer.
    if (pathname === "/logs") {
      if (window.mavatDesktop?.navigateRoute) {
        void window.mavatDesktop.navigateRoute("/workflow");
      } else {
        window.location.assign("/workflow");
      }
      return;
    }
    if (router.history.canGoBack()) {
      router.history.back();
      return;
    }
    void router.navigate({ to: "/" });
  };

  return (
    <QueryClientProvider client={queryClient}>
      <SidebarProvider
        open={sidebarOpen}
        onOpenChange={(open) => {
          if (sidebarAutoHide) setSidebarManualOpen(open);
          else setSidebarPinnedOpen(open);
        }}
      >
        <div className="flex min-h-screen w-full bg-background">
          <AppSidebar
            autoHide={sidebarAutoHide}
            onAutoHideChange={changeSidebarAutoHide}
            onPointerEnter={() => {
              if (sidebarAutoHide) setSidebarHovered(true);
            }}
            onPointerLeave={() => {
              if (sidebarAutoHide) {
                setSidebarHovered(false);
                setSidebarManualOpen(false);
              }
            }}
          />
          {sidebarAutoHide && !sidebarOpen && (
            <button
              type="button"
              className="fixed inset-y-20 right-0 z-40 hidden w-3 items-center justify-center rounded-s-md border border-e-0 border-sidebar-border bg-sidebar text-sidebar-primary shadow-lg transition-[width] hover:w-4 md:flex"
              onMouseEnter={() => setSidebarHovered(true)}
              onFocus={() => setSidebarManualOpen(true)}
              aria-label="פתיחת סרגל הצד"
              title="העבר את העכבר לפתיחת סרגל הצד"
            >
              <span className="h-16 w-1 rounded-full bg-sidebar-primary" />
            </button>
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-card/80 px-4 backdrop-blur">
              <SidebarTrigger />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={goBack}
                disabled={pathname === "/" && !router.history.canGoBack()}
                aria-label="חזרה למסך הקודם"
                title="חזרה למסך הקודם"
              >
                <ArrowRight className="size-4" />
                <span className="hidden sm:inline">חזרה</span>
              </Button>
              <span className="font-display text-sm font-medium text-muted-foreground">
                משרד טננבאום אדריכלות
              </span>
              <div className="ms-auto flex items-center gap-4">
                <SystemStatus />
                <ThemeSwitcher />
              </div>
            </header>
            <main className="flex-1 px-5 py-8 md:px-10">
              {/* Required: nested routes render here. */}
              <Outlet />
            </main>
          </div>
        </div>
      </SidebarProvider>
      <FloatingRecordingControl />
      <SystemConsoleDock />
      <Toaster />
    </QueryClientProvider>
  );
}

function SystemStatus() {
  const [pythonConnected, setPythonConnected] = useState(false);
  const [cdpConnected, setCdpConnected] = useState(false);
  const [browserName, setBrowserName] = useState("דפדפן");
  useEffect(() => {
    const check = async () => {
      try {
        const [python, chrome] = await Promise.all([
          fetch("/api/run/status"),
          fetch("/api/chrome/status"),
        ]);
        setPythonConnected(python.ok);
        const chromeStatus = chrome.ok
          ? ((await chrome.json()) as { connected?: boolean; display_name?: string })
          : {};
        setCdpConnected(Boolean(chromeStatus.connected));
        setBrowserName(chromeStatus.display_name || "דפדפן");
      } catch {
        setPythonConnected(false);
        setCdpConnected(false);
      }
    };
    check();
    const timer = window.setInterval(check, 5000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="hidden items-center gap-4 text-xs text-muted-foreground sm:flex">
      <span className="flex items-center gap-2">
        <i
          className={`size-2 rounded-full ${pythonConnected ? "bg-emerald-500" : "bg-destructive"}`}
        />
        {pythonConnected ? "Python מחובר" : "Python מנותק"}
      </span>
      <span className="flex items-center gap-2">
        <i
          className={`size-2 rounded-full ${cdpConnected ? "bg-emerald-500" : "bg-destructive"}`}
        />
        {cdpConnected ? `${browserName} מחובר` : `${browserName} מנותק`}
      </span>
    </span>
  );
}
