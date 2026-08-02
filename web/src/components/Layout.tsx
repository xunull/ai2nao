import {
  FormEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { ChevronRight, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { ScrollToTop } from "./ScrollToTop";
import {
  NAV_GROUPS,
  PRIMARY_ITEMS,
  SETTINGS_ITEM,
  resolveNav,
  type NavGroup,
  type NavItem,
} from "./navModel";

const sidebarStorageKey = "ai2nao.sidebar.collapsed";
const expandedSidebarWidth = 248;
const collapsedSidebarWidth = 64;

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

/**
 * 默认展开。
 *
 * 此前是「窗口窄于 1440px 就默认收起」。那在浏览器里是个启发式,在桌面应用里是个
 * 常量:BrowserWindow 默认 1280 宽、最小 960,**永远小于 1440**。于是桌面版每一个
 * 新用户第一次打开看到的都是收起态 —— 一列 41 个无标签图标,其中 8 个字形还是重
 * 复的,只能靠 hover 出 tooltip 才能分辨。
 *
 * 收起态仍然在,手动切换照旧记进 localStorage。变的只是没有人选过时给什么。
 */
function initialSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return readStoredSidebarCollapsed() ?? false;
}


/**
 * 一行导航链接。展开时有文字,收起时只有图标 + tooltip。
 *
 * `active` 是传进来的,不用 NavLink 自己的 isActive:有 tabs 的条目(比如「最近工作」)
 * 在 /dashboard/tokens 上也必须保持高亮,而 NavLink 只认自己那条 `to`。判定统一走
 * navModel.resolveNav,那里有测试。
 *
 * 因此这里用 Link 而不是 NavLink。NavLink 会把 `aria-current` 也接管掉 —— 它只在
 * **自己**判定 active 时才输出这个属性,于是在 /chrome-downloads、/codex-history 这些
 * tab 路由上,视觉高亮是对的(class 是我算的)而 aria-current 被悄悄抹掉。丢的恰好
 * 是最需要它的那一批。
 */
function NavRow({
  item,
  collapsed,
  active,
}: {
  item: NavItem;
  collapsed: boolean;
  active: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      title={item.label}
      aria-label={collapsed ? item.label : undefined}
      aria-current={active ? "page" : undefined}
      className={`group relative flex items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus)] ${
        collapsed ? "h-9 w-full justify-center" : "h-8 gap-2.5 px-2"
      } ${
        active
          ? "bg-[var(--sidebar-active)] font-medium text-[var(--sidebar-active-text)]"
          : "text-[var(--sidebar-link)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--fg)]"
      }`}
    >
      {active ? (
        <span className="absolute bottom-1.5 left-0.5 top-1.5 w-0.5 rounded-full bg-[var(--sidebar-accent)]" />
      ) : null}
      <Icon
        aria-hidden="true"
        className={`h-[15px] w-[15px] shrink-0 ${
          active ? "text-[var(--sidebar-accent)]" : "text-[var(--sidebar-muted)] group-hover:text-[var(--fg)]"
        }`}
      />
      {collapsed ? null : <span className="truncate text-[13px]">{item.label}</span>}
    </Link>
  );
}

/**
 * 手风琴的组头。
 *
 * 收起态下只有图标 —— 但这比改造前好:那时候组头是一条 1px 的匿名横线,六个组的名字
 * 全丢了。现在至少有一个字形和 tooltip,而且 navModel 有测试钉着图标不重复。
 */
function NavGroupHeader({
  group,
  open,
  collapsed,
  onToggle,
}: {
  group: NavGroup;
  open: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const Icon = group.icon;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      title={group.label}
      aria-label={collapsed ? group.label : undefined}
      className={`group flex w-full items-center rounded-lg text-[var(--sidebar-muted)] outline-none transition-colors hover:bg-[var(--sidebar-hover)] hover:text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus)] ${
        collapsed ? "h-9 justify-center" : "h-8 gap-2.5 px-2"
      }`}
    >
      <Icon aria-hidden="true" className="h-[15px] w-[15px] shrink-0" />
      {collapsed ? null : (
        <>
          <span className="flex-1 truncate text-left text-[11px] font-semibold tracking-wide">
            {group.label}
          </span>
          <ChevronRight
            aria-hidden="true"
            className={`h-3.5 w-3.5 shrink-0 transition-transform duration-150 ${
              open ? "rotate-90" : ""
            }`}
          />
        </>
      )}
    </button>
  );
}

/**
 * 页内 tab。
 *
 * 承担的是「17 个原本占着侧栏一行的视图」的落脚点。刻意做成一排链接而不是把页面
 * 组件合并:那些页面 420-957 行不等,合并的收益为零而风险很实在。tab 是导航,不是
 * 组件结构 —— 所以路由和页面一行没动。
 */
function SubNav({ tabs, frameClass }: { tabs: { to: string; label: string }[]; frameClass: string }) {
  if (tabs.length === 0) return null;
  return (
    <div className="border-b border-[var(--border)] bg-[var(--bg)]">
      <div className={`${frameClass} flex h-11 items-center gap-1`}>
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end
            className={({ isActive }) =>
              `relative flex h-11 items-center px-3 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus)] ${
                isActive
                  ? "font-medium text-[var(--fg)]"
                  : "text-[var(--muted)] hover:text-[var(--fg)]"
              }`
            }
          >
            {({ isActive }) => (
              <>
                {tab.label}
                {isActive ? (
                  <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-[var(--sidebar-accent)]" />
                ) : null}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState(initialSidebarCollapsed);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const frameClass = "mx-auto max-w-[1760px] px-8";
  const sidebarWidth = collapsed ? collapsedSidebarWidth : expandedSidebarWidth;

  const match = resolveNav(pathname);

  /*
   * 手风琴:同一时刻只展开一个组。
   *
   * 24 个条目全摊开是 988px,而可见高度 609px —— 光靠分组和合并还是放不下。只展开
   * 当前所在的那组之后最坏是 6 个组头 + 5 项 = 418px,一屏有富余。
   *
   * 跟随路由用的是 React 官方的「渲染期修正 state」写法而不是 useEffect:从 ⌘K 搜索
   * 结果跳到另一个组时,侧栏必须当场跟过去,而 effect 会晚一帧 —— 表现为展开的组闪
   * 一下才换。用户手动点开的组保留到下一次跨组跳转为止。
   */
  const [openGroupId, setOpenGroupId] = useState<string | null>(match.groupId);
  const [lastGroupId, setLastGroupId] = useState<string | null>(match.groupId);
  if (match.groupId !== lastGroupId) {
    setLastGroupId(match.groupId);
    if (match.groupId !== null) setOpenGroupId(match.groupId);
  }

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
          {PRIMARY_ITEMS.map((item) => (
            <NavRow
              key={item.to}
              item={item}
              collapsed={collapsed}
              active={match.item?.to === item.to}
            />
          ))}
          {NAV_GROUPS.map((group) => (
            <div key={group.id} className="space-y-0.5 pt-1">
              <NavGroupHeader
                group={group}
                open={openGroupId === group.id}
                collapsed={collapsed}
                onToggle={() => setOpenGroupId(openGroupId === group.id ? null : group.id)}
              />
              {openGroupId === group.id
                ? group.items.map((item) => (
                    <NavRow
                      key={item.to}
                      item={item}
                      collapsed={collapsed}
                      active={match.item?.to === item.to}
                    />
                  ))
                : null}
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
          <NavRow
            item={SETTINGS_ITEM}
            collapsed={collapsed}
            active={match.item?.to === SETTINGS_ITEM.to}
          />
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
        <SubNav tabs={match.tabs} frameClass={frameClass} />
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
