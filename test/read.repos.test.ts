import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { listRepos } from "../src/read/queries.js";

let base: string;
let db: Database.Database;

function seed(id: number, path: string, origin: string | null, scanned: string | null) {
  db.prepare(
    `INSERT INTO repos (id, path_canonical, origin_url, first_seen_at, last_scanned_at, last_job_id)
     VALUES (?, ?, ?, ?, ?, NULL)`
  ).run(id, path, origin, "2026-01-01", scanned);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ai2nao-lr-"));
  db = openDatabase(join(base, "idx.db"));
  seed(1, "/code/alpha", "https://github.com/x/alpha", "2026-06-03");
  seed(2, "/code/beta", null, "2026-06-01");
  seed(3, "/work/gamma", "https://github.com/x/gamma", "2026-06-02");
});
afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

const paths = (r: { rows: { path_canonical: string }[] }) => r.rows.map((x) => x.path_canonical);

describe("listRepos (server-side sort + search)", () => {
  it("defaults to most-recently-scanned first", () => {
    const r = listRepos(db, { limit: 25, offset: 0 });
    expect(r.total).toBe(3);
    expect(paths(r)).toEqual(["/code/alpha", "/work/gamma", "/code/beta"]); // scanned desc
  });

  it("sorts by path asc / desc via the allowlist", () => {
    expect(paths(listRepos(db, { limit: 25, offset: 0, sort: "path", dir: "asc" }))).toEqual([
      "/code/alpha",
      "/code/beta",
      "/work/gamma",
    ]);
    expect(paths(listRepos(db, { limit: 25, offset: 0, sort: "path", dir: "desc" }))).toEqual([
      "/work/gamma",
      "/code/beta",
      "/code/alpha",
    ]);
  });

  it("places null origins last when sorting by origin", () => {
    const r = listRepos(db, { limit: 25, offset: 0, sort: "origin", dir: "asc" });
    expect(r.rows[r.rows.length - 1].origin_url).toBeNull(); // beta (null) is last
  });

  it("filters by q across path and origin (substring)", () => {
    expect(paths(listRepos(db, { limit: 25, offset: 0, q: "code" }))).toHaveLength(2); // path match
    const byOrigin = listRepos(db, { limit: 25, offset: 0, q: "gamma" });
    expect(byOrigin.total).toBe(1);
    expect(byOrigin.rows[0].path_canonical).toBe("/work/gamma"); // origin match
  });

  it("paginates with limit/offset and reports filtered total", () => {
    const p1 = listRepos(db, { limit: 2, offset: 0, sort: "path", dir: "asc" });
    expect(p1.total).toBe(3);
    expect(paths(p1)).toEqual(["/code/alpha", "/code/beta"]);
    const p2 = listRepos(db, { limit: 2, offset: 2, sort: "path", dir: "asc" });
    expect(paths(p2)).toEqual(["/work/gamma"]);
  });

  it("ignores an unknown sort key (falls back to default)", () => {
    const r = listRepos(db, { limit: 25, offset: 0, sort: "DROP TABLE repos", dir: "asc" });
    expect(r.total).toBe(3); // no injection, safe default order
  });

  it("excludes missing repos by default, includes them with includeMissing", () => {
    db.prepare("UPDATE repos SET missing_since = 't' WHERE id = 2").run(); // beta gone
    const present = listRepos(db, { limit: 25, offset: 0 });
    expect(present.total).toBe(2);
    expect(present.rows.map((r) => r.id).sort()).toEqual([1, 3]);
    const all = listRepos(db, { limit: 25, offset: 0, includeMissing: true });
    expect(all.total).toBe(3);
  });
});
