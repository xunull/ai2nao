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
  RETRY_URL,
  schemaMismatchPage,
  timeoutPage,
} from "./guidance.js";
import { TRAY_ICON_DATA_URLS } from "./trayIcon.generated.js";
import { autoStartDisabled, spawnDaemon, stopDaemon } from "./daemonProcess.js";

/**
 * ai2nao 桌面应用 —— 它会启动后台服务，但不拥有它。
 *
 * ## 一条规则，其余都是它的推论
 *
 * 「启动一体化」和「生命周期一体化」是两件事，别合并:
 *
 *   启动一体化   双击一个图标，整套东西起来           ← 做（ensureDaemon）
 *   生命周期一体 退出 app 就把后台一起杀掉             ← 不做
 *
 * `serve` 不只是界面的后端。它同时托管 `/mcp`（Claude Code / Codex 这些 agent 连着
 * 它查你的开发数据，src/serve/app.ts）和 27 个定时任务。关掉窗口就把它们带走，
 * 「常驻」这条诉求当场消失 —— 而那是做这个应用的头号理由。所以 daemon 用
 * detached spawn 脱离本进程组；要停它，菜单栏里有单独一条。
 *
 * ## 通知只在这个窗口活着的时候存在
 *
 * 刻意如此（决议 4B）。没有 daemon 侧的队列，也没有 osascript 兜底:壳没跑就不发。
 * 换来的是通知由 Electron 发出，署名是 ai2nao 自己 —— 而那是四件诉求之一。
 *
 * 通知状态只在内存里。重启就静默重建基线，而不是把你离开期间的事补弹一遍，这和
 * 「壳没跑 = 那段时间不存在」是一致的。
 *
 * ## 打包形态
 *
 * 打包后 daemon 就在 `.app` 里（`out/daemon/daemon.mjs`，esbuild 打的自包含产物），
 * 用 `ELECTRON_RUN_AS_NODE` 跑 —— Electron 自带 Node，不必再塞一个二进制。代价是
 * 原生模块要匹配 Electron 的 ABI，由 electron-builder 的 @electron/rebuild 处理
 * （better-sqlite3 因此从 v11 升到 v13:v11 的 C++ 编不过 Electron 43 的 V8）。
 */

const SHORTCUT = "CommandOrControl+Shift+Space";

/**
 * macOS 系统设置里「隐私与安全性 → 完全磁盘访问权限」那一页。
 *
 * 这是个 URL scheme,只有原生进程能打开 —— 浏览器不允许网页跳
 * x-apple.systempreferences:,所以 /attention 页面上的引导只能写文字让人自己去点。
 * 壳能直接把面板打开,这是注意力层唯一一处「壳能做而网页做不到」的事。
 */
export const FULL_DISK_ACCESS_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

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
    // 引导页上的「重新连接」。页面无脚本,所以动作只能是一次导航;在这里把它接住,
    // 转成一次 connect()。必须排在下面的白名单之前 —— 走到那里就被当成越权导航
    // 拦掉了(引导页没有 attachedUrl,origin 是 null)。
    if (navigationUrl === RETRY_URL) {
      event.preventDefault();
      void connect();
      return;
    }

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
    // SPA body 的实测底色(rgb(247,246,243))。show:false + ready-to-show 只盖住了
    // 首次绘制之前那一下,而窗口底色还有两处会露出来:重连时两个 loadURL 之间,以及
    // 拖拽改变窗口大小时新露出的区域 —— Electron 先用它填,渲染进程再补上。缺省的
    // 纯白在这两处都会闪一下。
    backgroundColor: "#f7f6f3",
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

/**
 * 端口覆盖。
 *
 * `ai2nao serve --port 8788` 一直是支持的，但壳此前只会看 8787（或实例记录里写的
 * 那个），所以换了端口的 daemon 壳根本找不到。设了这个就固定探这个端口，跳过记录
 * 查找 —— 「我明确告诉你去哪」应当压过「你自己去猜」。
 *
 * 烟雾测试也靠它把自己和开发者真实的 8787 daemon 隔开:只隔离 `AI2NAO_RUN_DIR`
 * 是不够的，没有记录时探活会回退到默认端口，于是测试会连上真实实例并断言失败。
 */
const PORT_OVERRIDE = ((): number | null => {
  const raw = (process.env.AI2NAO_SHELL_PORT ?? "").trim();
  if (raw === "") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
})();

/** 默认端口，和 `ai2nao serve --port` 一致。 */
const DEFAULT_PORT = PORT_OVERRIDE ?? 8787;

/** 探活参数:指定了端口就只探它，否则让 probeDaemon 走实例记录再回退默认端口。 */
function probeOptions(): { port?: number } {
  return PORT_OVERRIDE === null ? {} : { port: PORT_OVERRIDE };
}

/** daemon 从启动到能应答的等待上限：要跑迁移、开一个可能上百 MB 的库。 */
const DAEMON_START_TIMEOUT_MS = 30_000;
const DAEMON_POLL_MS = 400;

/**
 * 没有 daemon 就拉一个起来，然后等它应答。
 *
 * 只在 `not-running` 时启动。其余五种失败态都**不能**启动:端口被别的程序占着、
 * 版本对不上、schema 不一致、超时 —— 这些情况下再起一个只会多一个进程，问题原样
 * 还在。那时候要给的是引导页，不是又一个 daemon。
 *
 * 等待靠反复 probe，不靠固定 sleep：只有 `/api/health` 应答才算真的起来了。
 */
async function ensureDaemon(result: ProbeResult): Promise<ProbeResult> {
  if (result.kind !== "not-running") return result;
  if (autoStartDisabled()) {
    console.error("[ai2nao] 自动启动已关闭（AI2NAO_SHELL_NO_AUTOSTART）");
    return result;
  }
  if (!spawnDaemon({ port: DEFAULT_PORT })) {
    console.error("[ai2nao] 找不到可启动的 daemon（打包版应有内嵌 bundle，开发模式需先 npm run build:server）");
    return result;
  }
  console.error("[ai2nao] 未发现 daemon，正在启动…");

  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, DAEMON_POLL_MS));
    const next = await probeDaemon({ port: DEFAULT_PORT });
    // 一旦不再是「没人在听」，就该由调用方去渲染对应的页面 —— 包括它自己起失败
    // 之后端口被别人占住这种情况。
    if (next.kind !== "not-running") return next;
  }
  console.error(`[ai2nao] daemon 在 ${DAEMON_START_TIMEOUT_MS / 1000}s 内没有应答`);
  return result;
}

async function connect(): Promise<void> {
  let result = await probeDaemon(probeOptions());
  if (result.kind === "not-running") result = await ensureDaemon(result);
  attachedUrl = result.kind === "attached" ? result.url : null;
  // Say why we are showing what we are showing. A shell that silently renders a
  // guidance page leaves you with nothing to search for when it is wrong.
  console.error(`[ai2nao] probe → ${result.kind}: ${trayStatusLabel(result)}`);

  if (mainWindow === null || mainWindow.isDestroyed()) mainWindow = createWindow();
  await mainWindow.loadURL(pageFor(result));

  if (result.kind === "attached") startNotifyLoop();
  else stopNotifyLoop();

  refreshMenus(result);
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

/**
 * 三个动作,两个入口,一份定义。
 *
 * 托盘和应用菜单必须给出同一组动作、同样的措辞、同样的启用状态 —— 「停止后台服务」
 * 只有在拿得到 pid 时才可点,而 pid 只有 attached 时才有。同一份模板生成两处,是让
 * 它们不可能漂移的唯一办法。
 */
function daemonActions(result: ProbeResult): Electron.MenuItemConstructorOptions[] {
  const daemonPid = result.kind === "attached" ? result.health.pid : null;
  return [
    { label: "显示窗口", click: () => revealWindow() },
    { label: "重新连接", accelerator: "CommandOrControl+R", click: () => void connect() },
    { type: "separator" },
    {
      // 有了自动拉起,就必须有对称的关掉 —— 否则用户没有任何办法停掉一个自己
      // 从没主动启动过的后台进程。pid 来自 /api/health,不靠猜。
      label: "停止后台服务",
      enabled: daemonPid !== null,
      click: () => {
        if (daemonPid === null) return;
        stopDaemon(daemonPid);
        // 给它一点时间撤回实例记录,再刷新状态。
        setTimeout(() => void connect(), 1_200);
      },
    },
    // 注意力层读 macOS 的 knowledgeC,那需要完全磁盘访问。授权是按可执行文件授的,
    // 而 daemon 用 ELECTRON_RUN_AS_NODE 跑、与壳同一个可执行文件,所以授给这个 .app
    // 就等于授给了真正去读库的那个进程(见 desktop-app-embeds-daemon-one-program)。
    ...(process.platform === "darwin"
      ? ([
          { type: "separator" },
          {
            label: "完全磁盘访问设置…",
            click: () => {
              void shell.openExternal(FULL_DISK_ACCESS_SETTINGS_URL);
            },
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
  ];
}

/**
 * 应用菜单此前根本没设,于是 macOS 用的是 Electron 的默认菜单:Apple / ai2nao /
 * File / Edit / View / Window,里面没有一条和 ai2nao 有关的东西。三个动作全部只
 * 存在于托盘 —— 而托盘是个 16px 的字形,不是发现功能的地方。
 *
 * 角色菜单(editMenu / windowMenu)不是可选项:SPA 里要能 Cmd+C / Cmd+V,而
 * 复制粘贴在 macOS 上靠菜单项的 accelerator 生效,没有 Edit 菜单就真的没有快捷键。
 */
function refreshMenus(result: ProbeResult): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { label: "服务", submenu: daemonActions(result) },
      { role: "editMenu" },
      {
        // 自己拼而不是用 role:"viewMenu" —— 那个角色把 Cmd+R 占成「重新加载」,而
        // 「重新连接」做的是它的超集(重新探活 + 重新加载),不该让位。剩下的缩放
        // 对一个高密度数据工作台是真需要的。
        //
        // label 是显式给的:role 自带的文案跟随**系统**语言,而这个应用的界面、托盘
        // 和引导页全是中文。凡是我们自己拼的菜单就跟应用走。Edit / Window 两个整
        // 块角色菜单留给 Electron —— 手抄它们意味着重新实现 macOS 的 Speech、
        // Emoji & Symbols 这些平台专属项,不值得,代价是那两个菜单是英文。
        label: "视图",
        submenu: [
          { role: "resetZoom", label: "实际大小" },
          { role: "zoomIn", label: "放大" },
          { role: "zoomOut", label: "缩小" },
          { type: "separator" },
          { role: "togglefullscreen", label: "全屏" },
          { role: "toggleDevTools", label: "开发者工具" },
        ],
      },
      { role: "windowMenu" },
    ])
  );

  if (tray === null) return;
  tray.setToolTip(`ai2nao —— ${trayStatusLabel(result)}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: trayStatusLabel(result), enabled: false },
      { type: "separator" },
      ...daemonActions(result),
      { type: "separator" },
      { label: `快捷键 ${SHORTCUT}`, enabled: false },
      { type: "separator" },
      {
        label: "退出 ai2nao（后台服务继续运行）",
        click: () => app.quit(),
      },
    ])
  );
}

/**
 * Build the menubar glyph from the generated data URLs.
 *
 * Data URLs rather than files on purpose: a packaged `.app` has no source tree, so
 * anything that resolves an asset by relative path at runtime breaks the moment it
 * is packaged. The shell already paid for that lesson once.
 *
 * `setTemplateImage(true)` hands recolouring to macOS, which is what makes the
 * glyph correct in a light menubar, a dark one, and while the menu is open. That
 * is also why the artwork is pure black + alpha: any colour would be discarded.
 */
function trayImage(): Electron.NativeImage {
  const [first, ...rest] = TRAY_ICON_DATA_URLS;
  if (first === undefined) return nativeImage.createEmpty();
  const image = nativeImage.createFromDataURL(first.dataUrl);
  // @2x / @3x so it stays crisp on Retina instead of being upscaled from 16px.
  for (const extra of rest) {
    image.addRepresentation({ scaleFactor: extra.scale, dataURL: extra.dataUrl });
  }
  image.setTemplateImage(true);
  return image;
}

function createTray(): void {
  tray = new Tray(trayImage());
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
