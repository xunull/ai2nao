process.env.TZ = "Asia/Shanghai";

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { upsertCommits } from "../src/gitCommits/store.js";
import { upsertUserMessagesBatch } from "../src/agentUserMessages/store.js";
import { slugFromPath } from "../src/agentUserMessages/projectKey.js";
import type { AgentUserMessageSource } from "../src/agentUserMessages/types.js";
import {
  getReplaySession,
  listReplaySessions,
} from "../src/replay/queries.js";

// gitleaks:全部用假绝对路径(不写真实 home 路径),project_key = slugFromPath。
const REPO = "/w/x/repo"; // → -w-x-repo
const REPO2 = "/w/y/other"; // → -w-y-other
const P = slugFromPath(REPO)!;
const P2 = slugFromPath(REPO2)!;

// 固定 now 让窗口/顺序确定(不依赖真实今天)。默认 90 天窗口 → since ≈ 2026-04-07。
const NOW_MS = Date.parse("2026-07-06T00:00:00.000Z");

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "replay-q-"));
  return openDatabase(join(dir, "test.db"));
}

type SeedCommit = { hash: string; authorDateUtc: string; subject?: string };

function seedCommits(db: Database.Database, repoKey: string, commits: SeedCommit[]): void {
  upsertCommits(
    db,
    repoKey,
    commits.map((c) => ({
      hash: c.hash,
      authorDateUtc: c.authorDateUtc,
      committerDateUtc: c.authorDateUtc,
      subject: c.subject ?? "commit",
      added: 1,
      deleted: 0,
      filesChanged: 1,
    })),
    "2026-06-01T00:00:00.000Z"
  );
}

let msgSeq = 0;
type SeedMsg = {
  project: string | null;
  eventAtUtc: string;
  isHuman?: boolean;
  source?: AgentUserMessageSource;
  cleanedText?: string;
};

function seedMessages(db: Database.Database, rows: SeedMsg[]): void {
  upsertUserMessagesBatch(
    db,
    rows.map((r) => {
      msgSeq += 1;
      return {
        source: r.source ?? "claude",
        sourceSessionId: "sess",
        sourceMessageKey: `m${msgSeq}`,
        project: r.project,
        eventAtUtc: r.eventAtUtc,
        rawText: r.cleanedText ?? "hi",
        rawPayloadJson: '"hi"',
        cleanedText: r.cleanedText ?? "hi",
        isHuman: r.isHuman ?? true,
        cleanerVersion: 1,
        parserVersion: 1,
        sourcePath: null,
      };
    }),
    "2026-06-01T00:00:00.000Z"
  );
}

describe("listReplaySessions —— 混合过滤 / 窗口 / 顺序 / skipped", () => {
  it("默认只留混合段:纯提交段、纯对话段都不上榜;includeNoCommit 放宽到有提交", () => {
    const db = freshDb();
    // A 混合段(07-01):m + commit 相邻。
    seedMessages(db, [{ project: P, eventAtUtc: "2026-07-01T10:00:00.000Z" }]);
    seedCommits(db, REPO, [
      { hash: "aaaa0001", authorDateUtc: "2026-07-01T10:30:00.000Z" },
    ]);
    // B 纯提交段(07-02):附近无对话。
    seedCommits(db, REPO, [
      { hash: "bbbb0001", authorDateUtc: "2026-07-02T10:00:00.000Z" },
    ]);
    // C 纯对话段(07-03):无提交。
    seedMessages(db, [{ project: P, eventAtUtc: "2026-07-03T10:00:00.000Z" }]);

    const def = listReplaySessions(db, { nowMs: NOW_MS });
    expect(def.sessions.length).toBe(1);
    expect(def.sessions[0].commitCount).toBe(1);
    expect(def.sessions[0].messageCount).toBe(1);

    const withNoCommit = listReplaySessions(db, {
      nowMs: NOW_MS,
      includeNoCommit: true,
    });
    // 混合段 + 纯提交段(不含纯对话段 C)。
    expect(withNoCommit.sessions.length).toBe(2);
    expect(
      withNoCommit.sessions.some((s) => s.commitCount === 1 && s.messageCount === 0)
    ).toBe(true);
    expect(withNoCommit.sessions.every((s) => s.commitCount > 0)).toBe(true);
  });

  it("窗口边界:窗口外的老段被排除;缩小 windowDays 把段挤出窗口", () => {
    const db = freshDb();
    // 近段(07-01,90 天内)。
    seedMessages(db, [{ project: P, eventAtUtc: "2026-07-01T10:00:00.000Z" }]);
    seedCommits(db, REPO, [
      { hash: "near0001", authorDateUtc: "2026-07-01T10:30:00.000Z" },
    ]);
    // 老段(01-01,90 天外)。
    seedMessages(db, [{ project: P, eventAtUtc: "2026-01-01T10:00:00.000Z" }]);
    seedCommits(db, REPO, [
      { hash: "oldd0001", authorDateUtc: "2026-01-01T10:30:00.000Z" },
    ]);

    const def = listReplaySessions(db, { nowMs: NOW_MS });
    expect(def.sessions.length).toBe(1);
    expect(def.windowDays).toBe(90);
    // 老段不在。
    expect(def.sessions[0].startedAtMs).toBe(
      Date.parse("2026-07-01T10:00:00.000Z")
    );

    // windowDays=1 → since 2026-07-05,连近段(07-01)也挤出。
    const narrow = listReplaySessions(db, { nowMs: NOW_MS, windowDays: 1 });
    expect(narrow.sessions.length).toBe(0);
    expect(narrow.windowDays).toBe(1);
  });

  it("最新在前:两个混合段按 startedAt 倒序", () => {
    const db = freshDb();
    // 老段 07-01。
    seedMessages(db, [{ project: P, eventAtUtc: "2026-07-01T10:00:00.000Z" }]);
    seedCommits(db, REPO, [
      { hash: "oldm0001", authorDateUtc: "2026-07-01T10:30:00.000Z" },
    ]);
    // 新段 07-04。
    seedMessages(db, [{ project: P, eventAtUtc: "2026-07-04T10:00:00.000Z" }]);
    seedCommits(db, REPO, [
      { hash: "newm0001", authorDateUtc: "2026-07-04T10:30:00.000Z" },
    ]);

    const { sessions } = listReplaySessions(db, { nowMs: NOW_MS });
    expect(sessions.length).toBe(2);
    expect(sessions[0].startedAtMs).toBeGreaterThan(sessions[1].startedAtMs);
    expect(sessions[0].startedAtMs).toBe(
      Date.parse("2026-07-04T10:00:00.000Z")
    );
  });

  it("skipped:author_date_utc 解析失败的脏行被跳过并计数", () => {
    const db = freshDb();
    seedMessages(db, [{ project: P, eventAtUtc: "2026-07-01T10:00:00.000Z" }]);
    seedCommits(db, REPO, [
      { hash: "good0001", authorDateUtc: "2026-07-01T10:30:00.000Z" },
      // 脏时间戳(词典序 > since 故会被 WHERE 选中,再在 Date.parse 处跳过计数)。
      { hash: "dirt0001", authorDateUtc: "not-a-date" },
    ]);

    const { sessions, skipped } = listReplaySessions(db, { nowMs: NOW_MS });
    expect(skipped).toBe(1);
    // 好段仍在(1 commit + 1 message)。
    expect(sessions.length).toBe(1);
    expect(sessions[0].commitCount).toBe(1);
  });
});

describe("getReplaySession —— 交织流 / matchedCount 口径 / 找不到", () => {
  it("交织事件流 + matchedCount:会话起点夹逼 & project 隔离", () => {
    const db = freshDb();
    // m_early 05:00(P)→ 与后段相隔 5h(>2h)成独立更早段;在桥窗口内但早于会话起点。
    // 目标段(10:00 起):m0 10:00(起点,严格 > 排除)、m1 10:10(计入)、
    //   m2 10:15(P2,别的仓库不计)、C1 10:30(commit,T)。
    seedMessages(db, [
      { project: P, eventAtUtc: "2026-07-05T05:00:00.000Z" }, // m_early
      { project: P, eventAtUtc: "2026-07-05T10:00:00.000Z" }, // m0(起点)
      { project: P, eventAtUtc: "2026-07-05T10:10:00.000Z" }, // m1(计入)
      { project: P2, eventAtUtc: "2026-07-05T10:15:00.000Z" }, // m2(别仓库)
    ]);
    seedCommits(db, REPO, [
      { hash: "cccc0001", authorDateUtc: "2026-07-05T10:30:00.000Z", subject: "落成" },
    ]);

    // 目标混合段(1 commit + 3 message[m0/m1/m2])→ 默认过滤命中,最新在前取第 0。
    const list = listReplaySessions(db, { nowMs: NOW_MS });
    expect(list.sessions.length).toBe(1);
    const key = list.sessions[0].firstEventKey;

    const detail = getReplaySession(db, { key, nowMs: NOW_MS })!;
    expect(detail).not.toBeNull();
    // 交织:按时间升序 message,message,message,commit。
    expect(detail.events.map((e) => e.type)).toEqual([
      "message",
      "message",
      "message",
      "commit",
    ]);
    const times = detail.events.map((e) => e.atMs);
    expect([...times]).toEqual([...times].sort((a, b) => a - b));

    const commit = detail.events.find((e) => e.type === "commit")!;
    expect(commit.type).toBe("commit");
    if (commit.type === "commit") {
      expect(commit.subject).toBe("落成");
      // 仅 m1 计入:m0 起点严格排除、m_early 被会话起点夹逼掉、m2 属别的仓库。
      expect(commit.matchedCount).toBe(1);
    }
  });

  it("缺 subject → subject '';commit 事件仍产出", () => {
    const db = freshDb();
    seedMessages(db, [{ project: P, eventAtUtc: "2026-07-05T10:10:00.000Z" }]);
    // 直接写一行 subject 为 NULL 的 commit(绕过 seedCommits 的默认 subject)。
    db.prepare(
      `INSERT INTO git_commits
         (repo_key, commit_hash, author_date_utc, committer_date_utc, subject,
          added, deleted, files_changed, project_key, ingested_at)
       VALUES (@repoKey, @hash, @t, @t, NULL, 1, 0, 1, @pk, @t)`
    ).run({
      repoKey: REPO,
      hash: "nosub001",
      t: "2026-07-05T10:30:00.000Z",
      pk: P,
    });

    const list = listReplaySessions(db, { nowMs: NOW_MS });
    const detail = getReplaySession(db, {
      key: list.sessions[0].firstEventKey,
      nowMs: NOW_MS,
    })!;
    const commit = detail.events.find((e) => e.type === "commit")!;
    if (commit.type === "commit") {
      expect(commit.subject).toBe("");
    }
  });

  it("firstEventKey 找不到 → null", () => {
    const db = freshDb();
    expect(getReplaySession(db, { key: "git:nope", nowMs: NOW_MS })).toBeNull();
  });
});

describe("真实形态 fixture(insight-dir 7/5,codex#14)", () => {
  it("消息→提交→消息→提交→(小停顿)消息→提交 归为一段:3 commit + 6 message,按时间序", () => {
    const db = freshDb();
    const REPO_INS = "/tmp/insight-dir"; // gitleaks:假路径 → -tmp-insight-dir
    const P_INS = slugFromPath(REPO_INS)!;
    expect(P_INS).toBe("-tmp-insight-dir");

    seedMessages(db, [
      { project: P_INS, eventAtUtc: "2026-07-05T09:00:00.000Z", cleanedText: "开工" },
      { project: P_INS, eventAtUtc: "2026-07-05T09:10:00.000Z" },
      { project: P_INS, eventAtUtc: "2026-07-05T09:45:00.000Z" },
      { project: P_INS, eventAtUtc: "2026-07-05T10:00:00.000Z" },
      // 停顿 90min(<2h 阈值)故不断段。
      { project: P_INS, eventAtUtc: "2026-07-05T11:45:00.000Z" },
      { project: P_INS, eventAtUtc: "2026-07-05T11:50:00.000Z" },
    ]);
    seedCommits(db, REPO_INS, [
      { hash: "ins00001", authorDateUtc: "2026-07-05T09:30:00.000Z" },
      { hash: "ins00002", authorDateUtc: "2026-07-05T10:15:00.000Z" },
      { hash: "ins00003", authorDateUtc: "2026-07-05T12:00:00.000Z" },
    ]);

    const list = listReplaySessions(db, { nowMs: NOW_MS });
    expect(list.sessions.length).toBe(1);
    expect(list.sessions[0].commitCount).toBe(3);
    expect(list.sessions[0].messageCount).toBe(6);
    expect(list.sessions[0].repoKeys).toEqual([P_INS]);

    const detail = getReplaySession(db, {
      key: list.sessions[0].firstEventKey,
      nowMs: NOW_MS,
    })!;
    expect(detail.events.length).toBe(9);
    // 时间严格升序。
    const times = detail.events.map((e) => e.atMs);
    expect([...times]).toEqual([...times].sort((a, b) => a - b));
    // 交织形态:msg,msg,commit,msg,msg,commit,msg,msg,commit。
    expect(detail.events.map((e) => e.type)).toEqual([
      "message",
      "message",
      "commit",
      "message",
      "message",
      "commit",
      "message",
      "message",
      "commit",
    ]);
    // 每个 commit 都带 matchedCount(数值)。
    for (const e of detail.events) {
      if (e.type === "commit") expect(typeof e.matchedCount).toBe("number");
    }
  });
});
