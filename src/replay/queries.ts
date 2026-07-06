/**
 * 那天回放(桥 T2b)读侧:把「窗口内的 commit + 人类对话」合并成事件流,按 gap 切成
 * 工作会话段(sessionize,T2a),再产出两种视图:
 *   - 列表卡片 listReplaySessions:每段的摘要(不带 events),最新在前。
 *   - 详情流 getReplaySession:某段按时间交织的事件流;commit 事件带 matchedCount。
 *
 * matchedCount 口径(逐 commit 精确、复用桥 T1b 的 windowFromFor,再加会话夹逼):
 *   windowFrom = max( windowFromFor(repo_key, T) , 本会话起点 startedAt )
 *     - windowFromFor = max(本仓库上一个提交时刻, T - CAP_HOURS)(桥的锁定口径)。
 *     - 再 clamp 到会话起点(issue-1d):不让某 commit 的关联对话回溯到会话开始之前。
 *   matched = agent_user_messages WHERE is_human=1 AND project=<commit.project_key>
 *             AND event_at_utc > windowFrom AND event_at_utc <= T。
 *   project 维度隔离(codex#4):别的仓库的对话不串进来。
 *
 * 时区无关:全部走 epoch ms(Date.parse / getTime),日期归属是 formatter 的事。
 * 字符串比较即时间比较:author_date_utc / event_at_utc 均为规范 ISO-UTC(桥已确立),
 * 故 windowFrom 的 `>` / `<=` 词典序 == 时序。author_date_utc 解析为 NaN 的脏行跳过并计数
 * (数据退化,codex#13)。
 */
import type Database from "better-sqlite3";
import { windowFromFor } from "../commitBridge/queries.js";
import { sessionize, type ReplayEvent } from "./sessionize.js";

/** 回放窗口默认回溯天数(只看最近这么多天的活)。 */
export const DEFAULT_WINDOW_DAYS = 90;

const DAY_MS = 86_400_000;

/** commit 事件的 payload:切分不看它,详情/matchedCount 用它。 */
type ReplayCommitPayload = {
  subject: string;
  added: number;
  deleted: number;
  filesChanged: number;
  /** git_commits.repo_key(真实路径),仅用于 windowFromFor;event.repoKey 是 project_key(slug)。 */
  repoKey: string;
  /** 规范 ISO-UTC 的 author_date_utc(matched 窗口上界 T),不从 atMs 反推,避免格式漂移。 */
  authorDateUtc: string;
};

/** message 事件的 payload。 */
type ReplayMessagePayload = {
  cleanedText: string;
  source: string;
};

type ReplayPayload = ReplayCommitPayload | ReplayMessagePayload;

/** 列表卡片 / 详情头:段摘要(不含 events)。 */
export type ReplaySessionCard = {
  startedAtMs: number;
  endedAtMs: number;
  firstEventKey: string;
  repoKeys: string[];
  commitCount: number;
  messageCount: number;
  truncated: boolean;
};

export type ListReplaySessionsResult = {
  /** 段摘要,**最新在前**(反转 sessionize 的 oldest-first)。 */
  sessions: ReplaySessionCard[];
  /** author_date_utc / event_at_utc 解析失败被跳过的脏行数。 */
  skipped: number;
  windowDays: number;
};

/** 详情流里的 commit 事件(带逐 commit 的 matchedCount)。 */
export type ReplayCommitEvent = {
  atMs: number;
  type: "commit";
  source: string;
  repoKey: string;
  id: string;
  subject: string;
  added: number;
  deleted: number;
  filesChanged: number;
  matchedCount: number;
};

/** 详情流里的 message 事件。 */
export type ReplayMessageEvent = {
  atMs: number;
  type: "message";
  source: string;
  repoKey: string;
  id: string;
  cleanedText: string;
};

export type ReplayDetailEvent = ReplayCommitEvent | ReplayMessageEvent;

export type ReplaySessionDetail = {
  session: ReplaySessionCard;
  events: ReplayDetailEvent[];
};

/** ReplaySession(内部结构,带 events)→ 列表卡片(去掉 events)。 */
function toCard(s: {
  startedAtMs: number;
  endedAtMs: number;
  firstEventKey: string;
  repoKeys: string[];
  commitCount: number;
  messageCount: number;
  truncated: boolean;
}): ReplaySessionCard {
  return {
    startedAtMs: s.startedAtMs,
    endedAtMs: s.endedAtMs,
    firstEventKey: s.firstEventKey,
    repoKeys: s.repoKeys,
    commitCount: s.commitCount,
    messageCount: s.messageCount,
    truncated: s.truncated,
  };
}

/**
 * 窗口内的 commit + 人类对话 → 合并事件流(未排序,交给 sessionize 内部排)。
 * 跳过 author_date_utc / event_at_utc 解析失败的脏行并计数。list 与 get 共用。
 */
function buildEvents(
  db: Database.Database,
  sinceIso: string
): { events: ReplayEvent<ReplayPayload>[]; skipped: number } {
  let skipped = 0;
  const events: ReplayEvent<ReplayPayload>[] = [];

  const commitRows = db
    .prepare(
      `SELECT project_key AS projectKey, repo_key AS repoKey, commit_hash AS commitHash,
              author_date_utc AS authorDateUtc, subject, added, deleted,
              files_changed AS filesChanged
       FROM git_commits
       WHERE project_key IS NOT NULL AND author_date_utc >= @sinceIso`
    )
    .all({ sinceIso }) as {
    projectKey: string;
    repoKey: string;
    commitHash: string;
    authorDateUtc: string;
    subject: string | null;
    added: number;
    deleted: number;
    filesChanged: number;
  }[];

  for (const r of commitRows) {
    const atMs = Date.parse(r.authorDateUtc);
    if (Number.isNaN(atMs)) {
      skipped += 1; // 脏时间戳(codex#13)→ 跳过并计数,不进事件流。
      continue;
    }
    events.push({
      atMs,
      type: "commit",
      source: "git",
      id: r.commitHash,
      repoKey: r.projectKey, // slug(切分/详情展示用)
      payload: {
        subject: r.subject ?? "", // 缺 subject → ""(前端显示「(无主题)」),不崩。
        added: r.added,
        deleted: r.deleted,
        filesChanged: r.filesChanged,
        repoKey: r.repoKey, // 真实路径,windowFromFor 用。
        authorDateUtc: r.authorDateUtc,
      },
    });
  }

  const msgRows = db
    .prepare(
      `SELECT id, source, project, event_at_utc AS eventAtUtc, cleaned_text AS cleanedText
       FROM agent_user_messages
       WHERE is_human = 1 AND project IS NOT NULL AND event_at_utc >= @sinceIso`
    )
    .all({ sinceIso }) as {
    id: number;
    source: string;
    project: string;
    eventAtUtc: string;
    cleanedText: string | null;
  }[];

  for (const r of msgRows) {
    const atMs = Date.parse(r.eventAtUtc);
    if (Number.isNaN(atMs)) {
      skipped += 1;
      continue;
    }
    events.push({
      atMs,
      type: "message",
      source: r.source,
      id: String(r.id),
      repoKey: r.project, // slug
      payload: { cleanedText: r.cleanedText ?? "", source: r.source },
    });
  }

  return { events, skipped };
}

/** sinceIso = (nowMs - windowDays 天) 的规范 ISO-UTC。窗口下界,list/get 共用。 */
function computeSince(opts: { windowDays?: number; nowMs?: number }): {
  windowDays: number;
  sinceIso: string;
} {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const nowMs = opts.nowMs ?? Date.now();
  const sinceMs = nowMs - windowDays * DAY_MS;
  return { windowDays, sinceIso: new Date(sinceMs).toISOString() };
}

/**
 * 回放会话列表(卡片)。默认只留**混合段**(commitCount>0 && messageCount>0):
 * 光有对话没提交、或光有提交没对话的段都不上榜(回放的价值在「聊了 → 落成提交」)。
 * includeNoCommit=true 时放宽为「只要有提交」(commitCount>0),仍不含纯对话段。
 * 卡片最新在前(反转 sessionize 的 oldest-first)。
 */
export function listReplaySessions(
  db: Database.Database,
  opts: {
    windowDays?: number;
    nowMs?: number;
    gapThresholdMs?: number;
    includeNoCommit?: boolean;
  } = {}
): ListReplaySessionsResult {
  const { windowDays, sinceIso } = computeSince(opts);
  const { events, skipped } = buildEvents(db, sinceIso);
  const sessions = sessionize(events, { gapThresholdMs: opts.gapThresholdMs });

  const kept = opts.includeNoCommit
    ? sessions.filter((s) => s.commitCount > 0)
    : sessions.filter((s) => s.commitCount > 0 && s.messageCount > 0);

  // sessionize 为 oldest-first;反转成 newest-first。
  const cards = kept.map(toCard).reverse();
  return { sessions: cards, skipped, windowDays };
}

/**
 * 某段回放详情。同窗口重算会话(有界,fine),按 firstEventKey 定位;找不到 → null。
 * 事件按时间交织(sessionize 内部已升序)。commit 事件带 matchedCount(见文件头口径)。
 */
export function getReplaySession(
  db: Database.Database,
  opts: {
    key: string;
    windowDays?: number;
    nowMs?: number;
    gapThresholdMs?: number;
  }
): ReplaySessionDetail | null {
  const { sinceIso } = computeSince(opts);
  const { events } = buildEvents(db, sinceIso);
  const sessions = sessionize(events, { gapThresholdMs: opts.gapThresholdMs });
  const session = sessions.find((s) => s.firstEventKey === opts.key);
  if (!session) return null;

  // 会话起点 ISO —— matchedCount 的夹逼下界(issue-1d)。startedAtMs 来自规范 ISO 的
  // Date.parse,round-trip 回规范 ISO 无损。
  const sessionStartIso = new Date(session.startedAtMs).toISOString();
  const countStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM agent_user_messages
     WHERE is_human = 1 AND project = @project
       AND event_at_utc > @windowFrom AND event_at_utc <= @t`
  );

  const detail: ReplayDetailEvent[] = session.events.map((e) => {
    if (e.type === "commit") {
      const p = e.payload as ReplayCommitPayload;
      const wf = windowFromFor(db, p.repoKey, p.authorDateUtc);
      // clamp 到会话起点:两侧都是规范 ISO-UTC,词典序即时序,取较晚者。
      const windowFrom = wf > sessionStartIso ? wf : sessionStartIso;
      const matchedCount = (
        countStmt.get({
          project: e.repoKey, // project_key(slug):project 维度隔离,不串仓库。
          windowFrom,
          t: p.authorDateUtc,
        }) as { n: number }
      ).n;
      return {
        atMs: e.atMs,
        type: "commit",
        source: e.source,
        repoKey: e.repoKey,
        id: e.id,
        subject: p.subject,
        added: p.added,
        deleted: p.deleted,
        filesChanged: p.filesChanged,
        matchedCount,
      };
    }
    const p = e.payload as ReplayMessagePayload;
    return {
      atMs: e.atMs,
      type: "message",
      source: e.source,
      repoKey: e.repoKey,
      id: e.id,
      cleanedText: p.cleanedText,
    };
  });

  return { session: toCard(session), events: detail };
}
