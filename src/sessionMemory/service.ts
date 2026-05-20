import type Database from "better-sqlite3";
import type { AiEvidenceItem, AiEvidenceToolResult } from "../llmTools/evidence.js";
import {
  getSession as getCursorSession,
  searchSessions as searchCursorSessions,
} from "../cursorHistory/index.js";
import type {
  ChatSession,
  ChatSessionSummary,
  Message,
  SearchResult,
} from "../cursorHistory/types.js";
import { listProjects } from "../claudeCodeHistory/discover.js";
import {
  listSessionSummaries as listClaudeSessionSummaries,
  loadSessionDetail as loadClaudeSessionDetail,
} from "../claudeCodeHistory/load.js";
import { resolveClaudeProjectsRoot } from "../claudeCodeHistory/paths.js";
import {
  listCodexSessionSummaries,
  loadCodexSessionDetail,
} from "../codexHistory/load.js";
import {
  getLlmChatSession,
  listLlmChatSessions,
  type LlmChatMessageRow,
  type LlmChatSessionSummary,
} from "../llmChat/sessions.js";
import {
  SESSION_MEMORY_SOURCES,
  type NormalizedSessionMemoryRequest,
  type SessionMemoryHit,
  type SessionMemoryLimits,
  type SessionMemorySearchInput,
  type SessionMemoryService,
  type SessionMemoryServiceDeps,
  type SessionMemorySource,
  type SessionMemorySourceSearch,
} from "./types.js";

const DEFAULT_LIMITS: SessionMemoryLimits = {
  aiChatSessions: 100,
  codexSessions: 40,
  codexFallbackFiles: 300,
  claudeProjects: 20,
  claudeSessionsPerProject: 20,
  cursorResults: 20,
  snippetChars: 700,
};

const DEFAULT_COUNT = 8;
const MAX_COUNT = 12;
const MAX_QUERY_CHARS = 400;

export function createSessionMemoryService(
  deps: SessionMemoryServiceDeps = {}
): SessionMemoryService {
  return {
    async search(input, opts) {
      const started = Date.now();
      const normalized = normalizeInput(input);
      if (!normalized.ok) {
        return sessionMemoryError(normalized.code, normalized.message, false);
      }
      if (opts?.signal?.aborted) {
        return sessionMemoryError("aborted", "Session memory search was aborted.", true);
      }

      const runners = createSourceRunners(deps);
      const warnings: string[] = [];
      const hits: SessionMemoryHit[] = [];

      for (const source of normalized.request.sources) {
        if (opts?.signal?.aborted) {
          return sessionMemoryError("aborted", "Session memory search was aborted.", true);
        }
        try {
          const sourceHits = await runners[source](normalized.request, DEFAULT_LIMITS);
          hits.push(...sourceHits);
        } catch (e) {
          warnings.push(`${source}: ${errorMessage(e)}`);
        }
      }

      if (hits.length === 0 && warnings.length === normalized.request.sources.length) {
        return sessionMemoryError(
          "session_memory_unavailable",
          "Session memory sources could not be searched.",
          true
        );
      }

      const now = (deps.now ?? (() => new Date()))().toISOString();
      const evidence = rankHits(hits)
        .slice(0, normalized.request.count)
        .map<AiEvidenceItem>((hit, index) => ({
          id: `session-${hit.source}-${safeId(hit.sessionId)}-${index + 1}`,
          source: "session",
          title: `${sourceLabel(hit.source)}: ${hit.title || hit.sessionId}`,
          path: hit.workspacePath || `${hit.source}:${hit.sessionId}`,
          snippet: truncate(
            [hit.role ? `${hit.role}: ${hit.snippet}` : hit.snippet].filter(Boolean).join(" "),
            DEFAULT_LIMITS.snippetChars
          ),
          rank: index + 1,
          provider: hit.source,
          fetchedAt: hit.updatedAt ?? now,
          matchedBy: ["session-memory", hit.source],
        }));

      return {
        ok: true,
        kind: "evidence",
        source: "session",
        query: normalized.request.query,
        reason: normalized.request.reason,
        generatedAt: now,
        evidence,
        meta: {
          provider: "session-memory",
          durationMs: Date.now() - started,
          warnings: warnings.length > 0 ? warnings : undefined,
        },
      };
    },
  };
}

function createSourceRunners(
  deps: SessionMemoryServiceDeps
): Record<SessionMemorySource, SessionMemorySourceSearch> {
  return {
    "ai-chat":
      deps.sources?.["ai-chat"] ??
      ((request, limits) => searchAiChatMemory(deps.db, request, limits)),
    codex:
      deps.sources?.codex ??
      ((request, limits) => searchCodexMemory(request, limits)),
    "claude-code":
      deps.sources?.["claude-code"] ??
      ((request, limits) => searchClaudeCodeMemory(request, limits)),
    cursor:
      deps.sources?.cursor ??
      ((request, limits) => searchCursorMemory(request, limits)),
  };
}

function normalizeInput(input: SessionMemorySearchInput):
  | { ok: true; request: NormalizedSessionMemoryRequest }
  | { ok: false; code: string; message: string } {
  const query = normalizeText(input.query).slice(0, MAX_QUERY_CHARS);
  if (!query) {
    return {
      ok: false,
      code: "invalid_query",
      message: "Session memory query must not be empty.",
    };
  }

  const rawCount = Number.isFinite(input.count) ? Math.trunc(input.count ?? DEFAULT_COUNT) : DEFAULT_COUNT;
  const count = Math.min(MAX_COUNT, Math.max(1, rawCount || DEFAULT_COUNT));
  const sourceSet = new Set<SessionMemorySource>(
    Array.isArray(input.sources)
      ? input.sources.filter((s): s is SessionMemorySource =>
          (SESSION_MEMORY_SOURCES as readonly string[]).includes(s)
        )
      : SESSION_MEMORY_SOURCES
  );
  const sources = [...sourceSet];
  if (sources.length === 0) {
    return {
      ok: false,
      code: "invalid_sources",
      message: "Session memory source list is empty.",
    };
  }

  const queryLower = query.toLowerCase();
  return {
    ok: true,
    request: {
      query,
      queryLower,
      reason: normalizeOptional(input.reason),
      count,
      sources,
      tokens: queryTokens(queryLower),
    },
  };
}

async function searchAiChatMemory(
  db: Database.Database | undefined,
  request: NormalizedSessionMemoryRequest,
  limits: SessionMemoryLimits
): Promise<SessionMemoryHit[]> {
  if (!db) return [];
  const summaries = listLlmChatSessions(db, limits.aiChatSessions);
  const hits: SessionMemoryHit[] = [];

  for (const summary of summaries) {
    const detail = getLlmChatSession(db, summary.id);
    if (!detail) continue;
    const hit = hitFromLlmChatSession(summary, detail.messages, request, limits);
    if (hit) hits.push(hit);
  }

  return hits;
}

async function searchCodexMemory(
  request: NormalizedSessionMemoryRequest,
  limits: SessionMemoryLimits
): Promise<SessionMemoryHit[]> {
  const listed = await listCodexSessionSummaries(undefined, {
    archived: false,
    limit: limits.codexSessions,
    maxFiles: limits.codexFallbackFiles,
  });
  const hits: SessionMemoryHit[] = [];

  for (const summary of listed.sessions.slice(0, limits.codexSessions)) {
    const detail = await loadCodexSessionDetail(undefined, summary.id).catch(() => null);
    const hit = detail
      ? hitFromChatSession("codex", detail.session, request, limits)
      : hitFromSummary("codex", summary, request, limits);
    if (hit) hits.push(hit);
  }

  return hits;
}

async function searchClaudeCodeMemory(
  request: NormalizedSessionMemoryRequest,
  limits: SessionMemoryLimits
): Promise<SessionMemoryHit[]> {
  const root = resolveClaudeProjectsRoot();
  const projects = await listProjects(root);
  const hits: SessionMemoryHit[] = [];

  for (const project of projects.slice(0, limits.claudeProjects)) {
    const summaries = await listClaudeSessionSummaries(root, project.id).catch(() => []);
    for (const summary of summaries.slice(0, limits.claudeSessionsPerProject)) {
      const detail = await loadClaudeSessionDetail(root, project.id, summary.id).catch(() => null);
      const hit = detail
        ? hitFromChatSession("claude-code", detail.session, request, limits)
        : hitFromSummary("claude-code", summary, request, limits);
      if (hit) hits.push(hit);
    }
  }

  return hits;
}

async function searchCursorMemory(
  request: NormalizedSessionMemoryRequest,
  limits: SessionMemoryLimits
): Promise<SessionMemoryHit[]> {
  const results = await searchCursorSessions(request.query, {
    limit: limits.cursorResults,
    contextChars: Math.floor(limits.snippetChars / 2),
  });
  const hits: SessionMemoryHit[] = [];

  for (const result of results) {
    const detail = await getCursorSession(result.index).catch(() => null);
    const snippet = cursorSnippet(result);
    hits.push({
      source: "cursor",
      sessionId: result.sessionId,
      title: detail?.title || `Cursor session ${result.index}`,
      workspacePath: result.workspacePath || detail?.workspacePath,
      role: result.snippets[0]?.messageRole,
      snippet,
      score: 10 + result.matchCount,
      updatedAt: detail?.lastUpdatedAt?.toISOString() ?? result.createdAt.toISOString(),
    });
  }

  return hits;
}

function hitFromLlmChatSession(
  summary: LlmChatSessionSummary,
  messages: LlmChatMessageRow[],
  request: NormalizedSessionMemoryRequest,
  limits: SessionMemoryLimits
): SessionMemoryHit | null {
  let best: SessionMemoryHit | null = null;
  const summaryText = `${summary.title} ${summary.last_message_at ?? ""}`;
  const summaryScore = scoreText(summaryText, request);
  if (summaryScore > 0) {
    best = {
      source: "ai-chat",
      sessionId: summary.id,
      title: summary.title,
      snippet: summary.title,
      score: summaryScore,
      updatedAt: summary.last_message_at ?? summary.updated_at,
    };
  }

  for (const message of messages) {
    const text = normalizeText(message.plain_text || message.preview);
    const score = scoreText(text, request);
    if (score <= 0) continue;
    const hit: SessionMemoryHit = {
      source: "ai-chat",
      sessionId: summary.id,
      title: summary.title,
      snippet: snippetAround(text, request, limits.snippetChars),
      score: score + roleBoost(message.role),
      role: message.role,
      updatedAt: message.updated_at || summary.last_message_at || summary.updated_at,
    };
    if (!best || hit.score > best.score) best = hit;
  }

  return best;
}

function hitFromChatSession(
  source: SessionMemorySource,
  session: ChatSession,
  request: NormalizedSessionMemoryRequest,
  limits: SessionMemoryLimits
): SessionMemoryHit | null {
  let best = hitFromSummary(
    source,
    {
      id: session.id,
      index: session.index,
      title: session.title,
      createdAt: session.createdAt,
      lastUpdatedAt: session.lastUpdatedAt,
      messageCount: session.messageCount,
      workspaceId: session.workspaceId,
      workspacePath: session.workspacePath ?? "",
      preview: "",
    },
    request,
    limits
  );

  for (const message of session.messages) {
    const text = normalizeText(message.content);
    const score = scoreText(text, request);
    if (score <= 0) continue;
    const hit: SessionMemoryHit = {
      source,
      sessionId: session.id,
      title: session.title || session.id,
      workspacePath: session.workspacePath,
      role: message.role,
      snippet: snippetAround(text, request, limits.snippetChars),
      score: score + roleBoost(message.role),
      updatedAt: message.timestamp.toISOString(),
    };
    if (!best || hit.score > best.score) best = hit;
  }

  return best;
}

function hitFromSummary(
  source: SessionMemorySource,
  summary: ChatSessionSummary,
  request: NormalizedSessionMemoryRequest,
  limits: SessionMemoryLimits
): SessionMemoryHit | null {
  const text = normalizeText(`${summary.title ?? ""} ${summary.preview ?? ""} ${summary.workspacePath ?? ""}`);
  const score = scoreText(text, request);
  if (score <= 0) return null;
  return {
    source,
    sessionId: summary.id,
    title: summary.title || summary.id,
    workspacePath: summary.workspacePath,
    snippet: snippetAround(text, request, limits.snippetChars),
    score,
    updatedAt: summary.lastUpdatedAt.toISOString(),
  };
}

function cursorSnippet(result: SearchResult): string {
  const snippets = result.snippets.slice(0, 2).map((snippet) => normalizeText(snippet.text));
  return snippets.join(" ... ");
}

function rankHits(hits: SessionMemoryHit[]): SessionMemoryHit[] {
  return [...hits].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return timestampMs(b.updatedAt) - timestampMs(a.updatedAt);
  });
}

function scoreText(text: string, request: NormalizedSessionMemoryRequest): number {
  const lower = text.toLowerCase();
  let score = lower.includes(request.queryLower) ? 24 : 0;
  for (const token of request.tokens) {
    if (lower.includes(token)) score += token.length >= 4 ? 5 : 3;
  }
  return score;
}

function snippetAround(
  text: string,
  request: NormalizedSessionMemoryRequest,
  maxChars: number
): string {
  const clean = normalizeText(text);
  if (clean.length <= maxChars) return clean;
  const lower = clean.toLowerCase();
  let idx = lower.indexOf(request.queryLower);
  if (idx < 0) {
    idx = request.tokens.map((token) => lower.indexOf(token)).find((pos) => pos >= 0) ?? 0;
  }
  const context = Math.max(80, Math.floor(maxChars / 2));
  const start = Math.max(0, idx - context);
  const end = Math.min(clean.length, idx + request.query.length + context);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < clean.length ? "..." : "";
  return `${prefix}${clean.slice(start, end)}${suffix}`;
}

function queryTokens(queryLower: string): string[] {
  const tokens = queryLower
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 8);
  return tokens.length > 0 ? tokens : [queryLower];
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeOptional(value: string | undefined): string | undefined {
  const clean = typeof value === "string" ? normalizeText(value) : "";
  return clean || undefined;
}

function roleBoost(role: Message["role"] | LlmChatMessageRow["role"]): number {
  if (role === "user") return 2;
  if (role === "assistant") return 1;
  return 0;
}

function truncate(value: string, maxChars: number): string {
  const clean = normalizeText(value);
  return clean.length > maxChars ? `${clean.slice(0, Math.max(0, maxChars - 3))}...` : clean;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 80) || "unknown";
}

function timestampMs(value: string | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function sourceLabel(source: SessionMemorySource): string {
  if (source === "ai-chat") return "AI Chat";
  if (source === "claude-code") return "Claude Code";
  if (source === "codex") return "Codex";
  return "Cursor";
}

function sessionMemoryError(
  code: string,
  message: string,
  recoverable: boolean
): AiEvidenceToolResult {
  return {
    ok: false,
    kind: "evidence_error",
    source: "session",
    code,
    message,
    recoverable,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
