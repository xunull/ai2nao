import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [
    {
      name: "ignore-copilotkit-bundled-css",
      enforce: "pre",
      load(id) {
        if (id.endsWith("@copilotkit/react-core/dist/v2/index.css")) return "";
        return null;
      },
    },
    react(),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
