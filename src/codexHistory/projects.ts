import { existsSync } from "node:fs";
import { basename } from "node:path";
import { diagnosticFromError, type CodexDiagnostic } from "./errors.js";
import { listCodexSessionSummaries } from "./load.js";
import { codexStateDbPath, resolveCodexRoot } from "./paths.js";
import { listCodexProjectsFromStateDb, openCodexStateDb } from "./stateDb.js";
import type {
  CodexListFilters,
  CodexProjectSummary,
  CodexProjectsResult,
} from "./types.js";

const UNKNOWN_PROJECT = "(未知项目)";

/** 去单个/多个尾斜杠;与 stateDb 的 `rtrim(cwd,'/')` 行为对齐(D2/D3)。 */
function stripTrailingSlash(s: string): string {
  const t = s.trim();
  if (t === "") return "";
  const stripped = t.replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped; // 根 `/` 保护回 `/`
}

function toSummary(
  proj: string,
  sessionCount: number,
  lastActiveMs: number
): CodexProjectSummary {
  const isUnknown = proj.trim() === "";
  return {
    id: proj,
    path: isUnknown ? "" : proj,
    name: isUnknown ? UNKNOWN_PROJECT : basename(proj) || proj,
    sessionCount,
    lastActiveAt: new Date(lastActiveMs).toISOString(),
  };
}

/**
 * 列出 codex「项目」(按归一化 cwd 聚合),供 codex-history 左栏使用。
 * 主路径走 state DB 的 SQL GROUP BY;state DB 不可用时回落到扫 JSONL 的 session
 * 列表、按 workspacePath 分组(best-effort,见设计文档 §5/§9 已知降级)。
 * D1:只受 `archived` 影响,不接 branch/model。
 */
export async function listCodexProjects(
  rawCodexRoot: string | undefined,
  filters: Pick<CodexListFilters, "archived">
): Promise<CodexProjectsResult> {
  const codexRoot = resolveCodexRoot(rawCodexRoot);
  const stateDbPath = codexStateDbPath(codexRoot);
  const diagnostics: CodexDiagnostic[] = [];

  if (existsSync(codexRoot)) {
    let db;
    try {
      db = openCodexStateDb(stateDbPath);
      const rows = listCodexProjectsFromStateDb(db, stateDbPath, filters);
      return {
        ok: true,
        source: "sqlite",
        codexRoot,
        stateDbPath,
        diagnostics,
        projects: rows.map((r) =>
          toSummary(r.proj, r.sessionCount, r.lastUpdatedAt.getTime())
        ),
      };
    } catch (e) {
      diagnostics.push(diagnosticFromError(e));
    } finally {
      db?.close();
    }
  } else {
    diagnostics.push({
      kind: "root-not-found",
      message: "Codex root not found",
      path: codexRoot,
    });
  }

  // fallback:扫 JSONL,按 workspacePath 分组。
  const fb = await listCodexSessionSummaries(rawCodexRoot, {
    archived: filters.archived,
  });
  const groups = new Map<string, { count: number; last: number }>();
  for (const s of fb.sessions) {
    const key = stripTrailingSlash(s.workspacePath ?? "");
    const t = new Date(s.lastUpdatedAt).getTime();
    const g = groups.get(key) ?? { count: 0, last: 0 };
    g.count += 1;
    g.last = Math.max(g.last, Number.isFinite(t) ? t : 0);
    groups.set(key, g);
  }
  const projects = [...groups.entries()]
    .map(([proj, g]) => toSummary(proj, g.count, g.last))
    .sort(
      (a, b) =>
        b.lastActiveAt.localeCompare(a.lastActiveAt) || a.id.localeCompare(b.id)
    );

  return {
    ok: true,
    source: "fallback",
    codexRoot,
    stateDbPath,
    diagnostics: [...diagnostics, ...fb.diagnostics],
    projects,
  };
}
