import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// The electron package's main export is the path to its binary.
import electronPath from "electron";

/**
 * Does the shell actually come up, and does it show something useful when it
 * cannot reach a daemon?
 *
 * Scope, stated honestly: this launches the BUILT shell (`out/main.js`), not a
 * packaged `.app`. Under Approach A there is no packaged artifact — the design
 * says "A 阶段不分发，壳只给自己用". So the packaged-path failures that decision
 * 11.3A worried about are not covered here, because there is nothing packaged to
 * cover. See docs/desktop-manual-checklist.md for what that leaves to hands.
 *
 * What this DOES catch is the class of regression that costs the most time for
 * the least drama: the shell failing to start at all, or starting into a blank
 * window, after some unrelated refactor. Everything below runs with no daemon on
 * purpose — the guidance path is both the harder one to get right and the one a
 * new user hits first.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "..", "out", "main.js");

function shellEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Point the daemon-record lookup at an empty directory so the probe cannot
    // find a real daemon this developer happens to be running, and cannot
    // delete their records while cleaning up stale ones.
    AI2NAO_RUN_DIR: mkdtempSync(join(tmpdir(), "ai2nao-e2e-run-")),
    // Auto-start is off for every test here. The shell would otherwise spawn a
    // REAL daemon against the developer's real ~/.ai2nao, detached — so it would
    // outlive the test run by design and there would be nothing to clean up.
    // Covering the auto-start path needs an isolated HOME and a supervised
    // teardown; that lives in the manual checklist, not here.
    AI2NAO_SHELL_NO_AUTOSTART: "1",
    // Isolating AI2NAO_RUN_DIR alone is NOT enough: with no record on disk the
    // probe falls back to the default port, which is where the developer's real
    // daemon lives. Without this the suite attaches to real data and asserts
    // against the real dashboard. Point it at a port nothing uses.
    AI2NAO_SHELL_PORT: "8399",
  };
}

async function launch(): Promise<ElectronApplication> {
  return electron.launch({ args: [MAIN], env: shellEnv() });
}

test("starts and shows the guidance page when the daemon cannot be started", async () => {
  const app = await launch();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");

    // Not a blank window. And note what it must NOT say any more: with auto-start
    // wired in, "go run ai2nao serve" is no longer the first thing to tell someone
    // — the app already tried. The page has to explain that it tried and failed,
    // and hand over something to diagnose with.
    await expect(win.locator("h1")).toContainText("后台服务没起来");
    // Asserted against the whole page rather than a single <pre>: there is more
    // than one code block, and what matters is that the diagnosis is *somewhere*
    // on the page, not which box it landed in.
    await expect(win.locator("body")).toContainText("lsof");
  } finally {
    await app.close();
  }
});

test("the window is sandboxed and cannot reach Node", async () => {
  // The security posture is not observable from the outside, so assert it from
  // inside the page: with contextIsolation + sandbox + nodeIntegration:false,
  // `require` and `process` must simply not be there. If a future change relaxes
  // webPreferences, this fails instead of quietly handing a desktop container to
  // whatever is answering on 127.0.0.1.
  const app = await launch();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    const exposure = await win.evaluate(() => ({
      hasRequire: typeof (globalThis as { require?: unknown }).require !== "undefined",
      hasProcess: typeof (globalThis as { process?: unknown }).process !== "undefined",
    }));
    expect(exposure).toEqual({ hasRequire: false, hasProcess: false });
  } finally {
    await app.close();
  }
});

test("a second launch exits instead of opening a second window", async () => {
  // Two shells means two tray icons and a global shortcut that registers in one
  // process and silently fails in the other — the "hotkey works sometimes" bug.
  //
  // Spawned directly rather than through `_electron.launch()`: that helper waits
  // for the app to become ready and produce a window, and an instance that
  // correctly gives up the lock never gets that far. Using it here would fail on
  // the behaviour we want.
  const first = await launch();
  try {
    await first.firstWindow();

    const second = spawn(electronPath as unknown as string, [MAIN], {
      env: shellEnv(),
      stdio: "ignore",
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("second instance did not exit")), 20_000);
      second.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      second.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });

    expect(exitCode).toBe(0);
    // ...and the original is untouched.
    expect(first.windows().length).toBeGreaterThan(0);
  } finally {
    await first.close();
  }
});
