import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  base: "/assets/crm/",
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "../../../webapp/static/assets/crm"),
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    target: "es2022",
  },
});
