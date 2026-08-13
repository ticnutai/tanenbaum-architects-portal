import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "מקליט מבא״ת",
    short_name: "מקליט מבא״ת",
    description: "צפייה וניהול שלבי ההקלטה החיה במערכת אוטומציית מבא״ת המקומית",
    version: "1.0.0",
    action: { default_title: "פתיחת מקליט מבא״ת" },
    permissions: ["sidePanel", "storage"],
    host_permissions: ["http://127.0.0.1/*"],
  },
});
