import { ClipboardCopy, RefreshCw, Terminal, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { copyMavatText, mavatApi } from "@/lib/mavat-api";

type ConsoleResponse = {
  content: string;
  connections?: { connected?: boolean; browser?: string; port?: number };
};

const OPEN_CONSOLE_EVENT = "mavat:open-system-console";

export function openSystemConsole() {
  window.dispatchEvent(new Event(OPEN_CONSOLE_EVENT));
}

export function SystemConsoleDock() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");

  const refreshConsole = useCallback(async (showToast = false) => {
    setLoading(true);
    try {
      const data = await mavatApi<ConsoleResponse>("/api/console");
      setContent(data.content || "הקונסול ריק.");
      setUpdatedAt(new Date().toLocaleTimeString("he-IL"));
      if (showToast) toast.success("נתוני הקונסול רועננו");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setContent((current) => `${current}\n[שגיאה] רענון הקונסול נכשל: ${message}`.trim());
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refreshConsole();
  }, [open, refreshConsole]);

  useEffect(() => {
    const openConsole = () => setOpen(true);
    window.addEventListener(OPEN_CONSOLE_EVENT, openConsole);
    return () => window.removeEventListener(OPEN_CONSOLE_EVENT, openConsole);
  }, []);

  const copy = async () => {
    await copyMavatText(content);
    toast.success("תוכן הקונסול הועתק");
  };

  return (
    <>
      <div
        className="fixed bottom-3 left-3 z-40 flex items-center gap-1 rounded-lg border border-border bg-card/95 p-1 shadow-lg backdrop-blur"
        dir="rtl"
        aria-label="כלי פיתוח"
      >
        <Button
          type="button"
          variant={open ? "default" : "ghost"}
          size="icon"
          className="size-8"
          onClick={() => setOpen((value) => !value)}
          title="פתיחת קונסול המערכת"
          aria-label="פתיחת קונסול המערכת"
        >
          <Terminal className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() => void refreshConsole(true)}
          disabled={loading}
          title="רענון נתוני המערכת"
          aria-label="רענון נתוני המערכת"
        >
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {open ? (
        <section
          className="fixed inset-x-3 bottom-14 z-50 flex h-[min(420px,55vh)] flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-950 text-slate-100 shadow-2xl md:left-3 md:right-auto md:w-[min(900px,calc(100vw-340px))]"
          aria-label="קונסול המערכת"
        >
          <header className="flex items-center gap-3 border-b border-slate-700 px-4 py-3" dir="rtl">
            <Terminal className="size-4 text-amber-400" />
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold">קונסול המערכת</h2>
              <p className="truncate text-xs text-slate-400">
                Chrome חיצוני ייעודי דרך CDP · ללא iframe
                {updatedAt ? ` · עודכן ${updatedAt}` : ""}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 text-slate-200 hover:bg-slate-800 hover:text-white"
              onClick={() => void refreshConsole(true)}
              disabled={loading}
              title="רענן"
              aria-label="רענן קונסול"
            >
              <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 text-slate-200 hover:bg-slate-800 hover:text-white"
              onClick={() => void copy()}
              disabled={!content}
              title="העתק הכל"
              aria-label="העתק את תוכן הקונסול"
            >
              <ClipboardCopy className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 text-slate-200 hover:bg-slate-800 hover:text-white"
              onClick={() => setOpen(false)}
              title="סגור"
              aria-label="סגירת הקונסול"
            >
              <X className="size-4" />
            </Button>
          </header>
          <pre className="min-h-0 flex-1 overflow-auto p-4 text-left font-mono text-xs leading-5 text-sky-100" dir="ltr">
            {loading && !content ? "טוען נתוני מערכת..." : content || "הקונסול ריק."}
          </pre>
        </section>
      ) : null}
    </>
  );
}
