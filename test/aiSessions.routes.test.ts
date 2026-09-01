process.env.TZ = "Asia/Shanghai";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/store/migrations.js";
import { registerAiSessionsRoutes } from "../src/aiSessions/routes.js";

function appWithDb(): { app: Hono; db: Database.Database } {
  const db = new Database(join(mkdtempSync(join(tmpdir(), "ai2nao-sr-")), "t.db"));
  migrate(db);
  const app = new Hono();
  registerAiSessionsRoutes(app, db);
  return { app, db };
}

let seq = 0;
function seedMsg(db: Database.Database, session: string, atLocal: string, source = "claude"): void {
  const utc = new Date(`${atLocal}+08:00`).toISOString();
  db.prepare(
    `INSERT INTO agent_user_messages
       (source, source_session_id, source_message_key, project, event_at_utc,
        raw_text, raw_payload_json, cleaned_text, is_human, char_len,
        cleaner_version, parser_version, source_path, source_seen_at,
        ingested_at, updated_at, role)
     VALUES (?, ?, ?, '/work/app', ?, '问', '[]', '问', 1, 1, 1, 1, '/p', ?, ?, ?, 'user')`
  ).run(source, session, `k-${seq++}`, utc, utc, utc, utc);
}

describe("GET /api/ai-sessions", () => {
  it("默认 3m，返回两条线 + 覆盖面说明", async () => {
    const { app, db } = appWithDb();
    seedMsg(db, "s1", new Date().toISOString().slice(0, 10) + "T10:00:00");
    const res = await app.request("/api/ai-sessions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.window).toBe("3m");
    expect(Array.isArray(body.active)).toBe(true);
    expect(Array.isArray(body.started)).toBe(true);
    // 覆盖面必须随数字一起下发 —— 少了它,这个数读起来像「全部 AI 会话」。
    // 这条断言**钉死整个列表**是有意的:往 agent_user_messages 加源不会让 tsc 报到
    // 这里(AgentUserMessageSource 是协变位置),所以这条测试是唯一会红的东西。
    // 加源时它红了 → 说明你还没把新源写进覆盖面声明,不是测试过时了。
    expect(body.coverage.sources).toEqual(["claude", "codex", "kimi", "opencode", "hermes"]);
    expect(body.coverage.note).toMatch(/cursor|cherry/);
    expect(body.coverage.note).toMatch(/minimax/);
    expect(body.coverage.note).toMatch(/hermes/);
    db.close();
  });

  it("非法 window → 400，且错误信息列出合法值", async () => {
    const { app, db } = appWithDb();
    const res = await app.request("/api/ai-sessions?window=99y");
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.message).toContain("1d|3d|1w|2w|1m|3m|6m");
    db.close();
  });

  it("合计恒等于逐源之和（顶层丢掉 source 会破这条）", async () => {
    const { app, db } = appWithDb();
    const today = new Date().toISOString().slice(0, 10);
    seedMsg(db, "same-id", `${today}T10:00:00`, "claude");
    seedMsg(db, "same-id", `${today}T11:00:00`, "codex");

    const body = (await (await app.request("/api/ai-sessions")).json()) as any;
    for (const p of body.active) {
      const sum = Object.values(p.bySource as Record<string, number>).reduce(
        (a: number, b: number) => a + b,
        0
      );
      expect(p.sessions).toBe(sum);
    }
    db.close();
  });
});

describe("GET /api/ai-sessions/day/:day", () => {
  it("列出当天会话；没有时长记录的也在列表里", async () => {
    const { app, db } = appWithDb();
    seedMsg(db, "orphan", "2026-06-01T10:00:00", "kimi");
    const body = (await (await app.request("/api/ai-sessions/day/2026-06-01")).json()) as any;
    expect(body.day).toBe("2026-06-01");
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].title).toBeNull();
    expect(body.sessions[0].sessionId).toBe("orphan");
    db.close();
  });

  it("非法日期 → 400", async () => {
    const { app, db } = appWithDb();
    expect((await app.request("/api/ai-sessions/day/2026-6-1")).status).toBe(400);
    db.close();
  });
});
