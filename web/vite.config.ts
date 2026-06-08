import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  resolve: {
    alias: {
      "node-fetch": path.resolve(root, "src/shims/nodeFetch.ts"),
    },
  },
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
    // The largest chunks are lazy-loaded CopilotKit/mermaid/shiki route assets,
    // not the main application entry. Keep the limit above those intentional
    // feature chunks so build output still flags future unexpected growth.
    chunkSizeWarningLimit: 2000,
  },
});
