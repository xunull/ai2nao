// 时区必须在任何 import 之前定 —— 全部本地日断言都依赖它。
process.env.TZ = "Asia/Shanghai";

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import {
  InvalidParam,
  assertLocalDay,
  assertYearMonth,
  dayDetail,
  localToday,
  monthActivity,
  syncCoverage,
  syncProgress,
} from "../src/projectCalendar/queries.js";

// gitleaks:全部假路径。
const REPO_A = "/w/x/ai2nao";
const REPO_B = "/w/y/gstack";
const P_A = "-w-x-ai2nao";
const P_B = "-w-y-gstack";
const P_ORPHAN = "-w-z-not-a-repo";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "project-calendar-q-"));
  return openDatabase(join(dir, "test.db"));
}

function seedRepos(db: Database.Database, paths: string[]): void {
  const stmt = db.prepare(
    `INSERT INTO repos (path_canonical, first_seen_at) VALUES (?, ?)`
  );
  for (const p of paths) stmt.run(p, "2026-07-01T00:00:00.000Z");
}

let msgSeq = 0;
function seedMsg(
  db: Database.Database,
  o: {
    project: string | null;
    eventAtUtc: string;
    source?: string;
    text?: string;
    isHuman?: boolean;
  }
): void {
  msgSeq += 1;
  db.prepare(
    `INSERT INTO agent_user_messages
      (source, source_session_id, source_message_key, project, event_at_utc,
       raw_text, raw_payload_json, cleaned_text, is_human, char_len,
       cleaner_version, parser_version, source_path, source_seen_at,
       ingested_at, updated_at)
     VALUES (@source, @sid, @mkey, @project, @eventAtUtc,
             @text, '{}', @text, @isHuman, length(@text),
             1, 1, NULL, '2026-07-01T00:00:00.000Z',
             '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`
  ).run({
    source: o.source ?? "claude",
    sid: `s${msgSeq}`,
    mkey: `m${msgSeq}`,
    project: o.project,
    eventAtUtc: o.eventAtUtc,
    text: o.text ?? "hello",
    isHuman: (o.isHuman ?? true) ? 1 : 0,
  });
}

let commitSeq = 0;
function seedCommit(
  db: Database.Database,
  o: { repoKey: string; projectKey: string; authorDateUtc: string; subject?: string }
): void {
  commitSeq += 1;
  db.prepare(
    `INSERT INTO git_commits
      (repo_key, commit_hash, author_date_utc, committer_date_utc, subject,
       added, deleted, files_changed, project_key, ingested_at)
     VALUES (@repoKey, @hash, @at, @at, @subject, 1, 0, 1, @projectKey,
             '2026-07-01T00:00:00.000Z')`
  ).run({
    repoKey: o.repoKey,
    hash: `c${commitSeq}`,
    at: o.authorDateUtc,
    subject: o.subject ?? `commit ${commitSeq}`,
    projectKey: o.projectKey,
  });
}

/** scheduled_task_runs 有外键指向 scheduled_tasks(task_key),先把任务行插上。 */
function seedTaskRun(
  db: Database.Database,
  o: {
    startedAt: string;
    finishedAt?: string | null;
    status: string;
    errorSummary?: string | null;
  }
): void {
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_tasks
       (task_key, enabled, interval_seconds, config_json, created_at, updated_at)
     VALUES ('git.commits.sync', 0, 21600, '{}',
             '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`
  ).run();
  db.prepare(
    `INSERT INTO scheduled_task_runs
       (task_key, trigger, started_at, finished_at, status, summary_json, error_summary)
     VALUES ('git.commits.sync', 'manual', @startedAt, @finishedAt, @status, '{}', @errorSummary)`
  ).run({
    startedAt: o.startedAt,
    finishedAt: o.finishedAt ?? null,
    status: o.status,
    errorSummary: o.errorSummary ?? null,
  });
}

function seedCommitState(
  db: Database.Database,
  o: { repoKey: string; lastRunAt: string; lastStatus: string }
): void {
  db.prepare(
    `INSERT INTO git_commits_state (repo_key, last_hash, last_run_at, last_status, last_error)
     VALUES (?, 'deadbeef', ?, ?, NULL)`
  ).run(o.repoKey, o.lastRunAt, o.lastStatus);
}

// ---------------------------------------------------------------- 入参校验

describe("assertLocalDay", () => {
  it("接受真实存在的日期", () => {
    expect(assertLocalDay("2026-07-28")).toBe("2026-07-28");
    expect(assertLocalDay("2028-02-29")).toBe("2028-02-29"); // 2028 是闰年
  });

  it("格式不对 → 抛 InvalidParam", () => {
    for (const bad of ["2026-7-28", "20260728", "2026/07/28", "", "今天"]) {
      expect(() => assertLocalDay(bad)).toThrow(InvalidParam);
    }
  });

  it("★格式合法但日期不存在 → 抛,不能安静返回空★", () => {
    expect(() => assertLocalDay("2026-02-30")).toThrow(InvalidParam);
    expect(() => assertLocalDay("2026-13-01")).toThrow(InvalidParam);
    // 2025 / 2026 都不是闰年,2/29 不存在
    expect(() => assertLocalDay("2025-02-29")).toThrow(InvalidParam);
    expect(() => assertLocalDay("2026-02-29")).toThrow(InvalidParam);
  });

  it("非字符串 → 抛", () => {
    expect(() => assertLocalDay(undefined)).toThrow(InvalidParam);
    expect(() => assertLocalDay(20260728)).toThrow(InvalidParam);
  });
});

describe("assertYearMonth", () => {
  it("接受合法年月(含字符串数字)", () => {
    expect(assertYearMonth(2026, 7)).toEqual({ year: 2026, month: 7 });
    expect(assertYearMonth("2026", "12")).toEqual({ year: 2026, month: 12 });
  });

  it("月份越界 / 非整数 → 抛", () => {
    for (const bad of [0, 13, -1, 1.5, "abc", undefined]) {
      expect(() => assertYearMonth(2026, bad)).toThrow(InvalidParam);
    }
  });

  it("年份越界 → 抛", () => {
    for (const bad of [1969, 10000, "abc"]) {
      expect(() => assertYearMonth(bad, 7)).toThrow(InvalidParam);
    }
  });
});

describe("localToday", () => {
  it("按本地时区格式化,不用 UTC", () => {
    // TZ=Asia/Shanghai(UTC+8):UTC 的 7/27 16:30 已经是本地的 7/28。
    expect(localToday(new Date("2026-07-27T16:30:00.000Z"))).toBe("2026-07-28");
  });
});

// ---------------------------------------------------------------- 月视图

describe("monthActivity", () => {
  it("空库 → 无活动天,dataStartDay 为 null,不崩", () => {
    const db = freshDb();
    const r = monthActivity(db, 2026, 7, { now: new Date("2026-07-28T02:00:00Z") });

    expect(r.days).toEqual([]);
    expect(r.dataStartDay).toBeNull();
    expect(r.serverToday).toBe("2026-07-28");
  });

  it("非法入参 → 抛 InvalidParam", () => {
    const db = freshDb();
    expect(() => monthActivity(db, 2026, 13)).toThrow(InvalidParam);
  });

  it("★项目数只数有对话的项目,只提交的不计入色阶★", () => {
    const db = freshDb();
    seedRepos(db, [REPO_A, REPO_B]);
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-10T02:00:00.000Z" });
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-10T03:00:00.000Z" });
    // B 当天只有提交、没有对话
    seedCommit(db, {
      repoKey: REPO_B,
      projectKey: P_B,
      authorDateUtc: "2026-07-10T05:00:00.000Z",
    });

    const [day] = monthActivity(db, 2026, 7).days;

    expect(day.day).toBe("2026-07-10");
    expect(day.projectCount).toBe(1); // 只有 A
    expect(day.messageCount).toBe(2);
    expect(day.commitCount).toBe(1);
    expect(day.commitOnlyProjectCount).toBe(1); // B
  });

  it("同一项目当天既有对话又有提交 → 不算 commitOnly", () => {
    const db = freshDb();
    seedRepos(db, [REPO_A]);
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-10T02:00:00.000Z" });
    seedCommit(db, {
      repoKey: REPO_A,
      projectKey: P_A,
      authorDateUtc: "2026-07-10T05:00:00.000Z",
    });

    const [day] = monthActivity(db, 2026, 7).days;

    expect(day.projectCount).toBe(1);
    expect(day.commitOnlyProjectCount).toBe(0);
  });

  it("is_human=0 与 project 为 NULL 的行被排除", () => {
    const db = freshDb();
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-10T02:00:00.000Z", isHuman: false });
    seedMsg(db, { project: null, eventAtUtc: "2026-07-10T02:00:00.000Z" });

    expect(monthActivity(db, 2026, 7).days).toEqual([]);
  });

  it("只返回本月的天,上月末 / 下月初不串进来", () => {
    const db = freshDb();
    // 本地 6/30、7/1、7/31、8/1(UTC+8 → 减 8 小时写 UTC)
    seedMsg(db, { project: P_A, eventAtUtc: "2026-06-30T04:00:00.000Z" });
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-01T04:00:00.000Z" });
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-31T04:00:00.000Z" });
    seedMsg(db, { project: P_A, eventAtUtc: "2026-08-01T04:00:00.000Z" });

    expect(monthActivity(db, 2026, 7).days.map((d) => d.day)).toEqual([
      "2026-07-01",
      "2026-07-31",
    ]);
  });

  it("12 月的下界能正确跨年", () => {
    const db = freshDb();
    seedMsg(db, { project: P_A, eventAtUtc: "2026-12-31T04:00:00.000Z" });
    seedMsg(db, { project: P_A, eventAtUtc: "2027-01-01T04:00:00.000Z" });

    expect(monthActivity(db, 2026, 12).days.map((d) => d.day)).toEqual([
      "2026-12-31",
    ]);
  });

  it("★UTC 时刻按本地日归属,不按 UTC 日★", () => {
    const db = freshDb();
    // UTC 7/9 16:30 → Asia/Shanghai 是 7/10 00:30
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-09T16:30:00.000Z" });

    expect(monthActivity(db, 2026, 7).days.map((d) => d.day)).toEqual([
      "2026-07-10",
    ]);
  });

  it("dataStartDay 取全库对话最早的本地日(不受查询月份影响)", () => {
    const db = freshDb();
    seedMsg(db, { project: P_A, eventAtUtc: "2026-04-23T16:30:00.000Z" }); // 本地 4/24
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-10T02:00:00.000Z" });

    expect(monthActivity(db, 2026, 7).dataStartDay).toBe("2026-04-24");
  });

  it("天按日期升序", () => {
    const db = freshDb();
    for (const d of ["2026-07-20", "2026-07-05", "2026-07-12"]) {
      seedMsg(db, { project: P_A, eventAtUtc: `${d}T04:00:00.000Z` });
    }

    expect(monthActivity(db, 2026, 7).days.map((d) => d.day)).toEqual([
      "2026-07-05",
      "2026-07-12",
      "2026-07-20",
    ]);
  });
});

// ---------------------------------------------------------------- 当日明细

describe("dayDetail", () => {
  it("非法日期 → 抛,不返回空态", () => {
    const db = freshDb();
    expect(() => dayDetail(db, "2026-02-30")).toThrow(InvalidParam);
    expect(() => dayDetail(db, "nope")).toThrow(InvalidParam);
  });

  it("那天完全没数据 → 空态,不崩", () => {
    const db = freshDb();
    const r = dayDetail(db, "2026-07-10");

    expect(r).toMatchObject({
      date: "2026-07-10",
      projectCount: 0,
      messageCount: 0,
      commitCount: 0,
      projects: [],
      commitOnlyProjects: [],
    });
  });

  it("★projectCount 恒等于 projects.length(与日历格子同源)★", () => {
    const db = freshDb();
    seedRepos(db, [REPO_A, REPO_B]);
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-10T02:00:00.000Z" });
    seedMsg(db, { project: P_B, eventAtUtc: "2026-07-10T03:00:00.000Z" });
    seedCommit(db, {
      repoKey: REPO_A,
      projectKey: "-w-q-third",
      authorDateUtc: "2026-07-10T05:00:00.000Z",
    });

    const r = dayDetail(db, "2026-07-10");
    const month = monthActivity(db, 2026, 7).days.find((d) => d.day === "2026-07-10");

    expect(r.projectCount).toBe(r.projects.length);
    expect(r.projectCount).toBe(month!.projectCount);
  });

  it("★只提交没对话的项目进折叠区,不进主列表★", () => {
    const db = freshDb();
    seedRepos(db, [REPO_A, REPO_B]);
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-10T02:00:00.000Z" });
    seedCommit(db, {
      repoKey: REPO_B,
      projectKey: P_B,
      authorDateUtc: "2026-07-10T05:00:00.000Z",
    });

    const r = dayDetail(db, "2026-07-10");

    expect(r.projects.map((p) => p.key)).toEqual([P_A]);
    expect(r.commitOnlyProjects.map((p) => p.key)).toEqual([P_B]);
    expect(r.commitOnlyProjects[0].name).toBe("gstack");
    expect(r.commitCount).toBe(1); // 折叠区的提交也计入总数
  });

  it("有对话的项目带上当天自己的提交", () => {
    const db = freshDb();
    seedRepos(db, [REPO_A]);
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-10T02:00:00.000Z" });
    seedCommit(db, {
      repoKey: REPO_A,
      projectKey: P_A,
      authorDateUtc: "2026-07-10T05:00:00.000Z",
      subject: "fix: 修了个东西",
    });

    const [p] = dayDetail(db, "2026-07-10").projects;

    expect(p.commits).toHaveLength(1);
    expect(p.commits[0].subject).toBe("fix: 修了个东西");
  });

  it("bySource 按来源拆分并按条数降序", () => {
    const db = freshDb();
    seedRepos(db, [REPO_A]);
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-10T02:00:00.000Z", source: "codex" });
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-10T03:00:00.000Z", source: "claude" });
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-10T04:00:00.000Z", source: "claude" });

    expect(dayDetail(db, "2026-07-10").projects[0].bySource).toEqual([
      { source: "claude", count: 2 },
      { source: "codex", count: 1 },
    ]);
  });

  it("firstHumanText 取当天该项目的第一条,不是最后一条", () => {
    const db = freshDb();
    seedRepos(db, [REPO_A]);
    seedMsg(db, {
      project: P_A,
      eventAtUtc: "2026-07-10T05:00:00.000Z",
      text: "后来说的",
    });
    seedMsg(db, {
      project: P_A,
      eventAtUtc: "2026-07-10T01:00:00.000Z",
      text: "最先说的",
    });

    expect(dayDetail(db, "2026-07-10").projects[0].firstHumanText).toBe("最先说的");
  });

  it("firstHumanText 超长会截断", () => {
    const db = freshDb();
    seedRepos(db, [REPO_A]);
    seedMsg(db, {
      project: P_A,
      eventAtUtc: "2026-07-10T01:00:00.000Z",
      text: "长".repeat(500),
    });

    expect(dayDetail(db, "2026-07-10").projects[0].firstHumanText).toHaveLength(120);
  });

  it("firstAtMs / lastAtMs 覆盖当天时间跨度", () => {
    const db = freshDb();
    seedRepos(db, [REPO_A]);
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-10T01:12:00.000Z" });
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-10T15:40:00.000Z" });

    const [p] = dayDetail(db, "2026-07-10").projects;

    expect(p.firstAtMs).toBe(Date.parse("2026-07-10T01:12:00.000Z"));
    expect(p.lastAtMs).toBe(Date.parse("2026-07-10T15:40:00.000Z"));
  });

  it("主列表按消息数降序", () => {
    const db = freshDb();
    seedRepos(db, [REPO_A, REPO_B]);
    seedMsg(db, { project: P_B, eventAtUtc: "2026-07-10T01:00:00.000Z" });
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-10T02:00:00.000Z" });
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-10T03:00:00.000Z" });

    expect(dayDetail(db, "2026-07-10").projects.map((p) => p.key)).toEqual([
      P_A,
      P_B,
    ]);
  });

  it("归不到 repo 的项目 → path 为 null,名字是完整 slug(不拆)", () => {
    const db = freshDb();
    seedRepos(db, [REPO_A]);
    seedMsg(db, { project: P_ORPHAN, eventAtUtc: "2026-07-10T02:00:00.000Z" });

    const [p] = dayDetail(db, "2026-07-10").projects;

    expect(p.path).toBeNull();
    expect(p.name).toBe(P_ORPHAN);
  });

  it("命中 repo 的项目 → name 是 basename,path 是真实路径", () => {
    const db = freshDb();
    seedRepos(db, [REPO_A]);
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-10T02:00:00.000Z" });

    const [p] = dayDetail(db, "2026-07-10").projects;

    expect(p.name).toBe("ai2nao");
    expect(p.path).toBe(REPO_A);
  });

  it("★跨零点的会话按每条消息各自归日,拆成两天(既定口径)★", () => {
    const db = freshDb();
    seedRepos(db, [REPO_A]);
    // 本地 7/10 23:50 与 7/11 00:30
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-10T15:50:00.000Z" });
    seedMsg(db, { project: P_A, eventAtUtc: "2026-07-10T16:30:00.000Z" });

    expect(dayDetail(db, "2026-07-10").messageCount).toBe(1);
    expect(dayDetail(db, "2026-07-11").messageCount).toBe(1);
  });
});

// ---------------------------------------------------------------- 覆盖率

describe("syncCoverage", () => {
  it("空库 → 全 0,水位为 null", () => {
    const db = freshDb();

    expect(syncCoverage(db)).toEqual({
      totalRepos: 0,
      scannedRepos: 0,
      okCount: 0,
      failedCount: 0,
      neverScanned: 0,
      lastScanAt: null,
      cutoffDay: null,
    });
  });

  it("★成功 / 失败 / 从未扫描 三者分得清★", () => {
    const db = freshDb();
    seedRepos(db, [REPO_A, REPO_B, "/w/z/never"]);
    seedCommitState(db, {
      repoKey: REPO_A,
      lastRunAt: "2026-07-06T03:12:39.648Z",
      lastStatus: "success",
    });
    seedCommitState(db, {
      repoKey: REPO_B,
      lastRunAt: "2026-07-06T03:12:39.648Z",
      lastStatus: "failed",
    });

    expect(syncCoverage(db)).toMatchObject({
      totalRepos: 3,
      scannedRepos: 2,
      okCount: 1,
      failedCount: 1,
      neverScanned: 1,
    });
  });

  it("★水位取最早的那次扫描,不是最晚★", () => {
    const db = freshDb();
    seedRepos(db, [REPO_A, REPO_B]);
    seedCommitState(db, {
      repoKey: REPO_A,
      lastRunAt: "2026-07-06T03:12:39.648Z",
      lastStatus: "success",
    });
    seedCommitState(db, {
      repoKey: REPO_B,
      lastRunAt: "2026-07-28T01:00:00.000Z",
      lastStatus: "success",
    });

    const c = syncCoverage(db);

    expect(c.lastScanAt).toBe("2026-07-06T03:12:39.648Z");
    expect(c.cutoffDay).toBe("2026-07-06");
  });

  it("跑到一半:done 只数本轮已完成的仓库,上一轮的旧水位不算", () => {
    const db = freshDb();
    seedRepos(db, [REPO_A, REPO_B, "/w/z/third"]);
    // 上一轮的残留水位(远早于本轮)
    seedCommitState(db, {
      repoKey: REPO_A,
      lastRunAt: "2026-07-06T03:00:00.000Z",
      lastStatus: "success",
    });
    // 本轮已完成两个:一个成功、一个失败 —— 都算「已完成」
    db.prepare(
      `UPDATE git_commits_state SET last_run_at = ? WHERE repo_key = ?`
    ).run("2026-07-28T10:00:00.000Z", REPO_A);
    seedCommitState(db, {
      repoKey: REPO_B,
      lastRunAt: "2026-07-28T10:00:00.000Z",
      lastStatus: "failed",
    });
    // 第三个仓库本轮还没轮到
    seedTaskRun(db, { startedAt: "2026-07-28T09:59:00.000Z", status: "running" });

    expect(syncProgress(db)).toMatchObject({
      running: true,
      done: 2,
      total: 3,
      lastStatus: "running",
    });
  });

  it("跑完了 → running 为 false,带上终态", () => {
    const db = freshDb();
    seedRepos(db, [REPO_A]);
    seedCommitState(db, {
      repoKey: REPO_A,
      lastRunAt: "2026-07-28T10:00:00.000Z",
      lastStatus: "success",
    });
    seedTaskRun(db, {
      startedAt: "2026-07-28T09:59:00.000Z",
      finishedAt: "2026-07-28T10:01:00.000Z",
      status: "partial",
      errorSummary: "16 repos failed",
    });

    expect(syncProgress(db)).toMatchObject({
      running: false,
      done: 1,
      total: 1,
      lastStatus: "partial",
      errorSummary: "16 repos failed",
    });
  });

  it("★从未跑过 ≠ 跑过但 0 个完成★", () => {
    const db = freshDb();
    seedRepos(db, [REPO_A]);

    expect(syncProgress(db)).toMatchObject({
      running: false,
      done: 0,
      total: 1,
      startedAt: null,
      lastStatus: null, // ← 这个 null 就是「从未跑过」的信号
    });
  });

  it("已消失的 repo 不计入总数", () => {
    const db = freshDb();
    seedRepos(db, [REPO_A, REPO_B]);
    db.prepare(`UPDATE repos SET missing_since = ? WHERE path_canonical = ?`).run(
      "2026-07-20T00:00:00.000Z",
      REPO_B
    );

    expect(syncCoverage(db).totalRepos).toBe(1);
  });
});
