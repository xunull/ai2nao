import type Database from "better-sqlite3";
import { statSync } from "node:fs";
import {
  kimiProjectPath,
  readKimiSessionMeta,
  scanKimiWireFiles,
} from "../kimiHistory/scan.js";
import { normalizeWorkProjectIdentity } from "../workProjects/identity.js";
import { parseKimiUsage, type KimiUsageEvent } from "./parse.js";
import { getKimiTokenUsageState } from "./queries.js";
import { KIMI_TOKEN_USAGE_RULE_VERSION } from "./types.js";

/**
 * kimi token 用量入库。
 *
 * ## 一行一个 agent 文件,不是一行一个会话
 *
 * kimi 一个会话下有 `agents/<main|agent-N>/wire.jsonl` 多个文件(实测最多 12 个)。
 * 主表按 (session_id, agent) 建,于是**坏掉的那个 agent 只拖累它自己** ——
 * 另外 11 个的 token 照常入库、照常出现在图表里。
 *
 * 会话级的 worst-of 只用于诊断展示,**不作 token SUM 的门禁**。
 * (codex outside voice 的 X2。趋势页的门禁是 `token_status='full'`,
 *  会话级 worst-of 会让整场 12 个 agent 的 token 一起消失。)
 *
 * ## 按文件事务性 delete-and-replace
 *
 * 每个 wire.jsonl 重扫时先删掉它自己的全部旧事件再写入,整段包在一个事务里。
 * 这样文件被截断、重写、或某些事件消失时不会留下陈旧行 ——
 * 靠「(session_id, agent, ordinal) 冲突就跳过」是做不到的。
 *
 * ## 文件发现口径唯一
 *
 * 复用 `scanKimiWireFiles()`。它含 `ctitle-` 标题生成会话的过滤,
 * 手写 `find -name wire.jsonl` 会多出那一批。
 */

export type RefreshKimiTokenUsageOptions = {
  cliRoot?: string;
  desktopRoot?: string;
  /** 忽略 mtime/size 未变的跳过逻辑,全部重解析。 */
  full?: boolean;
};

export type RefreshKimiTokenUsageResult = {
  scannedAgents: number;
  indexedAgents: number;
  skippedUnchanged: number;
  /** 解析成功且有事件。 */
  fullAgents: number;
  /** 解析成功但一条 usage.record 都没有。 */
  unknownAgents: number;
  /** 读不了 / 超限 / 解析炸了。 */
  errorAgents: number;
  events: number;
  durationMs: number;
  /** 目录列举失败 —— 这一轮的结果不完整。 */
  dirListFailure: boolean;
  /** 因规则版本变化而被强制全量重解析(不是调用方传的 `full`)。 */
  forcedFullByRuleVersion: boolean;
};

// 规则版本挪到 ./types.js —— 读取侧(queries.ts)也要用它判断陈旧。
const RULE_VERSION = KIMI_TOKEN_USAGE_RULE_VERSION;

type AgentRow = {
  session_id: string;
  agent: string;
  file_path: string;
  file_mtime_ms: number;
  file_size_bytes: number;
  root_kind: "cli" | "desktop";
  cwd: string;
  project_key: string;
  project_path: string;
  identity_confidence: string;
  title: string | null;
  model: string | null;
  created_at: string | null;
  last_updated_at: string;
  token_status: "full" | "unknown" | "error";
  parse_error: string | null;
  source_seen_at: string;
  updated_at: string;
};

export function refreshKimiTokenUsage(
  db: Database.Database,
  opts: RefreshKimiTokenUsageOptions = {}
): RefreshKimiTokenUsageResult {
  const started = Date.now();
  const now = new Date().toISOString();

  // 规则版本变了 = 已入库那些行的派生字段(项目身份、标题、模型)是按旧口径算出来的。
  // 逐行的跳过判据只比 mtime 与大小,而 wire.jsonl 不会因为我们改代码而变 —— 不强制
  // 全量就永远刷不掉。在此之前这个机制是空的:版本不符只让读取侧报 `rule_version_mismatch`,
  // 数据从不重建。空库(state 行还没有)也走这条,反正没有可跳过的行。
  const forcedFullByRuleVersion =
    getKimiTokenUsageState(db)?.rule_version !== RULE_VERSION;
  const full = opts.full === true || forcedFullByRuleVersion;

  const { files, dirListFailure } = scanKimiWireFiles({
    cliRoot: opts.cliRoot,
    desktopRoot: opts.desktopRoot,
  });

  const existing = new Map(
    (
      db
        .prepare(
          `SELECT session_id, agent, file_mtime_ms, file_size_bytes
             FROM kimi_agent_token_usage`
        )
        .all() as { session_id: string; agent: string; file_mtime_ms: number; file_size_bytes: number }[]
    ).map((r) => [`${r.session_id}\u0000${r.agent}`, r])
  );

  const upsertAgent = db.prepare(
    `INSERT INTO kimi_agent_token_usage
       (session_id, agent, file_path, file_mtime_ms, file_size_bytes, root_kind,
        cwd, project_key, project_path, identity_confidence, title, model,
        created_at, last_updated_at, token_status, parse_error, missing_since,
        source_seen_at, updated_at)
     VALUES (@session_id, @agent, @file_path, @file_mtime_ms, @file_size_bytes, @root_kind,
             @cwd, @project_key, @project_path, @identity_confidence, @title, @model,
             @created_at, @last_updated_at, @token_status, @parse_error, NULL,
             @source_seen_at, @updated_at)
     ON CONFLICT(session_id, agent) DO UPDATE SET
       file_path = excluded.file_path,
       file_mtime_ms = excluded.file_mtime_ms,
       file_size_bytes = excluded.file_size_bytes,
       root_kind = excluded.root_kind,
       cwd = excluded.cwd,
       project_key = excluded.project_key,
       project_path = excluded.project_path,
       identity_confidence = excluded.identity_confidence,
       title = excluded.title,
       model = excluded.model,
       created_at = excluded.created_at,
       last_updated_at = excluded.last_updated_at,
       token_status = excluded.token_status,
       parse_error = excluded.parse_error,
       missing_since = NULL,
       source_seen_at = excluded.source_seen_at,
       updated_at = excluded.updated_at`
  );
  const deleteEvents = db.prepare(
    `DELETE FROM kimi_token_usage_event WHERE session_id = ? AND agent = ?`
  );
  const insertEvent = db.prepare(
    `INSERT INTO kimi_token_usage_event
       (session_id, agent, event_ordinal, event_at,
        fresh_input, cache_read_input, cache_creation_input, output)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  /** 一个 agent 文件 = 一个事务。删旧事件 + 写新事件 + upsert 主行,同生共死。 */
  const writeAgent = db.transaction(
    (row: AgentRow, events: KimiUsageEvent[]) => {
      deleteEvents.run(row.session_id, row.agent);
      for (const e of events) {
        insertEvent.run(
          row.session_id,
          row.agent,
          e.ordinal,
          new Date(e.timeMs).toISOString(),
          e.freshInput,
          e.cacheReadInput,
          e.cacheCreationInput,
          e.output
        );
      }
      upsertAgent.run(row);
    }
  );

  let indexed = 0;
  let skipped = 0;
  let fullAgents = 0;
  let unknownAgents = 0;
  let errorAgents = 0;
  let eventCount = 0;
  const seen = new Set<string>();

  for (const f of files) {
    const key = `${f.sessionId}\u0000${f.agent}`;
    seen.add(key);

    let size = 0;
    try {
      size = statSync(f.filePath).size;
    } catch {
      /* 下面的 parse 会再撞一次并归到 error */
    }

    const prev = existing.get(key);
    if (
      !full &&
      prev &&
      prev.file_mtime_ms === Math.trunc(f.mtimeMs) &&
      prev.file_size_bytes === size
    ) {
      skipped++;
      continue;
    }

    const meta = readKimiSessionMeta(f.filePath);
    const projectPath = kimiProjectPath(meta);
    const identity = normalizeWorkProjectIdentity({
      source: "kimi",
      fallbackId: f.sessionId,
      cwd: projectPath ?? "",
      workspacePath: projectPath ?? "",
      workspaceId: projectPath ?? "",
    });

    let events: KimiUsageEvent[] = [];
    let model: string | null = null;
    let status: AgentRow["token_status"];
    let parseError: string | null = null;
    try {
      const parsed = parseKimiUsage(f.filePath);
      events = parsed.events;
      model = parsed.model;
      // 解析成功但零事件 = unknown(文件在、就是没用过),不是 error。
      status = events.length > 0 ? "full" : "unknown";
    } catch (e) {
      // ⚠️ 只影响这一个 agent。同会话的其他 agent 照常入库 —— 这是 X2 的核心。
      status = "error";
      parseError = e instanceof Error ? e.message : String(e);
    }

    const lastUpdatedAt =
      events.length > 0
        ? new Date(Math.max(...events.map((e) => e.timeMs))).toISOString()
        : (meta.updatedAt ?? new Date(f.mtimeMs).toISOString());

    const row: AgentRow = {
      session_id: f.sessionId,
      agent: f.agent,
      file_path: f.filePath,
      file_mtime_ms: Math.trunc(f.mtimeMs),
      file_size_bytes: size,
      root_kind: f.rootKind,
      cwd: projectPath ?? "",
      project_key: identity.key,
      project_path: identity.path,
      identity_confidence: identity.confidence,
      title: meta.title,
      model,
      created_at: meta.createdAt,
      last_updated_at: lastUpdatedAt,
      token_status: status,
      parse_error: parseError,
      source_seen_at: now,
      updated_at: now,
    };

    writeAgent(row, events);
    indexed++;
    eventCount += events.length;
    if (status === "full") fullAgents++;
    else if (status === "unknown") unknownAgents++;
    else errorAgents++;
  }

  // 消失的文件标 missing_since,不删行 —— 与 claude/codex 一致,
  // 这样「曾经存在过」这件事不会丢。目录列举失败的那一轮不做这件事,
  // 否则会把「没列出来」误判成「文件没了」。
  if (!dirListFailure) {
    const stale = [...existing.keys()].filter((k) => !seen.has(k));
    const markMissing = db.prepare(
      `UPDATE kimi_agent_token_usage
          SET missing_since = COALESCE(missing_since, ?), updated_at = ?
        WHERE session_id = ? AND agent = ?`
    );
    const tx = db.transaction(() => {
      for (const k of stale) {
        const [sid, agent] = k.split("\u0000");
        markMissing.run(now, now, sid!, agent!);
      }
    });
    tx();
  }

  const durationMs = Date.now() - started;
  db.prepare(
    `INSERT INTO kimi_token_usage_state
       (id, rule_version, last_rebuilt_at, last_error, source_agent_count,
        indexed_agent_count, token_known_agent_count, token_unknown_agent_count,
        error_agent_count, skipped_unchanged_count, duration_ms, updated_at)
     VALUES (1, @rule_version, @last_rebuilt_at, @last_error, @source_agent_count,
             @indexed_agent_count, @token_known_agent_count, @token_unknown_agent_count,
             @error_agent_count, @skipped_unchanged_count, @duration_ms, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       rule_version = excluded.rule_version,
       last_rebuilt_at = excluded.last_rebuilt_at,
       last_error = excluded.last_error,
       source_agent_count = excluded.source_agent_count,
       indexed_agent_count = excluded.indexed_agent_count,
       token_known_agent_count = excluded.token_known_agent_count,
       token_unknown_agent_count = excluded.token_unknown_agent_count,
       error_agent_count = excluded.error_agent_count,
       skipped_unchanged_count = excluded.skipped_unchanged_count,
       duration_ms = excluded.duration_ms,
       updated_at = excluded.updated_at`
  ).run({
    rule_version: RULE_VERSION,
    last_rebuilt_at: now,
    last_error: dirListFailure ? "目录列举失败,本轮结果不完整" : null,
    source_agent_count: files.length,
    indexed_agent_count: indexed,
    token_known_agent_count: fullAgents,
    token_unknown_agent_count: unknownAgents,
    error_agent_count: errorAgents,
    skipped_unchanged_count: skipped,
    duration_ms: durationMs,
    updated_at: now,
  });

  return {
    scannedAgents: files.length,
    indexedAgents: indexed,
    skippedUnchanged: skipped,
    fullAgents,
    unknownAgents,
    errorAgents,
    events: eventCount,
    durationMs,
    dirListFailure,
    forcedFullByRuleVersion,
  };
}
