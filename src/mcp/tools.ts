/**
 * The 3 read-only v1 MCP tools. Each is a thin wrapper over an existing
 * synchronous SELECT query. No filesystem reads, no LLM, no service wiring.
 *
 * project matching: an agent passes an arbitrary `project` string (a repo path
 * or name). We do NOT push it through the session-based dashboard normalizer
 * (wrong shape). Instead we query everything and match `project` case-insensitively
 * against project_key / project_path. No match -> { found: false, candidates }.
 *
 * payload control (Codex #8): every list result is capped to MAX_ITEMS and carries
 * a `truncated` flag; we never stream an unbounded map into the agent's context.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type Database from "better-sqlite3";
import { listClaudeProjectTokenUsage } from "../claudeTokenUsage/queries.js";
import { listWorkProjectDurationUsage } from "../workDuration/queries.js";
import { listProviders } from "../providers/store.js";

const MAX_ITEMS = 50;

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/** Cap a list to MAX_ITEMS, attach a truncated flag. */
function capped<T>(rows: T[]): { items: T[]; total: number; truncated: boolean } {
  return {
    items: rows.slice(0, MAX_ITEMS),
    total: rows.length,
    truncated: rows.length > MAX_ITEMS,
  };
}

/** Case-insensitive contains-match on key or path; "" matches all. */
function matches(key: string, path: string, project: string): boolean {
  if (!project) return true;
  const q = project.toLowerCase();
  return key.toLowerCase().includes(q) || path.toLowerCase().includes(q);
}

function parseSince(since?: string): Date | null {
  if (!since) return null;
  const ms = Date.parse(since);
  return Number.isNaN(ms) ? null : new Date(ms);
}

export function registerMcpTools(server: McpServer, db: Database.Database): void {
  server.registerTool(
    "project_tokens",
    {
      description:
        "Claude Code token usage per project (input/output/total tokens, session coverage). Optionally filter by a project name/path substring and a since-date (ISO).",
      inputSchema: {
        project: z.string().optional().describe("repo name or path substring; omit for all"),
        since: z.string().optional().describe("ISO date; only sessions updated on/after"),
      },
    },
    async ({ project, since }) => {
      const all = [...listClaudeProjectTokenUsage(db, { from: parseSince(since) }).values()];
      if (project) {
        const hit = all.filter((r) => matches(r.projectKey, r.projectPath, project));
        if (hit.length === 0) {
          return ok({
            found: false,
            candidates: all.slice(0, 10).map((r) => r.projectKey),
          });
        }
        return ok({ found: true, ...capped(hit) });
      }
      return ok(capped(all));
    }
  );

  server.registerTool(
    "time_spent",
    {
      description:
        "Honest active coding duration per project (de-duped active time, not wall clock). Optionally filter by project substring and since-date (ISO).",
      inputSchema: {
        project: z.string().optional().describe("repo name or path substring; omit for all"),
        since: z.string().optional().describe("ISO date lower bound"),
      },
    },
    async ({ project, since }) => {
      const all = [...listWorkProjectDurationUsage(db, { from: parseSince(since) }).values()];
      if (project) {
        const hit = all.filter((r) => matches(r.projectKey, r.projectPath, project));
        if (hit.length === 0) {
          return ok({
            found: false,
            candidates: all.slice(0, 10).map((r) => r.projectKey),
          });
        }
        return ok({ found: true, ...capped(hit) });
      }
      return ok(capped(all));
    }
  );

  server.registerTool(
    "external_usage",
    {
      description:
        "Remaining quota snapshot for configured external AI providers (e.g. MiniMax). Never returns API keys.",
      inputSchema: {},
    },
    async () => {
      // listProviders never returns api_key (only hasKey); safe to expose verbatim.
      return ok(capped(listProviders(db)));
    }
  );
}
