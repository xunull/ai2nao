// 时区必须在任何 import 之前定,否则 better-sqlite3 的 localtime 会按运行机器时区跑。
process.env.TZ = "Asia/Shanghai";

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { slugFromPath } from "../src/agentUserMessages/projectKey.js";
import {
  buildRepoSlugMap,
  canonicalProject,
  displayName,
} from "../src/projectCalendar/projectRollup.js";

// gitleaks:全部用假的绝对路径,不写任何真实 home 路径。
function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "project-calendar-rollup-"));
  return openDatabase(join(dir, "test.db"));
}

function seedRepos(db: Database.Database, paths: string[]): void {
  const stmt = db.prepare(
    `INSERT INTO repos (path_canonical, first_seen_at) VALUES (?, ?)`
  );
  for (const p of paths) stmt.run(p, "2026-07-01T00:00:00.000Z");
}

describe("buildRepoSlugMap", () => {
  it("把每个 repo 根正向编码成 slug,并留住真实路径", () => {
    const db = freshDb();
    seedRepos(db, ["/w/x/ai2nao", "/w/y/gstack"]);

    const map = buildRepoSlugMap(db);

    expect(map.get("-w-x-ai2nao")).toEqual({
      path: "/w/x/ai2nao",
      ambiguous: false,
    });
    expect(map.get("-w-y-gstack")).toEqual({
      path: "/w/y/gstack",
      ambiguous: false,
    });
    expect(map.size).toBe(2);
  });

  it("去掉路径尾部斜杠后再编码(与 slugFromPath 一致)", () => {
    const db = freshDb();
    seedRepos(db, ["/w/x/ai2nao/"]);

    expect(buildRepoSlugMap(db).get("-w-x-ai2nao")?.path).toBe("/w/x/ai2nao/");
  });

  it("跳过 slugFromPath 编不出来的行(非绝对路径 / 根),不崩", () => {
    const db = freshDb();
    seedRepos(db, ["relative/path", "/", "/w/x/ok"]);

    const map = buildRepoSlugMap(db);

    expect([...map.keys()]).toEqual(["-w-x-ok"]);
  });

  it("忽略 missing_since 非空的仓库(已消失的 repo 不参与归属)", () => {
    const db = freshDb();
    seedRepos(db, ["/w/x/alive", "/w/x/gone"]);
    db.prepare(
      `UPDATE repos SET missing_since = ? WHERE path_canonical = ?`
    ).run("2026-07-20T00:00:00.000Z", "/w/x/gone");

    const map = buildRepoSlugMap(db);

    expect(map.has("-w-x-alive")).toBe(true);
    expect(map.has("-w-x-gone")).toBe(false);
  });

  it("两个真实路径编码成同一个 slug 时标 ambiguous,不按插入顺序赌一个", () => {
    const db = freshDb();
    // 编码有损:'/' → '-',所以下面两条真实路径编码后完全相同。
    seedRepos(db, ["/w/x/foo-bar", "/w/x/foo/bar"]);
    expect(slugFromPath("/w/x/foo-bar")).toBe(slugFromPath("/w/x/foo/bar"));

    const entry = buildRepoSlugMap(db).get("-w-x-foo-bar");

    expect(entry?.ambiguous).toBe(true);
    expect(entry?.path).toBeNull();
  });
});

describe("canonicalProject", () => {
  it("精确命中 repo 根 → 拿到真实路径", () => {
    const db = freshDb();
    seedRepos(db, ["/w/x/ai2nao"]);
    const map = buildRepoSlugMap(db);

    expect(canonicalProject("-w-x-ai2nao", map)).toEqual({
      key: "-w-x-ai2nao",
      path: "/w/x/ai2nao",
    });
  });

  it("★兄弟仓库不许被吞★ new-api-2 不归进 new-api", () => {
    const db = freshDb();
    seedRepos(db, ["/w/x/new-api", "/w/x/new-api-2"]);
    const map = buildRepoSlugMap(db);

    // 两者都精确命中各自的 repo,互不干扰。
    expect(canonicalProject("-w-x-new-api", map).key).toBe("-w-x-new-api");
    expect(canonicalProject("-w-x-new-api-2", map).key).toBe("-w-x-new-api-2");
    expect(canonicalProject("-w-x-new-api-2", map).path).toBe("/w/x/new-api-2");
  });

  it("★不做子目录归并★ 子目录会话保持独立,不并进父 repo", () => {
    const db = freshDb();
    seedRepos(db, ["/w/x/gbrain"]);
    const map = buildRepoSlugMap(db);

    // R3:前缀归并在有损 slug 上不成立,整个砍掉。gbrain-src 单独成行。
    expect(canonicalProject("-w-x-gbrain-src", map)).toEqual({
      key: "-w-x-gbrain-src",
      path: null,
    });
  });

  it("★前缀不再被当成归并依据★ 非 repo 目录不会被静默吞进同前缀的 repo", () => {
    const db = freshDb();
    seedRepos(db, ["/w/x/foo"]);
    const map = buildRepoSlugMap(db);

    // 真实路径 /w/x/foo-bar 与 repo /w/x/foo 毫无祖先关系,
    // 但字符串上 '-w-x-foo-bar' 以 '-w-x-foo' + '-' 开头。旧的前缀兜底会吞掉它。
    expect(canonicalProject("-w-x-foo-bar", map)).toEqual({
      key: "-w-x-foo-bar",
      path: null,
    });
  });

  it("归不到任何 repo → 原样返回,path 为 null", () => {
    const db = freshDb();
    seedRepos(db, ["/w/x/ai2nao"]);
    const map = buildRepoSlugMap(db);

    expect(canonicalProject("-w-z-somewhere-else", map)).toEqual({
      key: "-w-z-somewhere-else",
      path: null,
    });
  });

  it("命中的是 ambiguous slug → 不装确定,path 为 null", () => {
    const db = freshDb();
    seedRepos(db, ["/w/x/foo-bar", "/w/x/foo/bar"]);
    const map = buildRepoSlugMap(db);

    expect(canonicalProject("-w-x-foo-bar", map)).toEqual({
      key: "-w-x-foo-bar",
      path: null,
    });
  });

  it("repos 表为空(新装用户)→ 一切原样,不崩", () => {
    const db = freshDb();
    const map = buildRepoSlugMap(db);

    expect(canonicalProject("-w-x-ai2nao", map)).toEqual({
      key: "-w-x-ai2nao",
      path: null,
    });
  });
});

describe("displayName", () => {
  it("有真实路径 → 取 basename", () => {
    expect(displayName("-w-x-ai2nao", "/w/x/ai2nao")).toBe("ai2nao");
  });

  it("有真实路径且带尾斜杠 → 仍取得到 basename", () => {
    expect(displayName("-w-x-ai2nao", "/w/x/ai2nao/")).toBe("ai2nao");
  });

  it("★无路径时整个 slug 原样返回,绝不在 '-' 上拆★", () => {
    // R3 的理由就是 '-' 边界不可信;取尾段等于重新犯那个错
    // (-w-x-new-api-2 取尾段会得到 "2")。
    expect(displayName("-w-x-new-api-2", null)).toBe("-w-x-new-api-2");
    expect(displayName("-w-x-gbrain-src", null)).toBe("-w-x-gbrain-src");
  });
});
