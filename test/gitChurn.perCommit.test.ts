import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate, SCHEMA_VERSION } from "../src/store/migrations.js";
import { collectRepoChurn, GIT_CHURN_RULE_VERSION } from "../src/gitChurn/collect.js";

/**
 * per-commit churn 存储（V60）。
 *
 * v1 存到 `(project_key, day)`，增量写入是**累加**——同一提交扫两次数字就翻倍。
 * 那套 `merge-base --is-ancestor` + 两路写 + 删窗 + 「重扫不双重计数」CRITICAL 单测，
 * 全是为了守住那个脆弱语义。换成 `(project_key, sha)` 主键后写入是
 * `INSERT OR REPLACE`，**幂等由主键保证**。
 *
 * 下面三条盯的是对抗性冷读在真库里找到的三个反例，每一条单独存在都会静默出错。
 */

const AUTHOR = "dev@example.com";

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

function freshDb(): Database.Database {
  const db = new Database(join(mkdtempSync(join(tmpdir(), "ai2nao-pcc-")), "t.db"));
  migrate(db);
  return db;
}

/** 造一个只有一个提交的仓库。`authorDate` 与 `committerDate` 可以分开给。 */
function makeRepo(o: { file: string; lines: number; authorDate: string; committerDate?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", AUTHOR]);
  git(dir, ["config", "user.name", "Dev"]);
  mkdirSync(join(dir, "src"), { recursive: true });
  const body = Array.from({ length: o.lines }, (_, i) => `line ${i}`).join("\n") + "\n";
  writeFileSync(join(dir, o.file), body);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "seed"], {
    GIT_AUTHOR_DATE: o.authorDate,
    GIT_COMMITTER_DATE: o.committerDate ?? o.authorDate,
  });
  return dir;
}

/** collectRepoChurn 是 async —— 不 await 的话断言会在采集完成前就跑。 */
const collect = async (db: Database.Database, repo: string, floorSince: Date) =>
  await collectRepoChurn(db, { repoPath: repo, authorEmail: AUTHOR, floorSince });

describe("V60 迁移", () => {
  it("git_line_churn 变成视图，git_commit_churn 是表", async () => {
    const db = freshDb();
    expect(
      (db.prepare("SELECT version v FROM meta_schema WHERE id=1").get() as { v: number }).v
    ).toBe(SCHEMA_VERSION);
    const kinds = Object.fromEntries(
      (
        db
          .prepare(
            "SELECT name, type FROM sqlite_master WHERE name IN ('git_line_churn','git_commit_churn')"
          )
          .all() as { name: string; type: string }[]
      ).map((r) => [r.name, r.type])
    );
    expect(kinds).toEqual({ git_line_churn: "view", git_commit_churn: "table" });
    db.close();
  });

  it("视图不可写 —— 老的写入路径会响亮地失败，不会静默写进别处", async () => {
    const db = freshDb();
    expect(() =>
      db
        .prepare(
          "INSERT INTO git_line_churn (project_key, day, added, deleted, commits) VALUES ('/p','2026-01-01',1,0,1)"
        )
        .run()
    ).toThrow(/view/i);
    db.close();
  });

  it("重复执行迁移不炸 —— 守卫早退，不是 UNIQUE 冲突", async () => {
    const db = freshDb();
    expect(() => migrate(db)).not.toThrow();
    expect(() => migrate(db)).not.toThrow();
    db.close();
  });

  it("queries.ts 的过滤列 day 有索引 —— 少了它视图退化成全表扫", async () => {
    const db = freshDb();
    const idx = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='git_commit_churn' AND sql IS NOT NULL"
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(idx).toContain("idx_git_commit_churn_day");
    db.close();
  });
});

describe("per-commit 采集", () => {
  it("一个提交一行，带 sha 与作者", async () => {
    const db = freshDb();
    const repo = makeRepo({ file: "src/a.ts", lines: 10, authorDate: "2026-06-20T12:00:00+08:00" });
    await collect(db, repo, new Date("2026-01-01T00:00:00Z"));

    const rows = db
      .prepare("SELECT sha, author_email AS ae, day, added, is_legacy AS lg FROM git_commit_churn")
      .all() as { sha: string; ae: string; day: string; added: number; lg: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(rows[0]!.ae).toBe(AUTHOR);
    expect(rows[0]!.added).toBe(10);
    expect(rows[0]!.lg).toBe(0);
    db.close();
  });

  it("authored_at 归一到 UTC —— 混合偏移的 TEXT 列没法做字符串比较", async () => {
    const db = freshDb();
    const repo = makeRepo({ file: "src/a.ts", lines: 3, authorDate: "2026-06-20T12:00:00+08:00" });
    await collect(db, repo, new Date("2026-01-01T00:00:00Z"));
    const at = (
      db.prepare("SELECT authored_at AS at FROM git_commit_churn").get() as { at: string }
    ).at;
    expect(at).toBe("2026-06-20T04:00:00.000Z"); // +08:00 12:00 → 04:00Z
    db.close();
  });

  it("视图聚合回 v1 的形状", async () => {
    const db = freshDb();
    const repo = makeRepo({ file: "src/a.ts", lines: 7, authorDate: "2026-06-20T12:00:00+08:00" });
    await collect(db, repo, new Date("2026-01-01T00:00:00Z"));
    const row = db
      .prepare("SELECT day, added, deleted, commits FROM git_line_churn")
      .get() as { day: string; added: number; deleted: number; commits: number };
    expect(row).toEqual({ day: "2026-06-20", added: 7, deleted: 0, commits: 1 });
    db.close();
  });

  /**
   * 冷读反例 ①：真库 `xibahe-rag` 被 clone 到两个路径，HEAD 相同，
   * 28 个 sha 同属两个 project_key。
   *
   * 若主键只是 `sha`，并发采集下后写的会覆盖先写的 project_key，
   * 另一个项目产出**静默归零**，而且下轮 incremental 的 `last_sha..HEAD` 是空的，
   * **永远不会自己修回来**。
   */
  it("同一个 sha 出现在两个 project_key 下 —— 两个项目的产出都在", async () => {
    const db = freshDb();
    const a = makeRepo({ file: "src/a.ts", lines: 12, authorDate: "2026-06-20T12:00:00+08:00" });
    // 把同一个仓库 clone 到第二个路径：两边 sha 完全相同。
    const b = mkdtempSync(join(tmpdir(), "ai2nao-clone-"));
    execFileSync("git", ["clone", "-q", a, b]);
    expect(git(a, ["rev-parse", "HEAD"])).toBe(git(b, ["rev-parse", "HEAD"]));

    const floor = new Date("2026-01-01T00:00:00Z");
    await collect(db, a, floor);
    await collect(db, b, floor);

    const byProject = db
      .prepare("SELECT project_key AS pk, SUM(added) AS added FROM git_line_churn GROUP BY project_key")
      .all() as { pk: string; added: number }[];
    // 主键只有 sha 时这里是 1 行；正确实现是两行，各 12。
    expect(byProject).toHaveLength(2);
    expect(byProject.every((r) => r.added === 12)).toBe(true);
    db.close();
  });

  /**
   * 冷读反例 ②：`git log --since` 过滤的是 **committer** date，
   * 而 `day` 来自 `%ad`（**author** date）。真库有 author=2024-04-23 /
   * committer=2026-07-15 的提交 —— 它在窗口内会被重扫产出，
   * 但 day 在 floorDay 之下，`DELETE ... day >= floorDay` 够不着同一天的遗留行。
   * 不额外清理就会变成「遗留行 + 真提交行」两条，视图 SUM 算两遍。
   */
  it("author 早于 committer 且跨 floor —— 该天只有一行，不是两条", async () => {
    const db = freshDb();
    const repo = makeRepo({
      file: "src/a.ts",
      lines: 20,
      authorDate: "2024-04-23T12:00:00+08:00", // 远早于 floor
      committerDate: "2026-07-15T12:00:00+08:00", // 在 --since 窗口内
    });
    // 先手工种一条遗留行，模拟 V60 从 v1 搬过来的那 32 行之一。
    db.prepare(
      `INSERT INTO git_commit_churn
         (project_key, sha, author_email, authored_at, day, added, deleted, commits, is_legacy)
       VALUES (?, 'legacy:2024-04-23', ?, '2024-04-23T00:00:00.000Z', '2024-04-23', 20, 0, 1, 1)`
    ).run(repo, AUTHOR);

    await collect(db, repo, new Date("2026-06-01T00:00:00Z")); // floorDay 远晚于 2024-04-23

    const rows = db
      .prepare("SELECT added, commits FROM git_line_churn WHERE day='2024-04-23'")
      .all() as { added: number; commits: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.added).toBe(20); // 不是 40
    expect(rows[0]!.commits).toBe(1); // 不是 2
    db.close();
  });

  /**
   * 冷读反例 ③：直接调两次是**零判别力**的 —— 第二次 `isAncestor=true` →
   * incremental → range 是 `head..head` → git 输出为空 → 一行都不写，
   * 就算保留 v1 的累加写法也照样绿。必须 bump ruleVersion 强制 rescan。
   */
  it("幂等：强制 rescan 重跑，行数与数字都不变", async () => {
    const db = freshDb();
    const repo = makeRepo({ file: "src/a.ts", lines: 15, authorDate: "2026-06-20T12:00:00+08:00" });
    const floor = new Date("2026-01-01T00:00:00Z");
    await collect(db, repo, floor);
    const before = db
      .prepare("SELECT COUNT(*) n, SUM(added) a FROM git_commit_churn")
      .get() as { n: number; a: number };

    // 把 state 的 rule_version 打旧 → 下一轮必然走 rescan 而不是空的 incremental。
    db.prepare("UPDATE git_line_churn_state SET rule_version = ? WHERE repo_path = ?")
      .run(GIT_CHURN_RULE_VERSION - 1, repo);
    await collect(db, repo, floor);

    const after = db
      .prepare("SELECT COUNT(*) n, SUM(added) a FROM git_commit_churn")
      .get() as { n: number; a: number };
    expect(after).toEqual(before);
    db.close();
  });

  /**
   * 冷读反例 ④，真库有活实例：`last_synced_sha` 被 gc 掉之后
   * `merge-base --is-ancestor` 返回 **exit 128**（不是 1）。原来这一支是 throw，
   * 而外层 catch 只写 last_error、**不清 last_synced_sha** —— 那个仓库永远卡在
   * 报错、永远进不了重扫。`insight-git` 就这么冻结在一行，漏了 8 天 27 个提交。
   */
  it("last_synced_sha 不存在时自愈 —— exit 128 也当重扫，不是永久卡死", async () => {
    const db = freshDb();
    const repo = makeRepo({ file: "src/a.ts", lines: 9, authorDate: "2026-06-20T12:00:00+08:00" });
    const floor = new Date("2026-01-01T00:00:00Z");
    await collect(db, repo, floor);

    // 把游标指向一个仓库里没有的 sha（模拟被 gc）。rule_version 保持最新，
    // 这样就绕不开 isAncestor —— 必须靠它自己判出「重扫」。
    db.prepare("UPDATE git_line_churn_state SET last_synced_sha = ? WHERE repo_path = ?")
      .run("0".repeat(40), repo);
    db.prepare("DELETE FROM git_commit_churn WHERE project_key = ?").run(repo);

    const r = await collect(db, repo, floor);
    expect(r.mode).toBe("rescan");
    const n = (db.prepare("SELECT COUNT(*) n FROM git_commit_churn").get() as { n: number }).n;
    expect(n).toBe(1); // 修之前这里会抛 SqliteError/ExecGit 而不是补回数据
    db.close();
  });
});
