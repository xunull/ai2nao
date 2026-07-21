import {
  FormEvent,
  type ReactNode,
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
  Clapperboard,
  Command,
  Database,
  Download,
  FolderCode,
  GitBranch,
  GitCommit,
  GitCompare,
  GitFork,
  Gauge,
  Settings as SettingsIcon,
  TrendingUp,
  Globe,
  HardDrive,
  History,
  LayoutDashboard,
  MessageSquareText,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Radar,
  Search,
  Shield,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Tags,
  Terminal,
  Waves,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { ScrollToTop } from "./ScrollToTop";

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

// Settings is a standalone page like the primary items (its own "workspace",
// no sub-list), but it's pinned to the BOTTOM of the rail by convention
// (VS Code / Linear / Slack), not rendered in the top rail loop.
const settingsItem: NavItem = { to: "/settings", label: "设置", icon: SettingsIcon };

const navGroups: NavGroup[] = [
  {
    id: "workbench",
    label: "工作台",
    icon: LayoutDashboard,
    items: [
      { to: "/dashboard", label: "最近工作", icon: LayoutDashboard },
      { to: "/dashboard/tokens", label: "Token 排行", icon: BarChart3 },
      { to: "/dashboard/tokens-trend", label: "Token 趋势", icon: TrendingUp },
      { to: "/dashboard/project-output", label: "产出效率", icon: Gauge },
      { to: "/work-recap", label: "工作回看", icon: GitCommit },
      { to: "/dashboard/cosmos", label: "对话宇宙", icon: Sparkles },
      { to: "/topics/river", label: "主题河流", icon: Waves },
      { to: "/providers", label: "外部平台", icon: Plug },
      { to: "/agent-messages", label: "对话搜索", icon: Search },
      { to: "/ai-rhythm", label: "AI 节律", icon: CalendarClock },
      { to: "/commit-bridge", label: "对话↔提交", icon: GitCompare },
      { to: "/replay", label: "那天回放", icon: Clapperboard },
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
      { to: "/ai-tools", label: "AI 工具清单", icon: Wrench },
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
      { to: "/opencode-history", label: "opencode", icon: SquareTerminal, matchChildren: true },
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


/** One nav link — labeled row when expanded, icon-only (tooltip) when collapsed. */
function NavRow({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={!item.matchChildren}
      title={item.label}
      aria-label={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        `group relative flex items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus)] ${
          collapsed ? "h-9 w-full justify-center" : "h-8 gap-2.5 px-2"
        } ${
          isActive
            ? "bg-[var(--sidebar-active)] font-medium text-[var(--sidebar-active-text)]"
            : "text-[var(--sidebar-link)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--fg)]"
        }`
      }
    >
      {({ isActive }) => (
        <>
          {isActive ? (
            <span className="absolute bottom-1.5 left-0.5 top-1.5 w-0.5 rounded-full bg-[var(--sidebar-accent)]" />
          ) : null}
          <Icon
            aria-hidden="true"
            className={`h-[15px] w-[15px] shrink-0 ${
              isActive ? "text-[var(--sidebar-accent)]" : "text-[var(--sidebar-muted)] group-hover:text-[var(--fg)]"
            }`}
          />
          {collapsed ? null : <span className="truncate text-[13px]">{item.label}</span>}
        </>
      )}
    </NavLink>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState(initialSidebarCollapsed);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const frameClass = "mx-auto max-w-[1760px] px-8";
  const sidebarWidth = collapsed ? collapsedSidebarWidth : expandedSidebarWidth;

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

  return (
    <div className="h-screen overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-[var(--fg)] focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        跳过导航
      </a>
      <aside
        className="fixed inset-y-0 left-0 z-40 flex flex-col border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)] shadow-[var(--sidebar-shadow)] transition-[width] duration-200 ease-out"
        data-state={collapsed ? "collapsed" : "expanded"}
        style={{ width: sidebarWidth }}
      >
        <div className="flex items-center gap-2.5 px-3 py-3.5">
          <Link
            to="/dashboard"
            aria-label="ai2nao 本机工作台"
            title="ai2nao"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-[var(--sidebar-mark-border)] bg-[var(--sidebar-mark)] text-[12px] font-semibold text-[var(--fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus)]"
          >
            a2
          </Link>
          {collapsed ? null : (
            <span className="truncate text-sm font-semibold tracking-tight text-[var(--fg)]">ai2nao</span>
          )}
        </div>

        {collapsed ? (
          <div className="px-2 pb-1">
            <button
              type="button"
              onClick={openSearch}
              aria-label="打开全站搜索"
              title="全站搜索"
              className="flex h-9 w-full items-center justify-center rounded-lg text-[var(--sidebar-muted)] outline-none transition-colors hover:bg-[var(--sidebar-hover)] hover:text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus)]"
            >
              <Search aria-hidden="true" className="h-[18px] w-[18px]" />
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="px-2 pb-1">
            <div className="group flex h-9 items-center rounded-lg border border-[var(--sidebar-control-border)] bg-[var(--sidebar-control)] px-2.5 transition-colors focus-within:border-[var(--sidebar-focus-border)] focus-within:ring-2 focus-within:ring-[var(--sidebar-focus)]">
              <Search aria-hidden="true" className="mr-2 h-4 w-4 shrink-0 text-[var(--sidebar-muted)]" />
              <label className="sr-only" htmlFor="global-search">全站搜索</label>
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
              <button type="submit" className="sr-only">搜索</button>
            </div>
          </form>
        )}

        <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3 pt-1" aria-label="全站导航">
          {primaryNavItems.map((item) => (
            <NavRow key={item.to} item={item} collapsed={collapsed} />
          ))}
          {navGroups.map((group) => (
            <div key={group.id} className="space-y-0.5">
              {collapsed ? (
                <div className="mx-2 my-1.5 h-px bg-[var(--sidebar-rail-border)]" aria-hidden="true" />
              ) : (
                <div className="px-2 pb-1 pt-3 text-[11px] font-semibold tracking-wide text-[var(--sidebar-muted)]">
                  {group.label}
                </div>
              )}
              {group.items.map((item) => (
                <NavRow key={item.to} item={item} collapsed={collapsed} />
              ))}
            </div>
          ))}
        </nav>

        <div className="space-y-0.5 border-t border-[var(--sidebar-border)] p-2">
          {collapsed ? null : (
            <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] font-medium text-[var(--sidebar-muted)]">
              <span className="h-2 w-2 rounded-full bg-[var(--sidebar-status)]" />
              本机索引在线
            </div>
          )}
          <NavRow item={settingsItem} collapsed={collapsed} />
          <button
            type="button"
            onClick={() => setSidebarCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "展开侧边导航" : "收起侧边导航"}
            title={collapsed ? "展开侧边导航" : "收起侧边导航"}
            className={`group flex items-center rounded-lg text-[var(--sidebar-muted)] outline-none transition-colors hover:bg-[var(--sidebar-hover)] hover:text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus)] ${
              collapsed ? "h-9 w-full justify-center" : "h-8 gap-2.5 px-2"
            }`}
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden="true" className="h-[15px] w-[15px]" />
            ) : (
              <>
                <PanelLeftClose aria-hidden="true" className="h-[15px] w-[15px] shrink-0" />
                <span className="truncate text-[13px]">收起</span>
              </>
            )}
          </button>
        </div>
      </aside>

      <div
        className="flex h-screen flex-col transition-[margin-left] duration-200 ease-out"
        style={{ marginLeft: sidebarWidth }}
      >
        <ScrollToTop containerRef={scrollRef} />
        <main
          ref={scrollRef}
          id="main-content"
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className={`${frameClass} w-full py-5`}>{children}</div>
        </main>
      </div>
    </div>
  );
}
