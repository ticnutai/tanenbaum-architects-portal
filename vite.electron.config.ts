import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "node:path";
import { readFileSync } from "node:fs";

const appVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;

export default defineConfig({
  base: "/app/",
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
  },
  plugins: [tsconfigPaths(), tailwindcss(), react()],
  build: {
    outDir: "dist-electron",
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "electron.index.html"),
    },
  },
});
