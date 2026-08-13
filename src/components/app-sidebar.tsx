import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Building2,
  Users,
  ScrollText,
  Settings,
  Compass,
  Bot,
  Radio,
  ListOrdered,
  Pin,
  PinOff,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

const groups = [
  {
    label: "משרד",
    items: [
      { title: "לוח בקרה", url: "/", icon: LayoutDashboard },
      { title: "תכניות ופרויקטים", url: "/projects", icon: Building2 },
      { title: "נתוני לקוחות", url: "/clients", icon: Users },
    ],
  },
  {
    label: "אוטומציה",
    items: [
      { title: "אוטומציות", url: "/automations", icon: Bot },
      { title: "הקלטת פעולות", url: "/recorder", icon: Radio },
      { title: "שלבי עבודה", url: "/workflow", icon: ListOrdered },
      { title: "יומן ריצה", url: "/logs", icon: ScrollText },
    ],
  },
  {
    label: "מערכת",
    items: [{ title: "הגדרות", url: "/settings", icon: Settings }],
  },
];

type AppSidebarProps = {
  autoHide: boolean;
  onAutoHideChange: (autoHide: boolean) => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
};

export function AppSidebar({
  autoHide,
  onAutoHideChange,
  onPointerEnter,
  onPointerLeave,
}: AppSidebarProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <Sidebar
      side="right"
      collapsible={autoHide ? "offcanvas" : "icon"}
      overlay={autoHide}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      className={autoHide ? "z-40 shadow-2xl" : undefined}
    >
      <SidebarHeader className="border-b border-sidebar-border px-3 py-4">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-sidebar-primary text-sidebar-primary-foreground">
            <Compass className="size-5" />
          </span>
          <div className="min-w-0 group-data-[collapsible=icon]:hidden">
            <p className="truncate font-display text-sm font-bold">טננבאום אדריכלות</p>
            <p className="truncate text-xs text-sidebar-foreground/60">מערכת ניהול משרדית</p>
          </div>
          <button
            type="button"
            onClick={() => onAutoHideChange(!autoHide)}
            className="ms-auto hidden size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring md:flex group-data-[collapsible=icon]:hidden"
            aria-label={autoHide ? "הצמדת סרגל הצד" : "הפעלת הסתרה אוטומטית"}
            title={autoHide ? "הצמד את סרגל הצד" : "הפעל הסתרה אוטומטית"}
          >
            {autoHide ? <Pin className="size-4" /> : <PinOff className="size-4" />}
          </button>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {groups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.url}>
                    <SidebarMenuButton asChild isActive={pathname === item.url || (item.url === "/automations" && pathname.startsWith("/automations/"))} tooltip={item.title}>
                      <Link
                        to={item.url}
                        onClick={(event) => {
                          if (pathname !== "/logs" || item.url === "/logs" || !window.mavatDesktop?.navigateRoute) return;
                          event.preventDefault();
                          event.stopPropagation();
                          void window.mavatDesktop.navigateRoute(item.url);
                        }}
                        className="flex items-center gap-2"
                      >
                        <item.icon className="size-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-3 group-data-[collapsible=icon]:hidden">
        <p className="text-xs leading-relaxed text-sidebar-foreground/60">
          גרסה 1.0 · מצב בדיקה פעיל כברירת מחדל
        </p>
      </SidebarFooter>
    </Sidebar>
  );
}
