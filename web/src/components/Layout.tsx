import {
  FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AppWindowMac,
  Archive,
  BarChart3,
  Beer,
  Bot,
  BotMessageSquare,
  Boxes,
  BrainCircuit,
  Bug,
  CalendarClock,
  CircleDot,
  Command,
  Database,
  Download,
  FolderCode,
  GitBranch,
  GitCommit,
  GitFork,
  TrendingUp,
  Globe,
  HardDrive,
  History,
  LayoutDashboard,
  MessageSquareText,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Radar,
  Search,
  Shield,
  ShieldCheck,
  Tags,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";

type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  matchChildren?: boolean;
};

type NavGroup = {
  id: string;
  label: string;
  icon: LucideIcon;
  items: NavItem[];
};

const primaryNavItems: NavItem[] = [
  { to: "/ai-chat", label: "AI 对话", icon: BrainCircuit },
];

const navGroups: NavGroup[] = [
  {
    id: "workbench",
    label: "工作台",
    icon: LayoutDashboard,
    items: [
      { to: "/dashboard", label: "最近工作", icon: LayoutDashboard },
      { to: "/dashboard/tokens", label: "Token 排行", icon: BarChart3 },
      { to: "/dashboard/tokens-trend", label: "Token 趋势", icon: TrendingUp },
      { to: "/work-recap", label: "工作回看", icon: GitCommit },
    ],
  },
  {
    id: "local-assets",
    label: "本机资产",
    icon: HardDrive,
    items: [
      { to: "/repos", label: "仓库", icon: Archive, matchChildren: true },
      { to: "/scheduler", label: "定时任务", icon: CalendarClock },
      { to: "/downloads", label: "下载", icon: Download },
      { to: "/apps", label: "Mac 应用", icon: AppWindowMac },
      { to: "/vscode", label: "VS Code", icon: FolderCode },
      { to: "/cursor-projects", label: "Cursor 项目", icon: GitBranch },
      { to: "/brew", label: "Homebrew", icon: Beer },
      { to: "/huggingface-models", label: "HF 模型", icon: Boxes },
      { to: "/lmstudio-models", label: "LM Studio", icon: BrainCircuit },
      { to: "/atuin", label: "Atuin", icon: Terminal },
      { to: "/atuin/directories", label: "Atuin 目录", icon: Database },
    ],
  },
  {
    id: "browser",
    label: "浏览器",
    icon: Globe,
    items: [
      { to: "/chrome-history", label: "Chrome 历史", icon: History },
      { to: "/chrome-history/domains", label: "Chrome 域名", icon: Search },
      { to: "/chrome-downloads", label: "Chrome 下载", icon: Download },
    ],
  },
  {
    id: "ai-conversations",
    label: "AI 记录",
    icon: MessageSquareText,
    items: [
      { to: "/cherry-studio-history", label: "Cherry 对话", icon: MessageSquareText, matchChildren: true },
      { to: "/cursor-history", label: "Cursor 对话", icon: BotMessageSquare, matchChildren: true },
      { to: "/claude-code-history", label: "Claude", icon: Bot, matchChildren: true },
      { to: "/codex-history", label: "Codex", icon: Command, matchChildren: true },
    ],
  },
  {
    id: "ai-tools",
    label: "AI 工具",
    icon: Wrench,
    items: [
      { to: "/bash-permissions", label: "Shell 权限", icon: ShieldCheck },
      { to: "/bash-sandbox", label: "Shell 沙箱", icon: Shield },
      { to: "/rag-status", label: "RAG 状态", icon: Package },
      { to: "/rag-debug", label: "RAG 调试", icon: Bug },
    ],
  },
  {
    id: "github-open-source",
    label: "GitHub/开源",
    icon: GitFork,
    items: [
      { to: "/github", label: "GitHub", icon: GitBranch },
      { to: "/github/radar", label: "开源雷达", icon: Radar },
      { to: "/github/tags", label: "Star Tag", icon: Tags },
    ],
  },
];

const sidebarStorageKey = "ai2nao.sidebar.collapsed";
const narrowDesktopQuery = "(max-width: 1439px)";
const expandedSidebarWidth = 248;
const collapsedSidebarWidth = 64;

function hasExplicitSidebarPreference(): boolean {
  try {
    return window.localStorage.getItem(sidebarStorageKey) !== null;
  } catch {
    return false;
  }
}

function readStoredSidebarCollapsed(): boolean | null {
  try {
    const raw = window.localStorage.getItem(sidebarStorageKey);
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    return null;
  }
  return null;
}

function isNarrowDesktop(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function") {
    return window.matchMedia(narrowDesktopQuery).matches;
  }
  return window.innerWidth <= 1439;
}

function initialSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  const stored = readStoredSidebarCollapsed();
  if (stored !== null) return stored;
  return !hasExplicitSidebarPreference() && isNarrowDesktop();
}

function itemMatchesPath(pathname: string, to: string): boolean {
  if (pathname === to) return true;
  return pathname.startsWith(`${to}/`);
}

function navItemMatchesPath(pathname: string, item: NavItem): boolean {
  return item.matchChildren
    ? itemMatchesPath(pathname, item.to)
    : pathname === item.to;
}

function getActivePrimaryItem(pathname: string): NavItem | null {
  return primaryNavItems.find((item) => navItemMatchesPath(pathname, item)) ?? null;
}

function getRouteGroupId(pathname: string): string | null {
  return navGroups.find((group) =>
    group.items.some((item) => navItemMatchesPath(pathname, item))
  )?.id ?? null;
}

function initialActiveGroupId(pathname: string): string | null {
  if (getActivePrimaryItem(pathname)) return null;
  return getRouteGroupId(pathname) ?? navGroups[0].id;
}

export function Layout({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  const location = useLocation();
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState(initialSidebarCollapsed);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(() => initialActiveGroupId(location.pathname));
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const frameClass = "mx-auto max-w-[1760px] px-8";
  const sidebarWidth = collapsed ? collapsedSidebarWidth : expandedSidebarWidth;
  const activePrimaryItem = getActivePrimaryItem(location.pathname);
  const activeRouteGroupId = getRouteGroupId(location.pathname);
  const activeGroup = activeGroupId ? navGroups.find((group) => group.id === activeGroupId) ?? navGroups[0] : null;
  const activePrimaryPanelItem = activeGroupId === null ? activePrimaryItem : null;
  const PanelIcon = activePrimaryPanelItem?.icon ?? activeGroup?.icon ?? navGroups[0].icon;

  useEffect(() => {
    const nextPrimaryItem = getActivePrimaryItem(location.pathname);
    if (nextPrimaryItem) {
      setActiveGroupId(null);
      return;
    }
    const nextGroupId = getRouteGroupId(location.pathname);
    if (nextGroupId) {
      setActiveGroupId(nextGroupId);
    }
  }, [location.pathname]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const t = q.trim();
    if (!t) return;
    nav(`/search?q=${encodeURIComponent(t)}`);
  }

  function setSidebarCollapsed(next: boolean) {
    setCollapsed(next);
    try {
      window.localStorage.setItem(sidebarStorageKey, String(next));
    } catch {
      // Keep the in-memory state even when storage is unavailable.
    }
  }

  function openSearch() {
    setSidebarCollapsed(false);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }

  function selectGroup(groupId: string) {
    setActiveGroupId(groupId);
    setSidebarCollapsed(false);
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-[var(--fg)] focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        跳过导航
      </a>
      <aside
        className="fixed inset-y-0 left-0 z-40 flex border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)] shadow-[var(--sidebar-shadow)] transition-[width] duration-200 ease-out"
        data-state={collapsed ? "collapsed" : "expanded"}
        style={{ width: sidebarWidth }}
      >
        <div className="flex w-16 shrink-0 flex-col border-r border-[var(--sidebar-rail-border)] bg-[var(--sidebar-rail)]">
          <div className="flex min-h-[72px] items-center justify-center px-2">
            <Link
              to="/dashboard"
              className="group flex h-11 w-11 items-center justify-center rounded-2xl text-[var(--fg)] outline-none transition-colors hover:bg-[var(--sidebar-hover)] focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus)]"
              aria-label="ai2nao 本机工作台"
              title="ai2nao"
            >
              <span className="relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[14px] border border-[var(--sidebar-mark-border)] bg-[var(--sidebar-mark)] text-[13px] font-semibold tracking-tight text-[var(--fg)] shadow-[var(--sidebar-mark-shadow)]">
                a2
                <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--sidebar-bg)] bg-[var(--sidebar-status)]" />
              </span>
            </Link>
          </div>

          <div className="px-2 pb-3">
            <button
              type="button"
              className="flex h-10 w-full items-center justify-center rounded-xl border border-transparent text-[var(--sidebar-muted)] outline-none transition-colors hover:border-[var(--sidebar-hover-border)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus)]"
              aria-label="打开全站搜索"
              title="全站搜索"
              onClick={openSearch}
            >
              <Search aria-hidden="true" className="h-[18px] w-[18px]" />
            </button>
          </div>

          <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-1" aria-label="工作域">
            <div className="space-y-2" role="list" aria-label="主要入口与工作域">
              {primaryNavItems.map((item) => {
                const ItemIcon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={!item.matchChildren}
                    className={({ isActive }) =>
                      `relative flex h-10 w-full items-center justify-center rounded-2xl border outline-none transition-all duration-150 focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus)] ${
                        isActive
                          ? "border-[var(--sidebar-active-border)] bg-[var(--sidebar-active)] text-[var(--sidebar-active-text)] shadow-[var(--sidebar-active-shadow)]"
                          : "border-transparent text-[var(--sidebar-muted)] hover:border-[var(--sidebar-hover-border)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--fg)]"
                      }`
                    }
                    title={item.label}
                    aria-label={`打开${item.label}`}
                    onClick={() => setActiveGroupId(null)}
                  >
                    {({ isActive }) => (
                      <>
                        {isActive ? (
                          <span className="absolute left-1 h-5 w-1 rounded-full bg-[var(--sidebar-accent)]" />
                        ) : null}
                        <ItemIcon aria-hidden="true" className="h-[18px] w-[18px]" />
                      </>
                    )}
                  </NavLink>
                );
              })}
              {navGroups.map((group) => {
                const GroupIcon = group.icon;
                const routeActive = activeRouteGroupId === group.id;
                const selected = activeGroupId === group.id;
                return (
                  <button
                    key={group.id}
                    type="button"
                    className={`relative flex h-10 w-full items-center justify-center rounded-2xl border outline-none transition-all duration-150 focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus)] ${
                      selected
                        ? "border-[var(--sidebar-active-border)] bg-[var(--sidebar-active)] text-[var(--sidebar-active-text)] shadow-[var(--sidebar-active-shadow)]"
                        : "border-transparent text-[var(--sidebar-muted)] hover:border-[var(--sidebar-hover-border)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--fg)]"
                    }`}
                    title={group.label}
                    aria-label={`切换到${group.label}`}
                    aria-pressed={selected}
                    onClick={() => selectGroup(group.id)}
                  >
                    {routeActive ? (
                      <span className="absolute left-1 h-5 w-1 rounded-full bg-[var(--sidebar-accent)]" />
                    ) : null}
                    <GroupIcon aria-hidden="true" className="h-[18px] w-[18px]" />
                  </button>
                );
              })}
            </div>
          </nav>

          <div className="border-t border-[var(--sidebar-rail-border)] p-2">
            <div className="mb-2 flex h-8 items-center justify-center" title="本机索引在线">
              <span className="h-2 w-2 rounded-full bg-[var(--sidebar-status)] shadow-[0_0_0_4px_var(--sidebar-status-ring)]" />
            </div>
            <button
              type="button"
              className="flex h-10 w-full items-center justify-center rounded-xl border border-[var(--sidebar-control-border)] bg-[var(--sidebar-control)] text-[var(--sidebar-link)] outline-none transition-colors hover:border-[var(--sidebar-hover-border)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus)]"
              aria-expanded={!collapsed}
              aria-label={collapsed ? "展开侧边导航" : "收起侧边导航"}
              title={collapsed ? "展开侧边导航" : "收起侧边导航"}
              onClick={() => setSidebarCollapsed(!collapsed)}
            >
              {collapsed ? (
                <PanelLeftOpen aria-hidden="true" className="h-[18px] w-[18px]" />
              ) : (
                <PanelLeftClose aria-hidden="true" className="h-[18px] w-[18px]" />
              )}
            </button>
          </div>
        </div>

        {!collapsed ? (
          <div className="flex min-w-0 flex-1 flex-col bg-[var(--sidebar-panel)]">
            <div className="px-4 pb-3 pt-5">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-2xl border border-[var(--sidebar-panel-icon-border)] bg-[var(--sidebar-panel-icon)] text-[var(--sidebar-active-text)]">
                  <PanelIcon aria-hidden="true" className="h-[18px] w-[18px]" />
                </span>
                <div className="min-w-0">
                  {activePrimaryPanelItem ? (
                    <p className="truncate text-[15px] font-semibold leading-5 text-[var(--fg)]">
                      {activePrimaryPanelItem.label}
                    </p>
                  ) : (
                    <h2 className="truncate text-[15px] font-semibold leading-5 text-[var(--fg)]">
                      {activeGroup?.label}
                    </h2>
                  )}
                  <p className="truncate text-[11px] font-medium text-[var(--sidebar-muted)]">
                    {activePrimaryPanelItem ? "独立工作台" : `${activeGroup?.items.length ?? 0} 个入口`}
                  </p>
                </div>
              </div>

              <form
                onSubmit={onSubmit}
                className="group relative mt-4 flex h-10 items-center rounded-2xl border border-[var(--sidebar-control-border)] bg-[var(--sidebar-control)] px-3 shadow-[var(--sidebar-control-shadow)] transition-colors focus-within:border-[var(--sidebar-focus-border)] focus-within:ring-2 focus-within:ring-[var(--sidebar-focus)]"
              >
                <Search aria-hidden="true" className="mr-2 h-4 w-4 shrink-0 text-[var(--sidebar-muted)]" />
                <label className="sr-only" htmlFor="global-search">
                  全站搜索
                </label>
                <input
                  id="global-search"
                  ref={searchInputRef}
                  className="min-w-0 flex-1 bg-transparent text-sm text-[var(--fg)] outline-none placeholder:text-[var(--sidebar-muted)]"
                  placeholder="搜索本机数据"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
                <kbd className="ml-2 rounded-md border border-[var(--sidebar-kbd-border)] bg-[var(--sidebar-kbd)] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[var(--sidebar-muted)]">
                  ⌘K
                </kbd>
                <button type="submit" className="sr-only">
                  搜索
                </button>
              </form>
            </div>

            {activePrimaryPanelItem ? (
              <div className="min-h-0 flex-1" />
            ) : (
              <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-4" aria-label="全站导航">
                <div className="space-y-1.5">
                  {(activeGroup?.items ?? []).map((item) => {
                  const ItemIcon = item.icon;
                  return (
                    <NavLink
                      key={item.to}
                      className={({ isActive }) =>
                        `group relative flex min-h-10 min-w-0 items-center gap-2 rounded-2xl border px-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus)] ${
                          isActive
                            ? "border-[var(--sidebar-active-border)] bg-[var(--sidebar-active)] font-semibold text-[var(--sidebar-active-text)] shadow-[var(--sidebar-active-shadow)]"
                            : "border-transparent text-[var(--sidebar-link)] hover:border-[var(--sidebar-hover-border)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--fg)]"
                        }`
                      }
                      to={item.to}
                      end={!item.matchChildren}
                      title={item.label}
                    >
                      {({ isActive }) => (
                        <>
                          {isActive ? (
                            <span className="absolute left-1.5 h-5 w-1 rounded-full bg-[var(--sidebar-accent)]" />
                          ) : null}
                          <ItemIcon
                            aria-hidden="true"
                            className={`h-4 w-4 shrink-0 ${
                              isActive
                                ? "ml-2 text-[var(--sidebar-accent)]"
                                : "text-[var(--sidebar-muted)] group-hover:text-[var(--fg)]"
                            }`}
                          />
                          <span className="truncate">{item.label}</span>
                        </>
                      )}
                    </NavLink>
                  );
                  })}
                </div>
              </nav>
            )}

            <div className="border-t border-[var(--sidebar-border)] px-4 py-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-[var(--fg)]">
                <CircleDot aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sidebar-status)]" />
                <span className="truncate">本机索引在线</span>
              </div>
            </div>
          </div>
        ) : null}
      </aside>

      <div
        className="min-h-screen transition-[margin-left] duration-200 ease-out"
        style={{ marginLeft: sidebarWidth }}
      >
        <main id="main-content" tabIndex={-1} className={`${frameClass} w-full py-5`}>
          {children}
        </main>
      </div>
    </div>
  );
}
