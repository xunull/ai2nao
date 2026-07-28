/**
 * 项目活动日历(/project-calendar)的**项目归属**层。
 *
 * agent_user_messages.project 与 git_commits.project_key 存的都是 slugFromPath 的
 * **正向编码**(去尾斜杠 + 每个 `/` 换 `-`)。这个编码是**有损**的:
 *
 *     /w/x/foo-bar   ─┐
 *                     ├─→  -w-x-foo-bar     两条不同的真实路径,同一个 slug
 *     /w/x/foo/bar   ─┘
 *
 * 所以本模块**只做精确匹配**,不做任何基于字符串前缀的子目录归并:
 *
 *     slug ──┬─ 精确等于某个 repo 根的编码 ──┬─ 该 slug 唯一 ──→ { key: slug, path: 真实路径 }
 *            │                              │
 *            │                              └─ 多个 repo 编码撞了 ──→ { key: slug, path: null }
 *            │                                 (ambiguous:不赌哪一个)
 *            │
 *            └─ 没命中 ─────────────────────────────────────────→ { key: slug, path: null }
 *
 * 为什么砍掉「最长前缀归并」(设计文档 R3):
 *   `-w-x-foo-bar` 以 `-w-x-foo` + `-` 开头,但它的真实路径可能是 /w/x/foo-bar ——
 *   和 repo /w/x/foo 毫无祖先关系。`-` 边界区分不了「路径分隔符换来的 -」和
 *   「目录名里本来就有的 -」,所以前缀判定祖先关系在原理上不成立,而且错起来是**静默**的
 *   (项目数少一个,不报任何错)。实测收益只有 1 条消息,不值这个风险。
 *
 * 同理,displayName 在没有真实路径时**整个 slug 原样返回**,绝不在 `-` 上拆出「尾段」——
 * 那正是上面刚否掉的那种猜测(`-w-x-new-api-2` 会被拆成 `2`)。
 */
import { basename } from "node:path";
import type Database from "better-sqlite3";
import { slugFromPath } from "../agentUserMessages/projectKey.js";

/** slug → 该 repo 根的真实路径;多个 repo 撞同一 slug 时 path=null 且 ambiguous=true。 */
export type RepoSlugEntry = {
  path: string | null;
  ambiguous: boolean;
};

export type RepoSlugMap = Map<string, RepoSlugEntry>;

/** 项目归属结果。key 恒为原始 slug(永不改写);path 只在精确、唯一命中时有值。 */
export type ProjectIdentity = {
  key: string;
  path: string | null;
};

/**
 * 读一次 repos,把每个活跃仓库根正向编码成 slug。
 *
 * 每次请求调用一次即可(实测 ~800 行,微秒级)。不做长生命周期缓存:repos.scan 会持续
 * 新增仓库,缓存住会让新仓库长期显示成「归不到 repo」。
 *
 * missing_since 非空 = 该仓库已从磁盘消失,不参与归属(否则会给出一个指向不存在目录的路径)。
 */
export function buildRepoSlugMap(db: Database.Database): RepoSlugMap {
  const rows = db
    .prepare(
      `SELECT path_canonical FROM repos WHERE missing_since IS NULL ORDER BY path_canonical ASC`,
    )
    .all() as { path_canonical: string }[];

  const map: RepoSlugMap = new Map();
  for (const row of rows) {
    const slug = slugFromPath(row.path_canonical);
    if (!slug) continue; // 非绝对路径 / 根 → 编不出 slug,跳过(不崩)

    const existing = map.get(slug);
    if (existing) {
      // 碰撞:两条不同真实路径编码相同。不按插入顺序赌一个,直接标不确定。
      existing.path = null;
      existing.ambiguous = true;
      continue;
    }
    map.set(slug, { path: row.path_canonical, ambiguous: false });
  }
  return map;
}

/**
 * slug → 项目归属。key 永远是传进来的 slug 本身(不合并、不改写),
 * 只有精确且唯一命中某个 repo 根时才附带真实路径。
 */
export function canonicalProject(
  project: string,
  repoSlugs: RepoSlugMap,
): ProjectIdentity {
  const hit = repoSlugs.get(project);
  return hit && !hit.ambiguous
    ? { key: project, path: hit.path }
    : { key: project, path: null };
}

/**
 * 面板上显示的项目名。
 *   有真实路径 → basename(去尾斜杠后取最后一段,路径是真的,拆得起)
 *   没有        → 整个 slug 原样(前端负责 truncate + title 出全文)
 */
export function displayName(key: string, path: string | null): string {
  if (!path) return key;
  const trimmed = path.replace(/\/+$/, "");
  return basename(trimmed) || key;
}
