import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { listHuggingfaceModels } from "../src/huggingface/queries.js";

let base: string;
let db: Database.Database;
const ROOT = "/cache";

function seed(repo_id: string, size: number, missing = false) {
  db.prepare(
    `INSERT INTO huggingface_models
       (repo_type, repo_id, cache_root, cache_dir, size_bytes, missing_since,
        first_seen_at, last_seen_at, inserted_at, updated_at)
     VALUES ('model', ?, ?, ?, ?, ?, 't', 't', 't', 't')`
  ).run(repo_id, ROOT, `/d/${repo_id}`, size, missing ? "2026-06-01T00:00:00Z" : null);
}

function ids(opts: { sort?: string; dir?: "asc" | "desc"; includeMissing?: boolean }) {
  return listHuggingfaceModels(db, {
    cacheRoot: ROOT,
    limit: 50,
    offset: 0,
    includeMissing: opts.includeMissing ?? true,
    sort: opts.sort,
    dir: opts.dir,
  }).rows.map((r) => r.repo_id);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ai2nao-hfsort-"));
  db = openDatabase(join(base, "idx.db"));
  seed("bbb", 300);
  seed("aaa", 100);
  seed("ccc", 200, true); // missing -> always sinks below present
});
afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

describe("listHuggingfaceModels server-side sort", () => {
  it("default (no sort param) = size DESC, missing last", () => {
    expect(ids({})).toEqual(["bbb", "aaa", "ccc"]); // 300,100 present desc; ccc missing last
  });

  it("sort=size dir=asc flips order but keeps missing last", () => {
    expect(ids({ sort: "size", dir: "asc" })).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("sort=name sorts by repo_id (default asc)", () => {
    expect(ids({ sort: "name" })).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("sort=name dir=desc", () => {
    // present rows by repo_id desc (bbb, aaa); missing ccc still last
    expect(ids({ sort: "name", dir: "desc" })).toEqual(["bbb", "aaa", "ccc"]);
  });

  it("unknown sort key falls back to the default order (no injection)", () => {
    expect(ids({ sort: "size_bytes; DROP TABLE huggingface_models", dir: "asc" })).toEqual([
      "bbb",
      "aaa",
      "ccc",
    ]);
    // table still intact
    expect(db.prepare("SELECT COUNT(*) n FROM huggingface_models").get()).toMatchObject({ n: 3 });
  });
});
