import { Bot, Chrome } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { mavatApi, type AutomationsData } from "@/lib/mavat-api";

export function AutomationContext() {
  const [data, setData] = useState<AutomationsData | null>(null);

  useEffect(() => {
    mavatApi<AutomationsData>("/api/automations")
      .then(setData)
      .catch(() => undefined);
  }, []);

  const active = data?.automations.find((item) => item.id === data.active_id);
  if (!active) return null;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-primary/15 bg-primary/5 px-4 py-3">
      <span className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Bot className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">האוטומציה הפעילה</p>
        <p className="truncate font-semibold">{active.name}</p>
      </div>
      <Badge variant={active.status === "active" ? "secondary" : "outline"}>
        {active.status === "active" ? "פעילה" : "טיוטה"}
      </Badge>
      <Badge variant="outline" title="המערכת מתחברת לחלון Google Chrome חיצוני באמצעות CDP">
        <Chrome className="size-3" />
        Chrome חיצוני · CDP
      </Badge>
    </div>
  );
}
