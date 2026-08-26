import {
  Activity,
  AppWindowMac,
  Archive,
  Beer,
  Boxes,
  BrainCircuit,
  CalendarClock,
  CalendarDays,
  Clapperboard,
  Clock,
  Download,
  Eye,
  FolderCode,
  FolderGit2,
  Gauge,
  GitBranch,
  GitCommit,
  GitCompare,
  GitFork,
  Globe,
  House,
  HardDrive,
  History,
  Layers,
  LayoutDashboard,
  MessageSquareText,
  MessagesSquare,
  CalendarRange,
  Package,
  Plug,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Terminal,
  Waves,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/**
 * 侧栏导航的数据模型和路径解析。
 *
 * ## 为什么是这个形状
 *
 * 改造前:41 个一级入口挤在一列里,内容高 1638px 而可见高度只有 609px —— 一屏看得到
 * 36%,另外 26 个目的地只能靠滚。收起态(64px 图标)更糟:没有标签,而且 8 个图标字形
 * 被用了两次(BrainCircuit 同时是「AI 对话」和「LM Studio」,Search 三处…),那些目的
 * 地在视觉上无法区分。
 *
 * 根因不是「条目太多」,是**没有二级可去**。41 条里有一大批本来就是同一个页面的不同
 * 视图 —— /dashboard 家族 5 个入口、5 个来源的对话记录、Chrome 的 3 个视图、GitHub 的
 * 3 个视图、Shell/RAG/Atuin/模型 各 2 个。它们占着一级的位置,只是因为没别的地方放。
 *
 * 所以 `tabs`:一个条目在侧栏占一行,它的兄弟视图变成页内 tab。41 → 24。
 *
 * ## tab 不改路由,也不合并页面
 *
 * `tabs` 里放的是**已经存在的路由**,页面组件一行不动。Layout 根据当前路径渲染一条
 * 顶栏。这是刻意的:那些页面 420-957 行不等,把它们塞进一个共享外壳的收益为零,风险
 * 却很实在。tab 是导航,不是组件结构。
 *
 * 同理 AI 对话记录用 /claude-code-history 当父路径而不是新造一个 /agent-history ——
 * 后者要么破坏 5 条现有 URL,要么得配一批重定向。
 */

export type NavTab = {
  to: string;
  label: string;
};

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  /** 详情页归它,例如 /repos/633/file 归「仓库」。 */
  matchChildren?: boolean;
  /**
   * 页内 tab。约定第一个必须是条目自身 —— 从侧栏点进来时顶栏得有一项是选中的。
   * 有测试钉着这条。
   */
  tabs?: NavTab[];
};

export type NavGroup = {
  id: string;
  label: string;
  icon: LucideIcon;
  items: NavItem[];
};

export const PRIMARY_ITEMS: NavItem[] = [
  // 真正的首页。`/` 从前只是一句 Navigate,现在是「今日线索」。左上角的 a2 徽标也指向这里。
  { to: "/", label: "今天", icon: House },
  { to: "/ai-chat", label: "AI 对话", icon: BrainCircuit },
  {
    // 「最近工作」是按项目钻取的工具,不再兼任首页(那件事归 `/` 了)。留在常驻位是因为
    // 它带 5 个 tab、是使用频次最高的一组;折进抽屉里每次都要先展开一个组才够得着。
    to: "/dashboard",
    label: "最近工作",
    icon: LayoutDashboard,
    tabs: [
      { to: "/dashboard", label: "总览" },
      { to: "/dashboard/tokens", label: "Token 排行" },
      { to: "/dashboard/tokens-trend", label: "Token 趋势" },
      { to: "/dashboard/project-output", label: "产出效率" },
      { to: "/dashboard/cosmos", label: "对话宇宙" },
    ],
  },
];

/** 设置钉在栏底,不进任何组(VS Code / Linear / Slack 的惯例)。 */
export const SETTINGS_ITEM: NavItem = {
  to: "/settings",
  label: "设置",
  icon: SettingsIcon,
};

export const NAV_GROUPS: NavGroup[] = [
  {
    // 排第一位是因为这是这个应用的主体:库里 agent_user_messages 46666 行、
    // topic_stream 67650 行、两个 token 表合计十万行。而且手风琴默认展开当前所在组,
    // 最常停留的组排第一,展开的那一坨就在视线最上方。
    id: "conversation",
    label: "对话",
    icon: MessagesSquare,
    items: [
      { to: "/agent-messages", label: "对话搜索", icon: Search },
      {
        // 5 个来源本来是 5 个一级入口,但它们是同一件事的不同来源 —— 而「按来源筛选」
        // 这个模式应用里已经有了(最近工作页顶上就挂着来源下拉)。
        to: "/claude-code-history",
        label: "AI 对话记录",
        icon: MessageSquareText,
        tabs: [
          { to: "/claude-code-history", label: "Claude" },
          { to: "/codex-history", label: "Codex" },
          { to: "/cursor-history", label: "Cursor" },
          { to: "/cherry-studio-history", label: "Cherry" },
          { to: "/opencode-history", label: "opencode" },
          { to: "/kimi-history", label: "Kimi" },
        ],
      },
      { to: "/topics/river", label: "主题河流", icon: Waves },
    ],
  },
  {
    // 和其余组分开的判据是主键不同:这一组每一页的主轴都是日期。
    id: "timeline",
    label: "时间线",
    icon: CalendarClock,
    items: [
      { to: "/work-recap", label: "工作回看", icon: GitCommit },
      { to: "/ai-rhythm", label: "AI 节律", icon: Activity },
      { to: "/ai-sessions", label: "每日会话", icon: CalendarRange },
      { to: "/project-calendar", label: "项目日历", icon: CalendarDays },
      { to: "/attention", label: "注意力", icon: Eye },
      { to: "/commit-bridge", label: "对话↔提交", icon: GitCompare },
      { to: "/replay", label: "那天回放", icon: Clapperboard },
    ],
  },
  {
    id: "code",
    label: "代码",
    icon: FolderGit2,
    items: [
      { to: "/repos", label: "仓库", icon: Archive, matchChildren: true },
      {
        to: "/github",
        label: "GitHub",
        icon: GitFork,
        tabs: [
          { to: "/github", label: "概览" },
          { to: "/github/radar", label: "开源雷达" },
          { to: "/github/tags", label: "Star Tag" },
        ],
      },
      { to: "/vscode", label: "VS Code", icon: FolderCode },
      { to: "/cursor-projects", label: "Cursor 项目", icon: GitBranch },
    ],
  },
  {
    // 「我手上有哪些 AI 能力」的三个面:云端的额度、本地的模型、装了哪些工具。
    // 外部平台原来在「分析」组 —— 但那组是分析你**已经做过**的工作,而额度是你
    // **还能做多少**,方向是反的。
    id: "models",
    label: "模型与平台",
    icon: Layers,
    items: [
      { to: "/providers", label: "外部平台", icon: Plug },
      {
        to: "/huggingface-models",
        label: "模型库存",
        icon: Boxes,
        tabs: [
          { to: "/huggingface-models", label: "HuggingFace" },
          { to: "/lmstudio-models", label: "LM Studio" },
        ],
      },
      { to: "/ai-tools", label: "AI 工具清单", icon: Wrench },
    ],
  },
  {
    id: "software",
    label: "软件",
    icon: HardDrive,
    items: [
      { to: "/apps", label: "Mac 应用", icon: AppWindowMac },
      { to: "/brew", label: "Homebrew", icon: Beer },
      { to: "/downloads", label: "下载", icon: Download },
    ],
  },
  {
    // 别的程序留在这台机器上的记录。原来叫「历史记录」,和 AI 对话混装在一起 ——
    // 两者只在「都是过去发生的」这个意义上相同,而那个意义弱到不足以让人在找对话时
    // 想到它。留在 2 项是因为 Chrome 和 Atuin 没有任何备用入口,撤掉这个组它们只能
    // 塞进语义不对的地方。
    id: "local-records",
    label: "本机记录",
    icon: History,
    items: [
      {
        to: "/chrome-history",
        label: "Chrome",
        icon: Globe,
        tabs: [
          { to: "/chrome-history", label: "历史" },
          { to: "/chrome-history/domains", label: "域名" },
          { to: "/chrome-downloads", label: "下载" },
        ],
      },
      {
        to: "/atuin",
        label: "Atuin",
        icon: Terminal,
        tabs: [
          { to: "/atuin", label: "命令" },
          { to: "/atuin/directories", label: "目录" },
        ],
      },
    ],
  },
  {
    // 杂物抽屉,而且知道自己是:定时任务和 RAG 是 ai2nao 自己的内部状态,Shell 权限
    // 是你 Claude Code 的配置分析。配置类永远垫底。
    id: "ops",
    label: "运行与诊断",
    icon: Gauge,
    items: [
      { to: "/scheduler", label: "定时任务", icon: Clock },
      {
        to: "/bash-permissions",
        label: "Shell",
        icon: ShieldCheck,
        tabs: [
          { to: "/bash-permissions", label: "权限" },
          { to: "/bash-sandbox", label: "沙箱" },
        ],
      },
      {
        to: "/rag-status",
        label: "RAG",
        icon: Package,
        tabs: [
          { to: "/rag-status", label: "状态" },
          { to: "/rag-debug", label: "调试" },
        ],
      },
    ],
  },
];

export type NavMatch = {
  groupId: string | null;
  item: NavItem | null;
  tabs: NavTab[];
  activeTab: NavTab | null;
};

const EMPTY_MATCH: NavMatch = { groupId: null, item: null, tabs: [], activeTab: null };

/**
 * 只有完整路径段才算命中 —— `/dashboard-x` 不该命中 `/dashboard`。
 * 这就是为什么是 `to + "/"` 而不是裸的 startsWith。
 */
function covers(to: string, pathname: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

/** 侧栏和顶栏能到达的全部路径,给完整性测试用。 */
function itemDestinations(item: NavItem): string[] {
  // 有 tabs 时条目自身的 to 一定等于 tabs[0].to(有测试钉着),不能重复计入。
  return item.tabs === undefined ? [item.to] : item.tabs.map((t) => t.to);
}

export function allNavDestinations(): string[] {
  return [
    ...PRIMARY_ITEMS.flatMap(itemDestinations),
    ...itemDestinations(SETTINGS_ITEM),
    ...NAV_GROUPS.flatMap((g) => g.items.flatMap(itemDestinations)),
  ];
}

/**
 * 一个条目是否命中当前路径,以及命中的是它的哪个 tab。
 *
 * 常驻条目和组内条目必须走同一套逻辑。第一版没有:常驻那条只判了 `pathname === item.to`
 * 并把 activeTab 写死成 null。当时无所谓,因为常驻的只有「AI 对话」和「设置」,两个都
 * 没有 tab —— code review 还因此判定那是死分支。
 *
 * 「最近工作」提成常驻之后那段就承重了:它带 5 个 tab,按旧逻辑 /dashboard/tokens 既
 * 不等于 /dashboard 又没有 matchChildren,会一路穿过去谁都不命中 —— 侧栏和顶栏同时
 * 失去高亮。所以抽出来共用。
 */
function matchItem(item: NavItem, pathname: string): { hit: boolean; activeTab: NavTab | null } {
  const tabs = item.tabs ?? [];
  // 最长匹配:/atuin/directories 同时被 /atuin 和 /atuin/directories 覆盖,
  // 选中的 tab 必须是后者。
  const activeTab =
    tabs.filter((t) => covers(t.to, pathname)).sort((a, b) => b.to.length - a.to.length)[0] ??
    null;
  const selfHit =
    pathname === item.to || (item.matchChildren === true && covers(item.to, pathname));
  return { hit: activeTab !== null || selfHit, activeTab };
}

export function resolveNav(pathname: string): NavMatch {
  // 常驻条目不属于任何组,所以 groupId 是 null —— 停在它们上面时侧栏不展开任何一组。
  for (const item of [...PRIMARY_ITEMS, SETTINGS_ITEM]) {
    const m = matchItem(item, pathname);
    if (m.hit) return { groupId: null, item, tabs: item.tabs ?? [], activeTab: m.activeTab };
  }

  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      const m = matchItem(item, pathname);
      if (m.hit) return { groupId: group.id, item, tabs: item.tabs ?? [], activeTab: m.activeTab };
    }
  }
  return EMPTY_MATCH;
}
