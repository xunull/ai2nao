import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import {
  listProjects,
  listSessionJsonlFiles,
  resolveClaudeProjectsRoot,
} from "../claudeCodeHistory/index.js";
import {
  parseJsonlText as parseClaudeJsonlText,
  type ParseJsonlResult as ClaudeParseJsonlResult,
} from "../claudeCodeHistory/parseJsonl.js";
import { listCodexTranscriptFiles } from "../codexHistory/discover.js";
import { codexSessionsRoot, codexStateDbPath, resolveCodexRoot } from "../codexHistory/paths.js";
import {
  listAllThreadsFromStateDb,
  openCodexStateDb,
} from "../codexHistory/stateDb.js";
import type { CodexThreadRow } from "../codexHistory/types.js";
import { parseJsonlText, type ParseJsonlResult } from "../localJsonl/parse.js";
import { assertRealPathInsideRoot, isPathInsideRoot } from "../localJsonl/path.js";
import { normalizeWorkProjectIdentity } from "../workProjects/identity.js";
import { computeSessionDuration } from "./compute.js";
import {
  getWorkDurationRow,
  markUnseenWorkDurationRowsMissing,
  markWorkDurationRowSeen,
  upsertWorkDurationRow,
  upsertWorkDurationState,
} from "./queries.js";
import {
  WORK_DURATION_IDLE_THRESHOLD_MS,
  WORK_DURATION_RULE_VERSION,
  type WorkDurationCombinedRefreshResult,
  type WorkDurationRefreshResult,
  type WorkDurationRow,
  type WorkDurationSource,
} from "./types.js";

type ClaudeSourceSession = {
  id: string;
  projectId: string;
  filePath: string;
  decodedWorkspacePath: string | null;
  fallbackProjectPath: string;
  mtimeMs: number;
  sizeBytes: number;
};

type CodexSourceSession = {
  id: string;
  rolloutPath: string;
  cwd: string;
  title: string;
  createdAt: Date | null;
  lastUpdatedAt: Date | null;
};

export type RefreshClaudeWorkDurationOptions = {
  projectsRoot?: string;
  full?: boolean;
};

export type RefreshCodexWorkDurationOptions = {
  codexRoot?: string;
  full?: boolean;
  fallbackMaxFiles?: number;
};

export type RefreshWorkDurationOptions =
  RefreshClaudeWorkDurationOptions &
  RefreshCodexWorkDurationOptions;

function nowIso(): string {
  return new Date().toISOString();
}

function durationMs(started: number): number {
  return Date.now() - started;
}

function isoOrNull(date: Date | null | undefined): string | null {
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function timestampsFromParse(parse: ParseJsonlResult | ClaudeParseJsonlResult): Date[] {
  return parse.okLines
    .map(({ record }) => {
      const tsRaw = stringField(record.timestamp);
      return tsRaw ? new Date(tsRaw) : null;
    })
    .filter((date): date is Date => Boolean(date && !Number.isNaN(date.getTime())));
}

function claudeFacts(parse: ClaudeParseJsonlResult, fileMtimeMs: number): {
  cwd: string;
  title: string;
  createdAt: Date;
  lastUpdatedAt: Date;
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
  };
}

function codexFacts(parse: ParseJsonlResult, fileMtimeMs: number): {
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

function rowFromDuration(args: {
  source: WorkDurationSource;
  sessionId: string;
  transcriptPath: string;
  transcriptMtimeMs: number;
  transcriptSizeBytes: number;
  cwd: string;
  projectKey: string;
  projectPath: string;
  identityConfidence: "high" | "low";
  title: string | null;
  timestamps: Date[];
  error: string | null;
  nowIso: string;
}): WorkDurationRow {
  const computed = computeSessionDuration(
    args.timestamps,
    WORK_DURATION_IDLE_THRESHOLD_MS
  );
  const status = args.error ? "error" : computed ? "full" : "unknown";
  return {
    source: args.source,
    session_id: args.sessionId,
    transcript_path: args.transcriptPath,
    transcript_mtime_ms: Math.trunc(args.transcriptMtimeMs),
    transcript_size_bytes: args.transcriptSizeBytes,
    cwd: args.cwd,
    project_key: args.projectKey,
    project_path: args.projectPath,
    identity_confidence: args.identityConfidence,
    title: args.title,
    started_at: isoOrNull(computed?.startedAt),
    ended_at: isoOrNull(computed?.endedAt),
    wall_ms: computed?.wallMs ?? 0,
    active_ms: computed?.activeMs ?? 0,
    event_count: computed?.eventCount ?? 0,
    idle_threshold_ms: WORK_DURATION_IDLE_THRESHOLD_MS,
    duration_status: status,
    parse_error: args.error,
    missing_since: null,
    source_seen_at: args.nowIso,
    updated_at: args.nowIso,
  };
}

async function claudeSourceSessions(projectsRoot: string): Promise<ClaudeSourceSession[]> {
  const projects = await listProjects(projectsRoot);
  const sessions: ClaudeSourceSession[] = [];
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

function transcriptIdFromPath(filePath: string): string {
  const stem = filePath.split("/").pop()?.replace(/\.jsonl$/i, "") ?? filePath;
  const m = stem.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return m ? m[1] : stem;
}

async function codexSqliteSourceSessions(
  stateDbPath: string
): Promise<CodexSourceSession[]> {
  let db;
  try {
    db = openCodexStateDb(stateDbPath);
    const rows = listAllThreadsFromStateDb(db, stateDbPath, { archived: false });
    return rows.map((thread: CodexThreadRow) => ({
      id: thread.id,
      rolloutPath: thread.rolloutPath,
      cwd: thread.cwd,
      title: thread.title || thread.firstUserMessage || "",
      createdAt: thread.createdAt,
      lastUpdatedAt: thread.lastUpdatedAt,
    }));
  } finally {
    db?.close();
  }
}

async function codexFallbackSourceSessions(
  sessionsRoot: string,
  maxFiles: number
): Promise<CodexSourceSession[]> {
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

async function resolveCodexTranscriptPath(
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

export async function refreshClaudeWorkDuration(
  db: Database.Database,
  options: RefreshClaudeWorkDurationOptions = {}
): Promise<WorkDurationRefreshResult> {
  const started = Date.now();
  const refreshedAt = nowIso();
  const source: WorkDurationSource = "claude-code";
  const projectsRoot = resolveClaudeProjectsRoot(options.projectsRoot);
  const seen = new Set<string>();
  const errors: string[] = [];
  let sessions: ClaudeSourceSession[] = [];

  try {
    sessions = await claudeSourceSessions(projectsRoot);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  let indexedSessionCount = 0;
  let durationKnownSessionCount = 0;
  let durationUnknownSessionCount = 0;
  let errorSessionCount = 0;
  let skippedUnchangedCount = 0;

  for (const session of sessions) {
    seen.add(session.id);
    try {
      const st = await stat(session.filePath);
      const existing = getWorkDurationRow(db, source, session.id);
      if (
        !options.full &&
        existing &&
        existing.transcript_path === session.filePath &&
        existing.transcript_mtime_ms === Math.trunc(st.mtimeMs) &&
        existing.transcript_size_bytes === st.size
      ) {
        skippedUnchangedCount++;
        markWorkDurationRowSeen(db, source, session.id, refreshedAt);
        if (existing.duration_status === "full") durationKnownSessionCount++;
        else if (existing.duration_status === "error") errorSessionCount++;
        else durationUnknownSessionCount++;
        indexedSessionCount++;
        continue;
      }

      const parse = parseClaudeJsonlText(await readFile(session.filePath, "utf8"));
      const facts = claudeFacts(parse, st.mtimeMs);
      const projectPath = session.decodedWorkspacePath || facts.cwd || session.fallbackProjectPath;
      const identity = normalizeWorkProjectIdentity({
        source,
        fallbackId: session.projectId,
        decodedWorkspacePath: session.decodedWorkspacePath,
        cwd: facts.cwd,
        workspacePath: projectPath,
        workspaceId: session.projectId,
      });
      const row = rowFromDuration({
        source,
        sessionId: session.id,
        transcriptPath: session.filePath,
        transcriptMtimeMs: st.mtimeMs,
        transcriptSizeBytes: st.size,
        cwd: facts.cwd,
        projectKey: identity.key,
        projectPath: identity.path,
        identityConfidence: identity.confidence,
        title: facts.title || null,
        timestamps: timestampsFromParse(parse),
        error: parse.errors.length > 0 ? `${parse.errors.length} JSONL line(s) failed to parse` : null,
        nowIso: refreshedAt,
      });
      upsertWorkDurationRow(db, row);
      indexedSessionCount++;
      if (row.duration_status === "full") durationKnownSessionCount++;
      else if (row.duration_status === "error") errorSessionCount++;
      else durationUnknownSessionCount++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push(`${session.id}: ${message}`);
      const identity = normalizeWorkProjectIdentity({
        source,
        fallbackId: session.projectId,
        decodedWorkspacePath: session.decodedWorkspacePath,
        workspacePath: session.fallbackProjectPath,
        workspaceId: session.projectId,
      });
      upsertWorkDurationRow(db, rowFromDuration({
        source,
        sessionId: session.id,
        transcriptPath: session.filePath,
        transcriptMtimeMs: session.mtimeMs,
        transcriptSizeBytes: session.sizeBytes,
        cwd: "",
        projectKey: identity.key,
        projectPath: identity.path,
        identityConfidence: identity.confidence,
        title: null,
        timestamps: [],
        error: message,
        nowIso: refreshedAt,
      }));
      indexedSessionCount++;
      errorSessionCount++;
    }
  }

  const missingMarkedCount = markUnseenWorkDurationRowsMissing(db, source, seen, refreshedAt);
  const elapsed = durationMs(started);
  const status = errors.length === 0 ? "success" : indexedSessionCount > 0 ? "partial" : "failed";
  upsertWorkDurationState(db, {
    source,
    rule_version: WORK_DURATION_RULE_VERSION,
    last_rebuilt_at: status === "failed" ? null : refreshedAt,
    last_error: errors[0] ?? null,
    source_session_count: sessions.length,
    indexed_session_count: indexedSessionCount,
    duration_known_session_count: durationKnownSessionCount,
    duration_unknown_session_count: durationUnknownSessionCount,
    error_session_count: errorSessionCount,
    skipped_unchanged_count: skippedUnchangedCount,
    duration_ms: elapsed,
    updated_at: refreshedAt,
  });

  return {
    ok: status !== "failed",
    status,
    source,
    sourceSessionCount: sessions.length,
    indexedSessionCount,
    durationKnownSessionCount,
    durationUnknownSessionCount,
    errorSessionCount,
    skippedUnchangedCount,
    missingMarkedCount,
    durationMs: elapsed,
    errors,
  };
}

export async function refreshCodexWorkDuration(
  db: Database.Database,
  options: RefreshCodexWorkDurationOptions = {}
): Promise<WorkDurationRefreshResult> {
  const started = Date.now();
  const refreshedAt = nowIso();
  const source: WorkDurationSource = "codex";
  const codexRoot = resolveCodexRoot(options.codexRoot);
  const sessionsRoot = codexSessionsRoot(codexRoot);
  const stateDbPath = codexStateDbPath(codexRoot);
  const seen = new Set<string>();
  const errors: string[] = [];
  let sessions: CodexSourceSession[] = [];

  try {
    sessions = await codexSqliteSourceSessions(stateDbPath);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
    sessions = await codexFallbackSourceSessions(
      sessionsRoot,
      options.fallbackMaxFiles ?? 5000
    );
  }

  let indexedSessionCount = 0;
  let durationKnownSessionCount = 0;
  let durationUnknownSessionCount = 0;
  let errorSessionCount = 0;
  let skippedUnchangedCount = 0;

  for (const session of sessions) {
    seen.add(session.id);
    let filePath = session.rolloutPath;
    try {
      filePath = await resolveCodexTranscriptPath(sessionsRoot, session.rolloutPath);
      const st = await stat(filePath);
      const existing = getWorkDurationRow(db, source, session.id);
      if (
        !options.full &&
        existing &&
        existing.transcript_path === filePath &&
        existing.transcript_mtime_ms === Math.trunc(st.mtimeMs) &&
        existing.transcript_size_bytes === st.size
      ) {
        skippedUnchangedCount++;
        markWorkDurationRowSeen(db, source, session.id, refreshedAt);
        if (existing.duration_status === "full") durationKnownSessionCount++;
        else if (existing.duration_status === "error") errorSessionCount++;
        else durationUnknownSessionCount++;
        indexedSessionCount++;
        continue;
      }

      const parse = parseJsonlText(await readFile(filePath, "utf8"));
      const facts = codexFacts(parse, st.mtimeMs);
      const cwd = session.cwd || facts.cwd;
      const identity = normalizeWorkProjectIdentity({
        source,
        fallbackId: session.id,
        cwd,
        workspacePath: cwd,
        workspaceId: cwd,
      });
      const row = rowFromDuration({
        source,
        sessionId: session.id,
        transcriptPath: filePath,
        transcriptMtimeMs: st.mtimeMs,
        transcriptSizeBytes: st.size,
        cwd,
        projectKey: identity.key,
        projectPath: identity.path,
        identityConfidence: identity.confidence,
        title: session.title || facts.title || null,
        timestamps: timestampsFromParse(parse),
        error: parse.errors.length > 0 ? `${parse.errors.length} JSONL line(s) failed to parse` : null,
        nowIso: refreshedAt,
      });
      upsertWorkDurationRow(db, row);
      indexedSessionCount++;
      if (row.duration_status === "full") durationKnownSessionCount++;
      else if (row.duration_status === "error") errorSessionCount++;
      else durationUnknownSessionCount++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push(`${session.id}: ${message}`);
      const cwd = session.cwd || "";
      const identity = normalizeWorkProjectIdentity({
        source,
        fallbackId: session.id,
        cwd,
        workspacePath: cwd,
        workspaceId: cwd,
      });
      upsertWorkDurationRow(db, rowFromDuration({
        source,
        sessionId: session.id,
        transcriptPath: filePath,
        transcriptMtimeMs: Date.now(),
        transcriptSizeBytes: 0,
        cwd,
        projectKey: identity.key,
        projectPath: identity.path,
        identityConfidence: identity.confidence,
        title: session.title || null,
        timestamps: [],
        error: message,
        nowIso: refreshedAt,
      }));
      indexedSessionCount++;
      errorSessionCount++;
    }
  }

  const missingMarkedCount = markUnseenWorkDurationRowsMissing(db, source, seen, refreshedAt);
  const elapsed = durationMs(started);
  const status = errors.length === 0 ? "success" : indexedSessionCount > 0 ? "partial" : "failed";
  upsertWorkDurationState(db, {
    source,
    rule_version: WORK_DURATION_RULE_VERSION,
    last_rebuilt_at: status === "failed" ? null : refreshedAt,
    last_error: errors[0] ?? null,
    source_session_count: sessions.length,
    indexed_session_count: indexedSessionCount,
    duration_known_session_count: durationKnownSessionCount,
    duration_unknown_session_count: durationUnknownSessionCount,
    error_session_count: errorSessionCount,
    skipped_unchanged_count: skippedUnchangedCount,
    duration_ms: elapsed,
    updated_at: refreshedAt,
  });

  return {
    ok: status !== "failed",
    status,
    source,
    sourceSessionCount: sessions.length,
    indexedSessionCount,
    durationKnownSessionCount,
    durationUnknownSessionCount,
    errorSessionCount,
    skippedUnchangedCount,
    missingMarkedCount,
    durationMs: elapsed,
    errors,
  };
}

export async function refreshWorkDuration(
  db: Database.Database,
  options: RefreshWorkDurationOptions = {}
): Promise<WorkDurationCombinedRefreshResult> {
  const codex = await refreshCodexWorkDuration(db, options);
  const claude = await refreshClaudeWorkDuration(db, options);
  const status =
    codex.status === "failed" || claude.status === "failed"
      ? "failed"
      : codex.status === "partial" || claude.status === "partial"
        ? "partial"
        : "success";
  const errors = [...codex.errors, ...claude.errors];
  return { ok: status !== "failed", status, claude, codex, errors };
}
