import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { GithubApiRepo, GithubApiStar } from "../src/github/fetcher.js";
import { upsertStar } from "../src/github/queries.js";
import {
  getRadarInsights,
  refreshRadarInsights,
  saveRadarInsightFeedback,
} from "../src/github/radarInsights/snapshot.js";
import { rebuildAllRepoTags } from "../src/github/tags.js";
import { runScan } from "../src/scan/runScan.js";
import { openDatabase } from "../src/store/open.js";

function freshDb() {
  const path = join(
    tmpdir(),
    `ai2nao-ghradarinsights-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  return openDatabase(path);
}

function freshWorkdir() {
  const root = join(
    tmpdir(),
    `ai2nao-ghradarwork-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(
    join(root, "TODOS.md"),
    "RAG dual retrieval debug view with agent workflow evidence and local-first memory\n"
  );
  writeFileSync(
    join(root, "docs", "radar.md"),
    "The current design connects agent workflow UI, local-first memory, and RAG evidence debugging.\n"
  );
  return root;
}

function freshEmptyWorkdir() {
  const root = join(
    tmpdir(),
    `ai2nao-ghradarempty-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(root, { recursive: true });
  return root;
}

function freshIndexedRepo(todoText: string) {
  const root = join(
    tmpdir(),
    `ai2nao-indexed-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "TODOS.md"), todoText);
  return root;
}

function repo(partial: Partial<GithubApiRepo>): GithubApiRepo {
  return {
    id: partial.id!,
    name: partial.name ?? `r${partial.id}`,
    full_name: partial.full_name ?? `u/r${partial.id}`,
    owner: { login: "u" },
    description: partial.description ?? null,
    private: false,
    fork: false,
    archived: partial.archived ?? false,
    default_branch: "main",
    html_url: partial.html_url ?? `https://example.com/${partial.id}`,
    clone_url: "https://example.com.git",
    language: partial.language ?? "TypeScript",
    topics: partial.topics ?? [],
    stargazers_count: partial.stargazers_count ?? 1,
    forks_count: 0,
    open_issues_count: 0,
    size: 0,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    pushed_at: partial.pushed_at ?? "2026-04-01T00:00:00Z",
    ...partial,
  };
}

function star(id: number, partial: Partial<GithubApiRepo> = {}): GithubApiStar {
  return {
    starred_at: partial.created_at ?? "2026-04-20T00:00:00Z",
    repo: repo({ id, ...partial }),
  };
}

describe("github radar insights", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => db.close());

  it("golden fixture connects starred repos to current work without raw excerpts", () => {
    upsertStar(
      db,
      star(1, {
        name: "agent-rag-kit",
        full_name: "acme/agent-rag-kit",
        description: "Agent workflow UI for RAG evidence debugging",
        topics: ["agent", "rag", "local-first", "evidence"],
        stargazers_count: 500,
      }),
      "2026-04-20T00:00:00Z"
    );
    upsertStar(
      db,
      star(2, {
        name: "css-buttons",
        full_name: "acme/css-buttons",
        description: "Button collection",
        topics: ["css"],
        stargazers_count: 5,
      }),
      "2026-04-21T00:00:00Z"
    );
    rebuildAllRepoTags(db);
    runScan(db, [freshWorkdir()]);

    const result = refreshRadarInsights(db, {
      cwd: freshEmptyWorkdir(),
      now: () => new Date("2026-05-03T00:00:00Z"),
    });

    expect(result.ok).toBe(true);
    const body = getRadarInsights(db);
    expect(body.meta.status).toBe("partial");
    expect(body.current_clues[0]).toMatchObject({
      kind: "recommended_now",
      health: "partial",
      repo_ids: [1],
    });
    expect(body.current_clues[0].title).toContain("acme/agent-rag-kit");
    expect(body.current_clues[0].terms).toEqual(
      expect.arrayContaining(["agent", "rag", "evidence"])
    );
    expect(body.current_clues[0].evidence.map((e) => e.source_kind)).toEqual(
      expect.arrayContaining(["todo", "doc", "topic"])
    );
    const payload = JSON.stringify(body.current_clues[0].evidence);
    expect(payload).not.toContain("RAG dual retrieval debug view");
    expect(payload).not.toContain(tmpdir());
  });

  it("reads TODOS from indexed local repos instead of only the current project", () => {
    upsertStar(
      db,
      star(1, {
        name: "agent-rag-kit",
        full_name: "acme/agent-rag-kit",
        description: "Agent workflow UI for RAG evidence debugging",
        topics: ["agent", "rag", "evidence"],
        stargazers_count: 500,
      }),
      "2026-04-20T00:00:00Z"
    );
    rebuildAllRepoTags(db);
    const cwd = freshEmptyWorkdir();
    const indexedRepo = freshIndexedRepo(
      "Build an agent workflow evidence panel for RAG debugging across local projects.\n"
    );
    runScan(db, [indexedRepo]);

    const result = refreshRadarInsights(db, {
      cwd,
      now: () => new Date("2026-05-03T00:00:00Z"),
    });

    expect(result.ok).toBe(true);
    const clue = getRadarInsights(db).current_clues[0];
    expect(clue).toMatchObject({
      kind: "recommended_now",
      repo_ids: [1],
    });
    const todoEvidence = clue.evidence.find((e) => e.source_kind === "todo");
    expect(todoEvidence?.source_path).toMatch(/TODOS\.md$/);
    expect(todoEvidence?.source_path).not.toContain(tmpdir());
    expect(JSON.stringify(clue.evidence)).not.toContain("Build an agent workflow evidence panel");
  });

  it("warns when there are no indexed local projects", () => {
    upsertStar(db, star(1, { topics: ["agent", "rag"] }), "2026-04-20T00:00:00Z");
    rebuildAllRepoTags(db);

    const result = refreshRadarInsights(db, {
      cwd: freshEmptyWorkdir(),
      now: () => new Date("2026-05-03T00:00:00Z"),
    });

    expect(result.ok).toBe(true);
    const body = getRadarInsights(db);
    expect(body.meta.status).toBe("partial");
    expect(body.meta.warnings.map((w) => w.code)).toContain("no_indexed_projects");
  });

  it("changes the project context fingerprint when indexed docs change", () => {
    upsertStar(db, star(1, { topics: ["agent", "rag"] }), "2026-04-20T00:00:00Z");
    rebuildAllRepoTags(db);
    const indexedRepo = freshIndexedRepo("Build an agent RAG workflow.\n");
    runScan(db, [indexedRepo]);
    refreshRadarInsights(db, {
      cwd: freshEmptyWorkdir(),
      now: () => new Date("2026-05-03T00:00:00Z"),
    });
    const before = getRadarInsights(db).meta.generated_at;
    const beforeHash = db
      .prepare("SELECT source_fingerprint_json FROM gh_radar_insight_snapshot WHERE generated_at = ?")
      .get(before) as { source_fingerprint_json: string };

    writeFileSync(join(indexedRepo, "TODOS.md"), "Build an agent RAG workflow with evidence replay.\n");
    runScan(db, [indexedRepo]);
    refreshRadarInsights(db, {
      cwd: freshEmptyWorkdir(),
      now: () => new Date("2026-05-04T00:00:00Z"),
    });
    const after = db
      .prepare(
        `SELECT source_fingerprint_json
         FROM gh_radar_insight_snapshot
         ORDER BY generated_at DESC, id DESC
         LIMIT 1`
      )
      .get() as { source_fingerprint_json: string };

    expect(JSON.parse(beforeHash.source_fingerprint_json).project_context_hash).not.toEqual(
      JSON.parse(after.source_fingerprint_json).project_context_hash
    );
  });

  it("returns empty when there are no stars", () => {
    const result = refreshRadarInsights(db, {
      cwd: freshWorkdir(),
      now: () => new Date("2026-05-03T00:00:00Z"),
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("empty");
    expect(getRadarInsights(db).meta.status).toBe("empty");
  });

  it("keeps the previous snapshot when a later refresh fails", () => {
    upsertStar(db, star(1, { topics: ["agent"] }), "2026-04-20T00:00:00Z");
    rebuildAllRepoTags(db);
    runScan(db, [freshWorkdir()]);
    const ok = refreshRadarInsights(db, {
      cwd: freshEmptyWorkdir(),
      now: () => new Date("2026-05-03T00:00:00Z"),
    });
    expect(ok.ok).toBe(true);
    const before = getRadarInsights(db).meta.generated_at;

    db.exec(
      `CREATE TRIGGER fail_radar_snapshot_insert
       BEFORE INSERT ON gh_radar_insight_snapshot
       BEGIN
         SELECT RAISE(FAIL, 'snapshot write blocked');
       END;`
    );
    const failed = refreshRadarInsights(db, {
      cwd: freshEmptyWorkdir(),
      now: () => new Date("2026-05-04T00:00:00Z"),
    });
    expect(failed.ok).toBe(false);
    expect(failed.status).toBe("error");
    expect(failed.previousSnapshot?.generated_at).toBe(before);
  });

  it("feedback suppresses the exact insight on the next refresh", () => {
    upsertStar(
      db,
      star(1, {
        full_name: "acme/agent-rag-kit",
        topics: ["agent", "rag", "evidence"],
      }),
      "2026-04-20T00:00:00Z"
    );
    rebuildAllRepoTags(db);
    const cwd = freshWorkdir();
    runScan(db, [cwd]);
    refreshRadarInsights(db, {
      cwd,
      now: () => new Date("2026-05-03T00:00:00Z"),
    });
    const first = getRadarInsights(db).current_clues[0];
    saveRadarInsightFeedback(
      db,
      {
        target_type: "insight",
        target_id: first.fingerprint,
        feedback: "wrong",
        insight_fingerprint: first.fingerprint,
        repo_id: 1,
        terms: first.terms,
      },
      new Date("2026-05-03T00:00:00Z")
    );

    refreshRadarInsights(db, {
      cwd,
      now: () => new Date("2026-05-04T00:00:00Z"),
    });

    expect(getRadarInsights(db).current_clues).toHaveLength(0);
  });
});
