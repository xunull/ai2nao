import { defineConfig } from "@playwright/test";

/**
 * Separate from the repo root config on purpose: that one boots a Vite dev server
 * for the web UI, which an Electron launch has no use for.
 *
 * Serial and single-worker because these tests drive a real Electron process that
 * holds a single-instance lock — two at once would have one of them exit
 * immediately, which is correct behaviour and a useless test.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
});
