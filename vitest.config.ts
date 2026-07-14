import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // Points AI2NAO_CONFIG_DB at a temp file so no test can read or write the
    // developer's real ~/.ai2nao/config.db (which holds live API keys).
    setupFiles: ["test/setup/isolateCredentials.ts"],
  },
});
