/**
 * Kimi 会话列表的分组、排序与搜索。纯数据变换,不碰 React ——
 * 「未知置底」「全部那个计数」这类最容易写反的地方靠单测钉住。
 *
 * 判据是 `projectPath === ""`:空串表示确定不属于任何工作目录(桌面沙箱里用默认
 * 工作目录开的随手提问),不是「还没查出来」。见
 * docs/adr/0001-kimi-unknown-project-identity.md。
 */

/** 「全部」那一项在左栏里的 id。真项目的 id 是 projectKey,不会与它撞。 */
export const ALL_PROJECTS = "";

export const UNKNOWN_PROJECT_LABEL = "(未知项目)";

/**
 * 只有正文、还没进 token 索引的会话。**不能并进「(未知项目)」** ——
 * 那个词是「确定没有目录」,这个是「还没查出来」,见 CONTEXT.md。
 * 最常见的成因是 kimi.tokens.refresh 这个定时任务关着,诊断条会直说。
 */
export const PENDING_PROJECT_KEY = "kimi:pending";
export const PENDING_PROJECT_LABEL = "待索引";

export type KimiGroupableSession = {
  sessionId: string;
  title: string | null;
  projectKey: string;
  projectPath: string;
  preview: string;
  lastUpdatedAt: string;
  /** false = 只有正文,没有标题/项目归属。 */
  tokenIndexed: boolean;
};

export type KimiProjectGroup = {
  /** 选中态与 `?project=` 用它。 */
  key: string;
  /** 左栏显示的名字:目录 basename,未知项目是「(未知项目)」。 */
  label: string;
  /** 绝对路径;未知项目为空串。 */
  path: string;
  sessionCount: number;
  lastUpdatedAt: string;
  isUnknown: boolean;
  isPending: boolean;
};

function parseTime(value: string): number {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** 目录 basename;同名目录不做去重消歧 —— 完整路径就在下一行,悬浮也有 title。 */
function labelOf(s: KimiGroupableSession): string {
  const path = s.projectPath;
  if (!s.tokenIndexed) return PENDING_PROJECT_LABEL;
  if (path === "") return UNKNOWN_PROJECT_LABEL;
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function matchesQuery(s: KimiGroupableSession, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${s.title ?? ""} ${s.projectPath} ${s.preview}`.toLowerCase().includes(q);
}

/**
 * 按项目分组。传进来的应该是**搜索过滤之后**的会话 —— 左栏跟着搜索结果收窄,
 * 于是「这个词命中在哪些目录」本身就是答案。
 *
 * 排序:真项目按最后活跃时间倒序,「(未知项目)」与「待索引」固定沉底(后者最末)。
 * 沉底的理由是这两类往往是最近发生的,按时间排会天天浮在最上面,把真正的项目挤下去。
 */
export function groupByProject(sessions: KimiGroupableSession[]): KimiProjectGroup[] {
  const byKey = new Map<string, KimiProjectGroup>();
  for (const s of sessions) {
    const existing = byKey.get(s.projectKey);
    if (existing) {
      existing.sessionCount += 1;
      if (parseTime(s.lastUpdatedAt) > parseTime(existing.lastUpdatedAt)) {
        existing.lastUpdatedAt = s.lastUpdatedAt;
      }
      continue;
    }
    byKey.set(s.projectKey, {
      key: s.projectKey,
      label: labelOf(s),
      path: s.projectPath,
      sessionCount: 1,
      lastUpdatedAt: s.lastUpdatedAt,
      isUnknown: s.tokenIndexed && s.projectPath === "",
      isPending: !s.tokenIndexed,
    });
  }

  const rank = (g: KimiProjectGroup) => (g.isPending ? 2 : g.isUnknown ? 1 : 0);
  return [...byKey.values()].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (
      parseTime(b.lastUpdatedAt) - parseTime(a.lastUpdatedAt) ||
      a.label.localeCompare(b.label, "zh-Hans-CN")
    );
  });
}

/**
 * 左栏最终要渲染的分组。分组算的是**搜索命中**的会话,但选中的那个目录即使一条都没命中
 * 也要留在栏里(计数 0)—— 否则界面上没有任何东西说明「你还选着一个目录」,右栏的空态
 * 会被误读成「这个词全库都没有」。
 */
export function projectPanel(
  all: KimiGroupableSession[],
  matched: KimiGroupableSession[],
  selected: string
): KimiProjectGroup[] {
  const groups = groupByProject(matched);
  if (selected === ALL_PROJECTS || groups.some((g) => g.key === selected)) return groups;
  const [orphan] = groupByProject(all.filter((s) => s.projectKey === selected));
  return orphan ? [...groups, { ...orphan, sessionCount: 0 }] : groups;
}

/** 右栏要显示的会话:选了具体项目就只留它的,「全部」态留全部。都按最后活跃时间倒序。 */
export function sessionsForProject<T extends KimiGroupableSession>(
  sessions: T[],
  project: string
): T[] {
  const kept =
    project === ALL_PROJECTS ? [...sessions] : sessions.filter((s) => s.projectKey === project);
  return kept.sort((a, b) => parseTime(b.lastUpdatedAt) - parseTime(a.lastUpdatedAt));
}
