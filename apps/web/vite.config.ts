import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const target = process.env.SB_PROXY_TARGET ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target, changeOrigin: true },
      "/ws": { target, ws: true, changeOrigin: true },
      "/chaos": { target, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    chunkSizeWarningLimit: 1600,
  },
});
