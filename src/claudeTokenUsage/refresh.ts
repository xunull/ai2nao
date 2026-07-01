import { readFile, stat } from "node:fs/promises";
import type Database from "better-sqlite3";
import {
  listProjects,
  listSessionJsonlFiles,
  resolveClaudeProjectsRoot,
} from "../claudeCodeHistory/index.js";
import { parseJsonlText, type ParseJsonlResult } from "../claudeCodeHistory/parseJsonl.js";
import {
  extractClaudeDominantModel,
  extractClaudeSessionUsage,
  extractClaudeTokenEvents,
  type ClaudeTokenEvent,
} from "../claudeCodeHistory/normalize.js";
import { normalizeWorkProjectIdentity } from "../workProjects/identity.js";
import {
  getClaudeTokenUsageRow,
  getClaudeTokenUsageState,
  markClaudeTokenUsageRowSeen,
  markUnseenClaudeTokenRowsMissing,
  persistClaudeTokenUsage,
  upsertClaudeTokenUsageState,
} from "./queries.js";
import {
  CLAUDE_TOKEN_USAGE_RULE_VERSION,
  type ClaudeTokenUsageRefreshResult,
  type ClaudeTokenUsageRow,
} from "./types.js";

type SourceSession = {
  id: string;
  projectId: string;
  filePath: string;
  decodedWorkspacePath: string | null;
  fallbackProjectPath: string;
  mtimeMs: number;
  sizeBytes: number;
};

export type RefreshClaudeTokenUsageOptions = {
  projectsRoot?: string;
  full?: boolean;
};

function nowIso(): string {
  return new Date().toISOString();
}

function durationMs(started: number): number {
  return Date.now() - started;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isoOrNull(date: Date | null | undefined): string | null {
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function fallbackFacts(parse: ParseJsonlResult, fileMtimeMs: number): {
  cwd: string;
  title: string;
  createdAt: Date;
  lastUpdatedAt: Date;
  preview: string;
  messageCount: number;
} {
  let cwd = "";
  let firstUser = "";
  let minDate: Date | null = null;
  let maxDate: Date | null = null;
  for (const { record } of parse.okLines) {
    const tsRaw = stringField(record.timestamp);
    const ts = tsRaw ? new Date(tsRaw) : new Date(fileMtimeMs);
    if (!Number.isNaN(ts.getTime())) {
      if (!minDate || ts < minDate) minDate = ts;
      if (!maxDate || ts > maxDate) maxDate = ts;
    }
    if (!cwd) cwd = stringField(record.cwd) ?? "";
    if (record.type !== "user" || firstUser) continue;
    const message = objectField(record.message);
    const content = message?.content;
    if (typeof content === "string") firstUser = content.trim();
    else if (Array.isArray(content)) {
      firstUser = content
        .map((block) => objectField(block))
        .map((block) => stringField(block?.text))
        .filter((text): text is string => Boolean(text?.trim()))
        .join("\n\n")
        .trim();
    }
  }
  const fallbackDate = new Date(fileMtimeMs);
  return {
    cwd,
    title: firstUser || "(无用户消息)",
    createdAt: minDate ?? fallbackDate,
    lastUpdatedAt: maxDate ?? fallbackDate,
    preview: firstUser.slice(0, 280),
    messageCount: parse.okLines.length,
  };
}

function rowFromUsage(args: {
  source: SourceSession;
  parse: ParseJsonlResult | null;
  error: string | null;
  nowIso: string;
}): { row: ClaudeTokenUsageRow; events: ClaudeTokenEvent[] } {
  const usage = args.parse ? extractClaudeSessionUsage(args.parse) : undefined;
  const facts = args.parse
    ? fallbackFacts(args.parse, args.source.mtimeMs)
    : {
        cwd: "",
        title: "",
        createdAt: new Date(args.source.mtimeMs),
        lastUpdatedAt: new Date(args.source.mtimeMs),
        preview: "",
        messageCount: 0,
      };
  // Per-message-day events. Fallback for a message with no timestamp is the
  // session's created_at (a bounded past day) — NEVER last_updated_at, which
  // would re-dump the lifetime onto the last-touch day (the bug we're fixing).
  // On a parse error there are no events (the error row carries token_status
  // 'error' and contributes nothing to token sums anyway).
  const events = args.parse
    ? extractClaudeTokenEvents(args.parse, { fallbackIso: facts.createdAt.toISOString() })
    : [];
  const projectPath = args.source.decodedWorkspacePath || facts.cwd || args.source.fallbackProjectPath;
  const identity = normalizeWorkProjectIdentity({
    source: "claude-code",
    fallbackId: args.source.projectId,
    decodedWorkspacePath: args.source.decodedWorkspacePath,
    cwd: facts.cwd,
    workspacePath: projectPath,
    workspaceId: args.source.projectId,
  });
  const inputTokens = usage?.totalInputTokens ?? 0;
  const outputTokens = usage?.totalOutputTokens ?? 0;
  const cacheReadInputTokens = usage?.totalCacheReadInputTokens ?? 0;
  const cacheCreationInputTokens = usage?.totalCacheCreationInputTokens ?? 0;
  const model = args.parse ? extractClaudeDominantModel(args.parse) : null;
  const tokenStatus = args.error ? "error" : usage ? "full" : "unknown";
  const row: ClaudeTokenUsageRow = {
    session_id: args.source.id,
    project_id: args.source.projectId,
    file_path: args.source.filePath,
    file_mtime_ms: Math.trunc(args.source.mtimeMs),
    file_size_bytes: args.source.sizeBytes,
    cwd: facts.cwd,
    project_key: identity.key,
    project_path: identity.path,
    identity_confidence: identity.confidence,
    title: facts.title || null,
    created_at: isoOrNull(facts.createdAt),
    last_updated_at: isoOrNull(facts.lastUpdatedAt) ?? new Date(args.source.mtimeMs).toISOString(),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    preview: facts.preview || null,
    message_count: facts.messageCount,
    cache_read_input_tokens: cacheReadInputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    model,
    token_status: tokenStatus,
    parse_error: args.error,
    missing_since: null,
    source_seen_at: args.nowIso,
    updated_at: args.nowIso,
  };
  return { row, events };
}

async function sourceSessions(projectsRoot: string): Promise<SourceSession[]> {
  const projects = await listProjects(projectsRoot);
  const sessions: SourceSession[] = [];
  for (const project of projects) {
    const files = await listSessionJsonlFiles(project.path);
    for (const file of files) {
      sessions.push({
        id: `${project.id}:${file.id}`,
        projectId: project.id,
        filePath: file.filePath,
        decodedWorkspacePath: project.decodedWorkspacePath,
        fallbackProjectPath: project.decodedWorkspacePath ?? project.id,
        mtimeMs: file.mtimeMs,
        sizeBytes: file.size,
      });
    }
  }
  return sessions;
}

export async function refreshClaudeTokenUsage(
  db: Database.Database,
  options: RefreshClaudeTokenUsageOptions = {}
): Promise<ClaudeTokenUsageRefreshResult> {
  const started = Date.now();
  const refreshedAt = nowIso();
  const projectsRoot = resolveClaudeProjectsRoot(options.projectsRoot);
  const seen = new Set<string>();
  const errors: string[] = [];
  let sessions: SourceSession[] = [];

  // Self-heal: when the stored state's rule_version no longer matches the
  // running binary's CLAUDE_TOKEN_USAGE_RULE_VERSION, all previously-indexed
  // rows were produced by an older parser and may be incorrect. Force full
  // reparse for this one tick so the DB catches up. After this refresh
  // writes the new state row, subsequent ticks return to incremental mode.
  const storedState = getClaudeTokenUsageState(db);
  const ruleVersionStale =
    storedState != null &&
    storedState.rule_version !== CLAUDE_TOKEN_USAGE_RULE_VERSION;
  const effectiveOptions = ruleVersionStale ? { ...options, full: true } : options;

  try {
    sessions = await sourceSessions(projectsRoot);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  let indexedSessionCount = 0;
  let tokenKnownSessionCount = 0;
  let tokenUnknownSessionCount = 0;
  let errorSessionCount = 0;
  let skippedUnchangedCount = 0;

  for (const source of sessions) {
    seen.add(source.id);
    try {
      const st = await stat(source.filePath);
      const existing = getClaudeTokenUsageRow(db, source.id);
      if (
        !effectiveOptions.full &&
        existing &&
        existing.file_path === source.filePath &&
        existing.file_mtime_ms === Math.trunc(st.mtimeMs) &&
        existing.file_size_bytes === st.size
      ) {
        skippedUnchangedCount++;
        markClaudeTokenUsageRowSeen(db, source.id, refreshedAt);
        if (existing.token_status === "full") tokenKnownSessionCount++;
        else if (existing.token_status === "error") errorSessionCount++;
        else tokenUnknownSessionCount++;
        indexedSessionCount++;
        continue;
      }

      const text = await readFile(source.filePath, "utf8");
      const parse = parseJsonlText(text);
      const { row, events } = rowFromUsage({
        source: { ...source, mtimeMs: st.mtimeMs, sizeBytes: st.size },
        parse,
        error: parse.errors.length > 0 ? `${parse.errors.length} JSONL line(s) failed to parse` : null,
        nowIso: refreshedAt,
      });
      persistClaudeTokenUsage(db, row, events);
      indexedSessionCount++;
      if (row.token_status === "full") tokenKnownSessionCount++;
      else if (row.token_status === "error") errorSessionCount++;
      else tokenUnknownSessionCount++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push(`${source.id}: ${message}`);
      const { row, events } = rowFromUsage({
        source,
        parse: null,
        error: message,
        nowIso: refreshedAt,
      });
      persistClaudeTokenUsage(db, row, events);
      indexedSessionCount++;
      errorSessionCount++;
    }
  }

  const missingMarkedCount = markUnseenClaudeTokenRowsMissing(db, seen, refreshedAt);
  const duration = durationMs(started);
  const status = errors.length === 0 ? "success" : indexedSessionCount > 0 ? "partial" : "failed";
  upsertClaudeTokenUsageState(db, {
    // Only advance the rule_version on a real rebuild. A total failure (nothing
    // indexed) must keep the old version so the next tick re-forces the full
    // reparse that backfills claude_token_usage_event — otherwise a one-off
    // failure would permanently skip the day-timeline backfill.
    rule_version:
      status === "failed"
        ? storedState?.rule_version ?? CLAUDE_TOKEN_USAGE_RULE_VERSION
        : CLAUDE_TOKEN_USAGE_RULE_VERSION,
    last_rebuilt_at: status === "failed" ? null : refreshedAt,
    last_error: errors[0] ?? null,
    source_session_count: sessions.length,
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
    projectsRoot,
    sourceSessionCount: sessions.length,
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
