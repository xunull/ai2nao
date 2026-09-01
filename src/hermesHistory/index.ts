/**
 * hermes 会话展示的读取层。**只读活的 `~/.hermes/state.db`,不镜像。**
 *
 * 为什么不建镜像表:hermes 没有项目归属(真库 cwd 9/120、git_repo_root 0/120),
 * 而 `opencode_session` 那张镜像表存在的理由正是 `project_key` 归属。没有归属可归,
 * 镜像表就只剩「多一份会漂的拷贝 + 一次 migration + 一次桌面 app 重新打包」的成本。
 * 展示页照 `opencodeHistory/stateDb.ts:205` 的做法直读源库。
 *
 * 消息正文另有一条独立路径进 `agent_user_messages`(见 agentUserMessages/hermesIngest.ts)
 * —— 那是为了让搜索页与 /ai-sessions 盖到 hermes,与本模块的展示读取互不依赖。
 */
import { diagnosticFromError, type HermesDiagnostic } from "./errors.js";
import { hermesDbPath, resolveHermesHome } from "./paths.js";
import { assertSchema, listSessions, loadSession, openHermesDb } from "./stateDb.js";
import type { HermesSessionDetail, HermesSessionSummary } from "./types.js";

export { HERMES_HOME_ENV, defaultHermesHome, hermesDbPath, resolveHermesHome } from "./paths.js";
export { isHermesHistoryError, HermesHistoryError } from "./errors.js";
export type { HermesDiagnostic } from "./errors.js";
export type * from "./types.js";

export type HermesSessionListResult = {
  hermesHome: string;
  dbPath: string;
  sessions: HermesSessionSummary[];
  /** 打不开 / 结构不认识时给出原因,页面据此显示可解释的空态而不是白屏。 */
  diagnostic?: HermesDiagnostic;
};

/** 打开 → 校验结构 → 跑 fn → 关闭。任何一步失败都变成 diagnostic,不抛。 */
function withDb<T>(
  rawHome: string | undefined,
  fn: (db: import("better-sqlite3").Database, dbPath: string) => T
): { home: string; dbPath: string; value?: T; diagnostic?: HermesDiagnostic } {
  const home = resolveHermesHome(rawHome);
  const dbPath = hermesDbPath(home);
  let db: import("better-sqlite3").Database | null = null;
  try {
    db = openHermesDb(dbPath);
    assertSchema(db, dbPath);
    return { home, dbPath, value: fn(db, dbPath) };
  } catch (e) {
    return { home, dbPath, diagnostic: diagnosticFromError(e) };
  } finally {
    db?.close();
  }
}

export function listHermesSessions(rawHome?: string): HermesSessionListResult {
  const r = withDb(rawHome, (db) => listSessions(db));
  return {
    hermesHome: r.home,
    dbPath: r.dbPath,
    sessions: r.value ?? [],
    ...(r.diagnostic ? { diagnostic: r.diagnostic } : {}),
  };
}

export function loadHermesSessionDetail(
  sessionId: string,
  rawHome?: string
): { detail: HermesSessionDetail | null; diagnostic?: HermesDiagnostic } {
  const r = withDb(rawHome, (db) => loadSession(db, sessionId));
  return {
    detail: r.value ?? null,
    ...(r.diagnostic ? { diagnostic: r.diagnostic } : {}),
  };
}
