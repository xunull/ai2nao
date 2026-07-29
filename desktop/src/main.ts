import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
} from "electron";
import { probeDaemon, type ProbeResult } from "../../dist/serve/probeDaemon.js";
import {
  emptyNotifyState,
  type NotifyState,
  type ShellNotification,
} from "../../dist/desktopShell/notifyRules.js";
import {
  emptyPollClock,
  pollOnce,
  RUN_POLL_MS,
  type PollClock,
} from "../../dist/desktopShell/notifyPoller.js";
import {
  incompatiblePage,
  notRunningPage,
  portTakenPage,
  schemaMismatchPage,
  timeoutPage,
} from "./guidance.js";

/**
 * ai2nao 桌面壳 —— a window onto a daemon this process does not own.
 *
 * ## The one rule everything else follows from
 *
 * The shell NEVER starts, owns, or kills the daemon. `ai2nao serve` is not just a
 * UI backend: it hosts the MCP endpoint other agents connect to (src/serve/app.ts)
 * and the scheduler running 27 tasks. Quitting this window must not take those
 * down, so the shell is a client and a control panel — never a parent process.
 *
 * That inversion is also why this file is small and boring to package: nothing
 * here touches better-sqlite3, lancedb or pyodide, so there is no native module
 * to rebuild against Electron's ABI and nothing to unpack from the asar.
 *
 * ## Notifications only exist while this window does
 *
 * Deliberate (decision 4B). There is no daemon-side queue and no osascript
 * fallback: if the shell is not running, nothing fires. The upside is that alerts
 * come from Electron, so they carry ai2nao's own identity rather than being signed
 * "Script Editor" — which is one of the four things this shell exists to deliver.
 *
 * State is in-memory on purpose. A restart re-baselines silently instead of
 * replaying what happened while you were away, which matches "if the shell was not
 * running, it did not happen."
 */

const SHORTCUT = "CommandOrControl+Shift+Space";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let notifyTimer: NodeJS.Timeout | null = null;
let attachedUrl: string | null = null;

let notifyState: NotifyState = emptyNotifyState();
let pollClock: PollClock = emptyPollClock();

/* ------------------------------------------------------------------ *
 * Single instance (T9)
 *
 * Without this you get two tray icons and, worse, the second process's
 * globalShortcut.register() silently returns false — so the hotkey appears to
 * work "sometimes". Electron ships the lock; there is nothing to hand-roll.
 * ------------------------------------------------------------------ */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // Launching again means "show me the app", not "make another one".
    revealWindow();
  });
  void main();
}

/* ------------------------------------------------------------------ *
 * Security (T11)
 *
 * This window loads http://127.0.0.1:<port>. If that port were ever taken over,
 * an unsandboxed window would hand a desktop container to whatever answered. The
 * per-window options below are the baseline; the app-level handler catches any
 * webContents created later, including ones we did not construct.
 * ------------------------------------------------------------------ */
function allowedOrigin(): string | null {
  if (attachedUrl === null) return null;
  try {
    return new URL(attachedUrl).origin;
  } catch {
    return null;
  }
}

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event, navigationUrl) => {
    const origin = allowedOrigin();
    let target: string | null = null;
    try {
      target = new URL(navigationUrl).origin;
    } catch {
      target = null;
    }
    // Anything that is not the daemon we probed gets stopped. Links the user
    // actually wants belong in their browser, which setWindowOpenHandler covers.
    if (origin === null || target !== origin) event.preventDefault();
  });

  contents.setWindowOpenHandler(({ url }) => {
    // External links open in the real browser; nothing gets a second window here.
    if (url.startsWith("https://") || url.startsWith("http://")) {
      setImmediate(() => {
        void shell.openExternal(url);
      });
    }
    return { action: "deny" };
  });

  // A local dashboard has no business asking for the camera, the microphone or
  // your location. Denying by default beats prompting for something that should
  // never be requested.
  contents.session.setPermissionRequestHandler((_wc, _permission, done) => done(false));
});

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    title: "ai2nao",
    // show:false + ready-to-show avoids the white flash before first paint.
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // No preload: the shell has nothing to say to the page. Adding one later
      // means deciding what to expose — keep the surface at zero until then.
    },
  });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    mainWindow = null;
  });
  return win;
}

function revealWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    void connect();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Toggle: the hotkey should also put the window away, or it is only half a hotkey. */
function toggleWindow(): void {
  if (mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
    return;
  }
  revealWindow();
}

/* ------------------------------------------------------------------ *
 * Connect — one probe, six outcomes, six different things to say
 * ------------------------------------------------------------------ */
function pageFor(result: ProbeResult): string {
  switch (result.kind) {
    case "not-running":
      return notRunningPage();
    case "port-taken":
      return portTakenPage({ host: result.host, port: result.port });
    case "incompatible":
      return incompatiblePage({ theirs: result.theirs, ours: result.ours });
    case "schema-mismatch":
      return schemaMismatchPage({ theirs: result.theirs, ours: result.ours });
    case "timeout":
      return timeoutPage({ host: result.host, port: result.port });
    case "attached":
      return result.url;
  }
}

async function connect(): Promise<void> {
  const result = await probeDaemon();
  attachedUrl = result.kind === "attached" ? result.url : null;
  // Say why we are showing what we are showing. A shell that silently renders a
  // guidance page leaves you with nothing to search for when it is wrong.
  console.error(`[ai2nao] probe → ${result.kind}: ${trayStatusLabel(result)}`);

  if (mainWindow === null || mainWindow.isDestroyed()) mainWindow = createWindow();
  await mainWindow.loadURL(pageFor(result));

  if (result.kind === "attached") startNotifyLoop();
  else stopNotifyLoop();

  refreshTrayMenu(result);
}

/* ------------------------------------------------------------------ *
 * Notifications
 * ------------------------------------------------------------------ */
function show(n: ShellNotification): void {
  if (!Notification.isSupported()) {
    console.error(`[ai2nao] notifications unsupported, dropped: ${n.title}`);
    return;
  }
  console.error(`[ai2nao] notify (${n.kind}): ${n.title} — ${n.body}`);
  new Notification({ title: n.title, body: n.body }).show();
}

function startNotifyLoop(): void {
  if (notifyTimer !== null) return;
  // Reset on every (re)attach: a fresh connection re-baselines rather than
  // reporting whatever piled up while we were disconnected.
  notifyState = emptyNotifyState();
  pollClock = emptyPollClock();
  const tick = async (): Promise<void> => {
    if (attachedUrl === null) return;
    const out = await pollOnce({
      baseUrl: attachedUrl,
      state: notifyState,
      clock: pollClock,
      now: Date.now(),
    });
    notifyState = out.state;
    pollClock = out.clock;
    for (const n of out.notifications) show(n);
  };
  void tick();
  notifyTimer = setInterval(() => void tick(), RUN_POLL_MS);
}

function stopNotifyLoop(): void {
  if (notifyTimer === null) return;
  clearInterval(notifyTimer);
  notifyTimer = null;
}

/* ------------------------------------------------------------------ *
 * Tray — the "it is still there" surface
 * ------------------------------------------------------------------ */
function trayStatusLabel(result: ProbeResult): string {
  switch (result.kind) {
    case "attached":
      return `已连接 ${result.url}`;
    case "not-running":
      return "daemon 未运行";
    case "port-taken":
      return `${result.port} 被别的程序占用`;
    case "incompatible":
      return `版本不兼容 (${result.theirs} vs ${result.ours})`;
    case "schema-mismatch":
      return `schema 不一致 (${result.theirs} vs ${result.ours})`;
    case "timeout":
      return "daemon 无响应";
  }
}

function refreshTrayMenu(result: ProbeResult): void {
  if (tray === null) return;
  tray.setToolTip(`ai2nao —— ${trayStatusLabel(result)}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: trayStatusLabel(result), enabled: false },
      { type: "separator" },
      { label: "显示窗口", click: () => revealWindow() },
      { label: "重新连接", click: () => void connect() },
      { type: "separator" },
      { label: `快捷键 ${SHORTCUT}`, enabled: false },
      { type: "separator" },
      { label: "退出 ai2nao 壳（daemon 继续运行）", click: () => app.quit() },
    ])
  );
}

function createTray(): void {
  // An empty image gives a text-only menubar entry on macOS rather than a broken
  // icon slot. Replacing this with real artwork is a design task, not a blocker.
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("ai2nao");
  tray.on("click", () => revealWindow());
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */
async function main(): Promise<void> {
  await app.whenReady();

  createTray();

  if (!globalShortcut.register(SHORTCUT, toggleWindow)) {
    // Returns false when another app already owns the combination. Say so —
    // silently having no hotkey is exactly how "it works sometimes" bugs start.
    console.error(`Could not register ${SHORTCUT}; another app probably owns it.`);
  }

  await connect();

  // Closing the last window must NOT quit: staying resident is the entire point.
  app.on("window-all-closed", () => {
    /* keep running in the tray */
  });

  app.on("activate", () => revealWindow());

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    stopNotifyLoop();
  });
}
