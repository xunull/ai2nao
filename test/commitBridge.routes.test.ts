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
import { createApp } from "../src/serve/app.js";

const REPO = "/w/x/repo";
const P = slugFromPath(REPO)!;

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "commit-bridge-r-"));
  return openDatabase(join(dir, "test.db"));
}

function seed(db: Database.Database): void {
  upsertCommits(
    db,
    REPO,
    [
      {
        hash: "cccc0001",
        authorDateUtc: "2026-06-01T14:00:00.000Z",
        committerDateUtc: "2026-06-01T14:00:00.000Z",
        subject: "fix: 修一个 bug",
        added: 10,
        deleted: 3,
        filesChanged: 2,
      },
    ],
    "2026-06-01T00:00:00.000Z"
  );
  upsertUserMessagesBatch(
    db,
    [
      {
        source: "claude",
        sourceSessionId: "s1",
        sourceMessageKey: "m1",
        project: P,
        eventAtUtc: "2026-06-01T13:00:00.000Z",
        rawText: "帮我修 bug",
        rawPayloadJson: '"帮我修 bug"',
        cleanedText: "帮我修 bug",
        isHuman: true,
        cleanerVersion: 1,
        parserVersion: 1,
        sourcePath: null,
      },
    ],
    "2026-06-01T00:00:00.000Z"
  );
}

// 走 createApp 而非独立 Hono app —— 验证三个路由确实在 createApp 里挂载了。
describe("GET /api/commit-bridge/repos — createApp 集成", () => {
  it("已挂载 + repos + coverage shape", async () => {
    const db = freshDb();
    seed(db);
    const res = await createApp({ db }).request(
      "http://x/api/commit-bridge/repos"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      repos: { projectKey: string; displayName: string; commitCount: number }[];
      coverage: {
        totalCommits: number;
        commitsInReposWithConversation: number;
        pctReposWithConversation: number;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.repos).toEqual([
      { projectKey: P, displayName: "repo", commitCount: 1 },
    ]);
    expect(body.coverage.totalCommits).toBe(1);
    expect(body.coverage.commitsInReposWithConversation).toBe(1);
  });

  it("空库 → 200 + repos [] / coverage 全 0", async () => {
    const db = freshDb();
    const res = await createApp({ db }).request(
      "http://x/api/commit-bridge/repos"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repos: unknown[];
      coverage: { totalCommits: number; pctReposWithConversation: number };
    };
    expect(body.repos).toEqual([]);
    expect(body.coverage.totalCommits).toBe(0);
    expect(body.coverage.pctReposWithConversation).toBe(0);
  });
});

describe("GET /api/commit-bridge/commits — createApp 集成", () => {
  it("已挂载 + items(带 matchedCount)+ coverage", async () => {
    const db = freshDb();
    seed(db);
    const res = await createApp({ db }).request(
      "http://x/api/commit-bridge/commits"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      items: { commitHash: string; matchedCount: number; subject: string }[];
      nextBefore: unknown;
      coverage: { totalCommits: number };
    };
    expect(body.ok).toBe(true);
    expect(body.items.length).toBe(1);
    expect(body.items[0].commitHash).toBe("cccc0001");
    expect(body.items[0].matchedCount).toBe(1);
    expect(body.nextBefore).toBeNull();
    expect(body.coverage.totalCommits).toBe(1);
  });

  it("before/beforeHash 未成对 → 400", async () => {
    const db = freshDb();
    const res = await createApp({ db }).request(
      "http://x/api/commit-bridge/commits?before=2026-06-01T14:00:00.000Z"
    );
    expect(res.status).toBe(400);
  });

  it("空库 → 200 + items []", async () => {
    const db = freshDb();
    const res = await createApp({ db }).request(
      "http://x/api/commit-bridge/commits"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextBefore: unknown };
    expect(body.items).toEqual([]);
    expect(body.nextBefore).toBeNull();
  });
});

describe("GET /api/commit-bridge/commit — createApp 集成", () => {
  it("已挂载 + 返回窗口对话", async () => {
    const db = freshDb();
    seed(db);
    const res = await createApp({ db }).request(
      `http://x/api/commit-bridge/commit?repo=${encodeURIComponent(P)}&hash=cccc0001`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      commit: { commitHash: string };
      windowFromUtc: string;
      messages: { cleanedText: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.commit.commitHash).toBe("cccc0001");
    expect(body.messages.map((m) => m.cleanedText)).toEqual(["帮我修 bug"]);
  });

  it("缺 repo/hash → 400", async () => {
    const db = freshDb();
    const res = await createApp({ db }).request(
      "http://x/api/commit-bridge/commit?repo=" + encodeURIComponent(P)
    );
    expect(res.status).toBe(400);
  });

  it("commit 不存在 → 404", async () => {
    const db = freshDb();
    const res = await createApp({ db }).request(
      `http://x/api/commit-bridge/commit?repo=${encodeURIComponent(P)}&hash=nope`
    );
    expect(res.status).toBe(404);
  });
});
