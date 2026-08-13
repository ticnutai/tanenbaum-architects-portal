import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "node:path";

export default defineConfig({
  base: "/app/",
  plugins: [tsconfigPaths(), tailwindcss(), react()],
  build: {
    outDir: "dist-electron",
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "electron.index.html"),
    },
  },
});
