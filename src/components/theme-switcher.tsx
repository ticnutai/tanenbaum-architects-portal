import { useEffect, useState } from "react";
import { Check, Palette } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const THEMES = [
  {
    id: "royal",
    name: "כחול מלכותי וזהב",
    hint: "נייבי עמוק, זהב ולבן עדין",
    swatch: ["#16244a", "#d8a93a", "#f7f9fc"],
  },
  {
    id: "navy-night",
    name: "לילה נייבי",
    hint: "מצב כהה עם מבטאי זהב",
    swatch: ["#0f1a36", "#e0b64a", "#2a3a63"],
  },
  {
    id: "platinum",
    name: "פלטינה",
    hint: "לבן נקי ונייבי מינימלי",
    swatch: ["#ffffff", "#2a3a63", "#8fa4c8"],
  },
  {
    id: "emerald",
    name: "אמרלד יוקרתי",
    hint: "ירוק עמוק עם זהב",
    swatch: ["#123a2e", "#d8a93a", "#f2f7f4"],
  },
  {
    id: "stone",
    name: "אבן חמה",
    hint: "גוני אבן וברונזה",
    swatch: ["#3a332c", "#b5813f", "#f7f5f0"],
  },
] as const;

const STORAGE_KEY = "tannenbaum-theme";

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<string>("royal");

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      setTheme(saved);
      document.documentElement.dataset["theme"] = saved;
    } else {
      document.documentElement.dataset["theme"] = "royal";
    }
  }, []);

  const apply = (id: string) => {
    setTheme(id);
    document.documentElement.dataset["theme"] = id;
    localStorage.setItem(STORAGE_KEY, id);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="ערכת נושא">
          <Palette className="size-5 text-accent" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>ערכות נושא</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {THEMES.map((t) => (
          <DropdownMenuItem
            key={t.id}
            onSelect={() => apply(t.id)}
            className="flex items-center gap-3 py-2"
          >
            <span className="flex overflow-hidden rounded-full border border-border">
              {t.swatch.map((c) => (
                <span key={c} className="size-4" style={{ backgroundColor: c }} />
              ))}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{t.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{t.hint}</span>
            </span>
            {theme === t.id ? <Check className="size-4 text-accent" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}