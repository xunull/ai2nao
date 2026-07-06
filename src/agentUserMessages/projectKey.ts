/**
 * 绝对路径 → Claude 风格 project slug(**正向编码,确定性**)。
 *   /abs/path/to/repo  →  -abs-path-to-repo
 *
 * 与 claudeCodeHistory/decodeProjectSlug 记录的编码规则对齐:去尾斜杠 + 每个 `/` 换 `-`。
 * 三源统一用这个把 cwd/directory 编成 project,对话↔提交桥两侧都**正向编码后比较**
 * (commit 仓库路径也走这个),从不做有损的 slug→path 反解。
 */
export function slugFromPath(absPath: string | null | undefined): string | null {
  if (!absPath) return null;
  const p = absPath.trim().replace(/\/+$/, ""); // 去尾斜杠(根 `/` 会变空 → null)
  if (!p || !p.startsWith("/")) return null; // 只接受绝对 POSIX 路径
  return p.replace(/\//g, "-");
}
