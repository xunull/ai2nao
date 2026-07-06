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
  CAP_HOURS,
  commitConversation,
  commitCoverage,
  listBridgeRepos,
  listCommits,
  windowFromFor,
} from "../src/commitBridge/queries.js";

// gitleaks:全部用假的绝对路径(不写任何真实 home 路径),project_key = slugFromPath。
const REPO = "/w/x/repo"; // → project_key `-w-x-repo`
const REPO2 = "/w/y/other"; // → project_key `-w-y-other`
const P = slugFromPath(REPO)!;
const P2 = slugFromPath(REPO2)!;

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "commit-bridge-q-"));
  return openDatabase(join(dir, "test.db"));
}

type SeedCommit = {
  hash: string;
  authorDateUtc: string;
  committerDateUtc?: string;
  subject?: string;
  added?: number;
  deleted?: number;
  filesChanged?: number;
};

/** 直接走真实 upsertCommits(project_key = slugFromPath(repoKey) 自动派生)。 */
function seedCommits(db: Database.Database, repoKey: string, commits: SeedCommit[]): void {
  upsertCommits(
    db,
    repoKey,
    commits.map((c) => ({
      hash: c.hash,
      authorDateUtc: c.authorDateUtc,
      committerDateUtc: c.committerDateUtc ?? c.authorDateUtc,
      subject: c.subject ?? "commit",
      added: c.added ?? 1,
      deleted: c.deleted ?? 0,
      filesChanged: c.filesChanged ?? 1,
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

/** 找 P 仓库某个 hash 的 matchedCount(listCommits 逐 commit 算)。 */
function matchedOf(db: Database.Database, hash: string): number {
  const page = listCommits(db, { repo: P, limit: 100 });
  const item = page.items.find((i) => i.commitHash === hash);
  if (!item) throw new Error(`commit ${hash} not in page`);
  return item.matchedCount;
}

describe("windowFromFor + matched 口径", () => {
  it("窗口被上一个提交界住:prevCommit 之前的消息排除,prevCommit 与 T 之间的包含", () => {
    const db = freshDb();
    // prev 10:00, C 14:00(相隔 4h,<CAP 6h → prev 是较晚的下界)。
    seedCommits(db, REPO, [
      { hash: "prev0001", authorDateUtc: "2026-06-01T10:00:00.000Z" },
      { hash: "cccc0001", authorDateUtc: "2026-06-01T14:00:00.000Z" },
    ]);
    seedMessages(db, [
      { project: P, eventAtUtc: "2026-06-01T09:30:00.000Z" }, // 在 prevCommit 之前 → 排除
      { project: P, eventAtUtc: "2026-06-01T12:00:00.000Z" }, // prev 与 T 之间 → 包含
    ]);

    // windowFrom = max(10:00, 14:00-6h=08:00) = 10:00
    expect(windowFromFor(db, REPO, "2026-06-01T14:00:00.000Z")).toBe(
      "2026-06-01T10:00:00.000Z"
    );
    expect(matchedOf(db, "cccc0001")).toBe(1);

    const conv = commitConversation(db, { repo: P, hash: "cccc0001" })!;
    expect(conv.windowFromUtc).toBe("2026-06-01T10:00:00.000Z");
    expect(conv.messages.map((m) => m.eventAtUtc)).toEqual([
      "2026-06-01T12:00:00.000Z",
    ]);
  });

  it("窗口被 CAP 界住:比 T-6h 更早但晚于很老 prevCommit 的消息排除", () => {
    const db = freshDb();
    // prev 00:00(远早于 T-6h),C 14:00 → cap 08:00 是较晚下界。
    seedCommits(db, REPO, [
      { hash: "prev0002", authorDateUtc: "2026-06-01T00:00:00.000Z" },
      { hash: "cccc0002", authorDateUtc: "2026-06-01T14:00:00.000Z" },
    ]);
    seedMessages(db, [
      { project: P, eventAtUtc: "2026-06-01T05:00:00.000Z" }, // 晚于 prev、早于 cap 08:00 → 排除
      { project: P, eventAtUtc: "2026-06-01T10:00:00.000Z" }, // cap 内 → 包含
    ]);

    // windowFrom = max(00:00, 08:00) = 08:00(= T - CAP_HOURS)
    const expectedCap = new Date(
      new Date("2026-06-01T14:00:00.000Z").getTime() - CAP_HOURS * 3600_000
    ).toISOString();
    expect(windowFromFor(db, REPO, "2026-06-01T14:00:00.000Z")).toBe(expectedCap);
    expect(expectedCap).toBe("2026-06-01T08:00:00.000Z");
    expect(matchedOf(db, "cccc0002")).toBe(1);
  });

  it("project 过滤:别的 project 的消息不串仓库", () => {
    const db = freshDb();
    seedCommits(db, REPO, [
      { hash: "cccc0003", authorDateUtc: "2026-06-01T14:00:00.000Z" },
    ]);
    seedMessages(db, [
      { project: P, eventAtUtc: "2026-06-01T13:00:00.000Z" }, // 同仓库 → 包含
      { project: P2, eventAtUtc: "2026-06-01T13:30:00.000Z" }, // 别的仓库 → 不匹配
      { project: null, eventAtUtc: "2026-06-01T13:45:00.000Z" }, // 无 project → 不匹配
    ]);
    expect(matchedOf(db, "cccc0003")).toBe(1);
    const conv = commitConversation(db, { repo: P, hash: "cccc0003" })!;
    expect(conv.messages.length).toBe(1);
    expect(conv.messages[0].eventAtUtc).toBe("2026-06-01T13:00:00.000Z");
  });

  it("is_human=1 过滤:非人类消息不计入", () => {
    const db = freshDb();
    seedCommits(db, REPO, [
      { hash: "cccc0004", authorDateUtc: "2026-06-01T14:00:00.000Z" },
    ]);
    seedMessages(db, [
      { project: P, eventAtUtc: "2026-06-01T13:00:00.000Z", isHuman: true },
      { project: P, eventAtUtc: "2026-06-01T13:10:00.000Z", isHuman: false },
    ]);
    expect(matchedOf(db, "cccc0004")).toBe(1);
  });

  it("窗口内无对话的 commit 仍返回,matchedCount 0", () => {
    const db = freshDb();
    seedCommits(db, REPO, [
      { hash: "empty001", authorDateUtc: "2026-06-01T14:00:00.000Z" },
    ]);
    seedMessages(db, [
      { project: P, eventAtUtc: "2026-06-01T02:00:00.000Z" }, // 远早于窗口 → 不计
    ]);
    expect(matchedOf(db, "empty001")).toBe(0);
    const conv = commitConversation(db, { repo: P, hash: "empty001" })!;
    expect(conv.messages).toEqual([]);
  });

  it("commit 不存在 → commitConversation 返回 null", () => {
    const db = freshDb();
    expect(commitConversation(db, { repo: P, hash: "nope" })).toBeNull();
  });
});

describe("listCommits keyset 分页", () => {
  it("两页无重复、nextBefore 正确、同 author_date_utc 靠 commit_hash 破平", () => {
    const db = freshDb();
    // c1 10:00; c3/c2 同 09:00(hash 破平:b > a); c4 08:00; c5 07:00
    seedCommits(db, REPO, [
      { hash: "hhhhhhh1", authorDateUtc: "2026-06-01T10:00:00.000Z" },
      { hash: "aaaaaaa2", authorDateUtc: "2026-06-01T09:00:00.000Z" },
      { hash: "bbbbbbb3", authorDateUtc: "2026-06-01T09:00:00.000Z" },
      { hash: "ccccccc4", authorDateUtc: "2026-06-01T08:00:00.000Z" },
      { hash: "ddddddd5", authorDateUtc: "2026-06-01T07:00:00.000Z" },
    ]);

    const page1 = listCommits(db, { repo: P, limit: 2 });
    // ORDER author DESC, hash DESC: 10:00(h1), 09:00(b3 前 a2)
    expect(page1.items.map((i) => i.commitHash)).toEqual(["hhhhhhh1", "bbbbbbb3"]);
    expect(page1.nextBefore).toEqual({
      authorDateUtc: "2026-06-01T09:00:00.000Z",
      commitHash: "bbbbbbb3",
    });

    const page2 = listCommits(db, {
      repo: P,
      before: page1.nextBefore!.authorDateUtc,
      beforeHash: page1.nextBefore!.commitHash,
      limit: 2,
    });
    // 09:00 且 hash < bbbbbbb3 → aaaaaaa2;然后 08:00(c4)
    expect(page2.items.map((i) => i.commitHash)).toEqual(["aaaaaaa2", "ccccccc4"]);
    expect(page2.nextBefore).toEqual({
      authorDateUtc: "2026-06-01T08:00:00.000Z",
      commitHash: "ccccccc4",
    });

    // 两页不重叠
    const all = [...page1.items, ...page2.items].map((i) => i.commitHash);
    expect(new Set(all).size).toBe(all.length);

    // 末页:剩 ddddddd5,不足 limit → nextBefore null
    const page3 = listCommits(db, {
      repo: P,
      before: page2.nextBefore!.authorDateUtc,
      beforeHash: page2.nextBefore!.commitHash,
      limit: 2,
    });
    expect(page3.items.map((i) => i.commitHash)).toEqual(["ddddddd5"]);
    expect(page3.nextBefore).toBeNull();
  });
});

describe("commitCoverage(仓库级)", () => {
  it("totalCommits + commitsInReposWithConversation 正确", () => {
    const db = freshDb();
    seedCommits(db, REPO, [
      { hash: "a1", authorDateUtc: "2026-06-01T10:00:00.000Z" },
      { hash: "a2", authorDateUtc: "2026-06-01T11:00:00.000Z" },
      { hash: "a3", authorDateUtc: "2026-06-01T12:00:00.000Z" },
    ]);
    seedCommits(db, REPO2, [
      { hash: "b1", authorDateUtc: "2026-06-01T10:00:00.000Z" },
      { hash: "b2", authorDateUtc: "2026-06-01T11:00:00.000Z" },
    ]);
    // 只有 REPO(P)有对话 → REPO2(P2)整仓无对话
    seedMessages(db, [{ project: P, eventAtUtc: "2026-06-01T09:00:00.000Z" }]);

    const global = commitCoverage(db);
    expect(global.totalCommits).toBe(5);
    expect(global.commitsInReposWithConversation).toBe(3);
    expect(global.pctReposWithConversation).toBeCloseTo(3 / 5);

    // 按 repo 筛:P2 整仓无对话 → 0
    const onlyP2 = commitCoverage(db, { repo: P2 });
    expect(onlyP2.totalCommits).toBe(2);
    expect(onlyP2.commitsInReposWithConversation).toBe(0);
    expect(onlyP2.pctReposWithConversation).toBe(0);

    const onlyP = commitCoverage(db, { repo: P });
    expect(onlyP.totalCommits).toBe(3);
    expect(onlyP.commitsInReposWithConversation).toBe(3);
  });

  it("空库 → total 0 / pct 0", () => {
    const db = freshDb();
    const c = commitCoverage(db);
    expect(c).toEqual({
      totalCommits: 0,
      commitsInReposWithConversation: 0,
      pctReposWithConversation: 0,
    });
  });
});

describe("listBridgeRepos", () => {
  it("distinct project_key + commit 数(多在前)", () => {
    const db = freshDb();
    seedCommits(db, REPO, [
      { hash: "a1", authorDateUtc: "2026-06-01T10:00:00.000Z" },
      { hash: "a2", authorDateUtc: "2026-06-01T11:00:00.000Z" },
    ]);
    seedCommits(db, REPO2, [
      { hash: "b1", authorDateUtc: "2026-06-01T10:00:00.000Z" },
    ]);
    const repos = listBridgeRepos(db);
    expect(repos.map((r) => r.projectKey)).toEqual([P, P2]); // 2 在前
    expect(repos[0].commitCount).toBe(2);
    expect(repos[0].displayName).toBe("repo"); // slug 末段
    expect(repos[1].displayName).toBe("other");
  });
});
