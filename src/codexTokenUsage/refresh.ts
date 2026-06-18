import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { parseJsonlText, type ParseJsonlResult } from "../localJsonl/parse.js";
import { assertRealPathInsideRoot, isPathInsideRoot } from "../localJsonl/path.js";
import { listCodexTranscriptFiles } from "../codexHistory/discover.js";
import {
  extractCodexSessionUsage,
  extractCodexUsageEvents,
} from "../codexHistory/normalize.js";
import { codexSessionsRoot, codexStateDbPath, resolveCodexRoot } from "../codexHistory/paths.js";
import {
  listAllThreadsFromStateDb,
  openCodexStateDb,
} from "../codexHistory/stateDb.js";
import type { CodexThreadRow } from "../codexHistory/types.js";
import { normalizeWorkProjectIdentity } from "../workProjects/identity.js";
import {
  getCodexTokenUsageRow,
  getCodexTokenUsageState,
  markCodexTokenUsageRowSeen,
  markUnseenCodexTokenRowsMissing,
  replaceCodexTokenUsageEvents,
  upsertCodexTokenUsageRow,
  upsertCodexTokenUsageState,
} from "./queries.js";
import {
  CODEX_TOKEN_USAGE_RULE_VERSION,
  type CodexTokenUsageEventRow,
  type CodexTokenUsageRefreshResult,
  type CodexTokenUsageRow,
} from "./types.js";

type SourceSession = {
  id: string;
  rolloutPath: string;
  cwd: string;
  title: string;
  model?: string;
  gitBranch?: string;
  createdAt: Date | null;
  lastUpdatedAt: Date | null;
};

export type RefreshCodexTokenUsageOptions = {
  codexRoot?: string;
  full?: boolean;
  fallbackMaxFiles?: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function durationMs(started: number): number {
  return Date.now() - started;
}

function isoOrNull(date: Date | null | undefined): string | null {
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function transcriptIdFromPath(filePath: string): string {
  const stem = filePath.split("/").pop()?.replace(/\.jsonl$/i, "") ?? filePath;
  const m = stem.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return m ? m[1] : stem;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function fallbackFacts(parse: ParseJsonlResult, fileMtimeMs: number): {
  cwd: string;
  title: string;
  createdAt: Date;
  lastUpdatedAt: Date;
} {
  let cwd = "";
  let firstUser = "";
  let title = "";
  let minDate: Date | null = null;
  let maxDate: Date | null = null;
  for (const { record } of parse.okLines) {
    const tsRaw = stringField(record.timestamp);
    const ts = tsRaw ? new Date(tsRaw) : new Date(fileMtimeMs);
    if (!Number.isNaN(ts.getTime())) {
      if (!minDate || ts < minDate) minDate = ts;
      if (!maxDate || ts > maxDate) maxDate = ts;
    }
    const payload = objectField(record.payload);
    if (!payload) continue;
    if ((record.type === "session_meta" || record.type === "turn_context") && !cwd) {
      cwd = stringField(payload.cwd) ?? cwd;
    }
    if (record.type === "event_msg") {
      const eventType = stringField(payload.type);
      if (eventType === "thread_name_updated") {
        title = stringField(payload.thread_name) ?? title;
      } else if (eventType === "user_message" && !firstUser) {
        firstUser = stringField(payload.message)?.trim() ?? "";
      }
    }
  }
  const fallbackDate = new Date(fileMtimeMs);
  return {
    cwd,
    title: title || firstUser || "(无用户消息)",
    createdAt: minDate ?? fallbackDate,
    lastUpdatedAt: maxDate ?? fallbackDate,
  };
}

async function resolveTranscriptPath(
  sessionsRoot: string,
  rolloutPath: string
): Promise<string> {
  const candidate = resolve(rolloutPath);
  if (!isPathInsideRoot(sessionsRoot, candidate)) {
    throw new Error("rollout path is outside Codex sessions root");
  }
  if (!existsSync(candidate)) {
    throw new Error("transcript not found");
  }
  return assertRealPathInsideRoot(sessionsRoot, candidate);
}

function rowFromUsage(args: {
  source: SourceSession;
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
  parse: ParseJsonlResult | null;
  error: string | null;
  nowIso: string;
}): CodexTokenUsageRow {
  const usage = args.parse ? extractCodexSessionUsage(args.parse) : undefined;
  const cwd = args.source.cwd || "";
  const identity = normalizeWorkProjectIdentity({
    source: "codex",
    fallbackId: args.source.id,
    cwd,
    workspacePath: cwd,
    workspaceId: cwd,
  });
  const inputTokens = usage?.totalInputTokens ?? 0;
  const outputTokens = usage?.totalOutputTokens ?? 0;
  const reasoningOutputTokens = usage?.totalReasoningOutputTokens ?? 0;
  const cachedInputTokens = usage?.totalCachedInputTokens ?? 0;
  const tokenStatus = args.error ? "error" : usage ? "full" : "unknown";
  return {
    session_id: args.source.id,
    rollout_path: args.filePath,
    rollout_mtime_ms: Math.trunc(args.mtimeMs),
    rollout_size_bytes: args.sizeBytes,
    cwd,
    project_key: identity.key,
    project_path: identity.path,
    identity_confidence: identity.confidence,
    title: args.source.title || null,
    model: args.source.model ?? null,
    git_branch: args.source.gitBranch ?? null,
    created_at: isoOrNull(args.source.createdAt),
    last_updated_at: isoOrNull(args.source.lastUpdatedAt) ?? new Date(args.mtimeMs).toISOString(),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    reasoning_output_tokens: reasoningOutputTokens,
    cached_input_tokens: cachedInputTokens,
    token_status: tokenStatus,
    parse_error: args.error,
    missing_since: null,
    source_seen_at: args.nowIso,
    updated_at: args.nowIso,
  };
}

/**
 * Per-event token rows for the codex_token_usage_event timeline. Events with
 * no parseable timestamp fall back to the session's last_updated_at so they
 * still count (and land on a plausible day). The sum of these equals the
 * session row totals by construction (same accounting walk).
 */
function eventsFromParse(
  sessionId: string,
  parse: ParseJsonlResult,
  fallbackIso: string
): CodexTokenUsageEventRow[] {
  return extractCodexUsageEvents(parse).map((event) => ({
    session_id: sessionId,
    event_at: event.at ?? fallbackIso,
    input_tokens: event.usage.inputTokens,
    output_tokens: event.usage.outputTokens,
    reasoning_output_tokens: event.usage.reasoningOutputTokens,
    cached_input_tokens: event.usage.cachedInputTokens,
  }));
}

async function sqliteSourceSessions(
  stateDbPath: string
): Promise<SourceSession[]> {
  let db;
  try {
    db = openCodexStateDb(stateDbPath);
    const rows = listAllThreadsFromStateDb(db, stateDbPath, { archived: false });
    return rows.map((thread: CodexThreadRow) => ({
      id: thread.id,
      rolloutPath: thread.rolloutPath,
      cwd: thread.cwd,
      title: thread.title || thread.firstUserMessage || "",
      model: thread.model,
      gitBranch: thread.gitBranch,
      createdAt: thread.createdAt,
      lastUpdatedAt: thread.lastUpdatedAt,
    }));
  } finally {
    db?.close();
  }
}

async function fallbackSourceSessions(
  sessionsRoot: string,
  maxFiles: number
): Promise<SourceSession[]> {
  const { files } = await listCodexTranscriptFiles(sessionsRoot, { maxFiles });
  return files.map((file) => ({
    id: file.id || transcriptIdFromPath(file.filePath),
    rolloutPath: file.filePath,
    cwd: "",
    title: "",
    createdAt: new Date(file.mtimeMs),
    lastUpdatedAt: new Date(file.mtimeMs),
  }));
}

export async function refreshCodexTokenUsage(
  db: Database.Database,
  options: RefreshCodexTokenUsageOptions = {}
): Promise<CodexTokenUsageRefreshResult> {
  const started = Date.now();
  const refreshedAt = nowIso();
  const codexRoot = resolveCodexRoot(options.codexRoot);
  const sessionsRoot = codexSessionsRoot(codexRoot);
  const stateDbPath = codexStateDbPath(codexRoot);
  const seen = new Set<string>();
  const errors: string[] = [];
  let source: "sqlite" | "fallback" = "sqlite";
  let sourceSessions: SourceSession[] = [];

  // Self-heal: when the stored state's rule_version no longer matches the
  // running binary, every previously-indexed row was produced by an older
  // parser and may be wrong. Force a full reparse for this one tick so the
  // DB catches up; subsequent ticks return to incremental mode. Same pattern
  // as claudeTokenUsage.
  const storedState = getCodexTokenUsageState(db);
  const ruleVersionStale =
    storedState != null &&
    storedState.rule_version !== CODEX_TOKEN_USAGE_RULE_VERSION;
  const effectiveOptions = ruleVersionStale ? { ...options, full: true } : options;

  try {
    sourceSessions = await sqliteSourceSessions(stateDbPath);
  } catch (e) {
    source = "fallback";
    errors.push(e instanceof Error ? e.message : String(e));
    sourceSessions = await fallbackSourceSessions(
      sessionsRoot,
      options.fallbackMaxFiles ?? 5000
    );
  }

  let indexedSessionCount = 0;
  let tokenKnownSessionCount = 0;
  let tokenUnknownSessionCount = 0;
  let errorSessionCount = 0;
  let skippedUnchangedCount = 0;

  for (const sourceSession of sourceSessions) {
    seen.add(sourceSession.id);
    let filePath = sourceSession.rolloutPath;
    try {
      filePath = await resolveTranscriptPath(sessionsRoot, sourceSession.rolloutPath);
      const st = await stat(filePath);
      const existing = getCodexTokenUsageRow(db, sourceSession.id);
      if (
        !effectiveOptions.full &&
        existing &&
        existing.rollout_path === filePath &&
        existing.rollout_mtime_ms === Math.trunc(st.mtimeMs) &&
        existing.rollout_size_bytes === st.size
      ) {
        skippedUnchangedCount++;
        markCodexTokenUsageRowSeen(db, sourceSession.id, refreshedAt);
        if (existing.token_status === "full") tokenKnownSessionCount++;
        else if (existing.token_status === "error") errorSessionCount++;
        else tokenUnknownSessionCount++;
        indexedSessionCount++;
        continue;
      }

      const text = await readFile(filePath, "utf8");
      const parse = parseJsonlText(text);
      if (!sourceSession.cwd || !sourceSession.title) {
        const facts = fallbackFacts(parse, st.mtimeMs);
        sourceSession.cwd ||= facts.cwd;
        sourceSession.title ||= facts.title;
        sourceSession.createdAt ||= facts.createdAt;
        sourceSession.lastUpdatedAt ||= facts.lastUpdatedAt;
      }
      const row = rowFromUsage({
        source: sourceSession,
        filePath,
        mtimeMs: st.mtimeMs,
        sizeBytes: st.size,
        parse,
        error: parse.errors.length > 0 ? `${parse.errors.length} JSONL line(s) failed to parse` : null,
        nowIso: refreshedAt,
      });
      upsertCodexTokenUsageRow(db, row);
      replaceCodexTokenUsageEvents(
        db,
        sourceSession.id,
        eventsFromParse(sourceSession.id, parse, row.last_updated_at)
      );
      indexedSessionCount++;
      if (row.token_status === "full") tokenKnownSessionCount++;
      else if (row.token_status === "error") errorSessionCount++;
      else tokenUnknownSessionCount++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push(`${sourceSession.id}: ${message}`);
      const row = rowFromUsage({
        source: sourceSession,
        filePath,
        mtimeMs: Date.now(),
        sizeBytes: 0,
        parse: null,
        error: message,
        nowIso: refreshedAt,
      });
      upsertCodexTokenUsageRow(db, row);
      // No usable parse → clear any stale per-event rows for this session.
      replaceCodexTokenUsageEvents(db, sourceSession.id, []);
      indexedSessionCount++;
      errorSessionCount++;
    }
  }

  const missingMarkedCount = markUnseenCodexTokenRowsMissing(db, seen, refreshedAt);
  const duration = durationMs(started);
  const status = errors.length === 0 ? "success" : indexedSessionCount > 0 ? "partial" : "failed";
  upsertCodexTokenUsageState(db, {
    rule_version: CODEX_TOKEN_USAGE_RULE_VERSION,
    last_rebuilt_at: status === "failed" ? null : refreshedAt,
    last_error: errors[0] ?? null,
    source_session_count: sourceSessions.length,
    indexed_session_count: indexedSessionCount,
    token_known_session_count: tokenKnownSessionCount,
    token_unknown_session_count: tokenUnknownSessionCount,
    error_session_count: errorSessionCount,
    skipped_unchanged_count: skippedUnchangedCount,
    duration_ms: duration,
    updated_at: refreshedAt,
  });

  return {
    ok: status !== "failed",
    status,
    source,
    codexRoot,
    sessionsRoot,
    stateDbPath,
    sourceSessionCount: sourceSessions.length,
    indexedSessionCount,
    tokenKnownSessionCount,
    tokenUnknownSessionCount,
    errorSessionCount,
    skippedUnchangedCount,
    missingMarkedCount,
    durationMs: duration,
    errors,
  };
}
