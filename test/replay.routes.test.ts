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
  const dir = mkdtempSync(join(tmpdir(), "replay-r-"));
  return openDatabase(join(dir, "test.db"));
}

/**
 * 一个混合段:m1 13:00(会话起点)→ m2 13:30 → commit 14:00(同仓库,相邻)。
 * 起点消息 m1 恰在会话起点(matchedCount 严格 > 排除),m2 才是被计入的那条。
 */
function seed(db: Database.Database): void {
  upsertUserMessagesBatch(
    db,
    [
      {
        source: "claude",
        sourceSessionId: "s1",
        sourceMessageKey: "m1",
        project: P,
        eventAtUtc: "2026-06-30T13:00:00.000Z",
        rawText: "先看看",
        rawPayloadJson: '"先看看"',
        cleanedText: "先看看",
        isHuman: true,
        cleanerVersion: 1,
        parserVersion: 1,
        sourcePath: null,
      },
      {
        source: "claude",
        sourceSessionId: "s1",
        sourceMessageKey: "m2",
        project: P,
        eventAtUtc: "2026-06-30T13:30:00.000Z",
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
  upsertCommits(
    db,
    REPO,
    [
      {
        hash: "cccc0001",
        authorDateUtc: "2026-06-30T14:00:00.000Z",
        committerDateUtc: "2026-06-30T14:00:00.000Z",
        subject: "fix: 修一个 bug",
        added: 10,
        deleted: 3,
        filesChanged: 2,
      },
    ],
    "2026-06-01T00:00:00.000Z"
  );
}

describe("GET /api/replay/sessions —— createApp 集成", () => {
  it("已挂载 + sessions/skipped/windowDays shape", async () => {
    const db = freshDb();
    seed(db);
    const res = await createApp({ db }).request(
      "http://x/api/replay/sessions"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      sessions: {
        firstEventKey: string;
        commitCount: number;
        messageCount: number;
        repoKeys: string[];
      }[];
      skipped: number;
      windowDays: number;
    };
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(0);
    expect(body.windowDays).toBe(90);
    expect(body.sessions.length).toBe(1);
    expect(body.sessions[0].commitCount).toBe(1);
    expect(body.sessions[0].messageCount).toBe(2);
    expect(body.sessions[0].repoKeys).toEqual([P]);
  });

  it("空库 → 200 + sessions []", async () => {
    const db = freshDb();
    const res = await createApp({ db }).request(
      "http://x/api/replay/sessions"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[]; skipped: number };
    expect(body.sessions).toEqual([]);
    expect(body.skipped).toBe(0);
  });

  it("windowDays 非法 → 400", async () => {
    const db = freshDb();
    const res = await createApp({ db }).request(
      "http://x/api/replay/sessions?windowDays=-3"
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/replay/session —— createApp 集成", () => {
  it("按 key 返回交织流(commit 带 matchedCount)", async () => {
    const db = freshDb();
    seed(db);
    const app = createApp({ db });
    // 先拿 firstEventKey。
    const listRes = await app.request("http://x/api/replay/sessions");
    const list = (await listRes.json()) as {
      sessions: { firstEventKey: string }[];
    };
    const key = list.sessions[0].firstEventKey;

    const res = await app.request(
      `http://x/api/replay/session?key=${encodeURIComponent(key)}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      session: { commitCount: number; messageCount: number };
      events: { type: string; matchedCount?: number }[];
    };
    expect(body.ok).toBe(true);
    expect(body.session.commitCount).toBe(1);
    expect(body.events.map((e) => e.type)).toEqual([
      "message",
      "message",
      "commit",
    ]);
    const commit = body.events.find((e) => e.type === "commit")!;
    // m2(13:30)计入,m1(13:00,会话起点)被 strict > 排除。
    expect(commit.matchedCount).toBe(1);
  });

  it("缺 key → 400", async () => {
    const db = freshDb();
    const res = await createApp({ db }).request("http://x/api/replay/session");
    expect(res.status).toBe(400);
  });

  it("key 不存在 → 404", async () => {
    const db = freshDb();
    const res = await createApp({ db }).request(
      "http://x/api/replay/session?key=git:nope"
    );
    expect(res.status).toBe(404);
  });
});
