import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/open.js";
import { createApp } from "../src/serve/app.js";
import {
  getKimiDashboardSession,
  listKimiDashboardSessions,
  listKimiSessionMessages,
} from "../src/kimiHistory/sessions.js";

/**
 * kimi 会话列表的两表 JOIN。
 *
 * 头等大事是**粒度**:`kimi_agent_token_usage` 是 `(session_id, agent)` 粒度,
 * 一个会话下有 N 个 `agents/<x>/wire.jsonl`。设计评审里给出的
 * `SELECT DISTINCT session_id, title, ...` 在真库上返回 62 行而不是 31 ——
 * 各 agent 的 title 恰好一致,但 `last_updated_at` 有 7 个会话不同,DISTINCT
 * 于是按 agent 展开。下面第一组用例就是钉住这件事的。
 */

const AT = "2026-08-19T02:00:00.000Z";

function freshDb(): Database.Database {
  return openDatabase(join(mkdtempSync(join(tmpdir(), "ai2nao-kimi-sess-")), "t.db"));
}

function seedAgent(
  db: Database.Database,
  o: {
    session: string;
    agent: string;
    title?: string | null;
    project?: string;
    createdAt?: string | null;
    updatedAt?: string;
    missing?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO kimi_agent_token_usage
       (session_id, agent, file_path, file_mtime_ms, file_size_bytes, root_kind,
        cwd, project_key, project_path, identity_confidence, title, model,
        created_at, last_updated_at, token_status, parse_error, missing_since,
        source_seen_at, updated_at)
     VALUES (?, ?, ?, 0, 0, 'cli', ?, ?, ?, 'high', ?, 'kimi-code/k3',
             ?, ?, 'full', null, ?, ?, ?)`
  ).run(
    o.session,
    o.agent,
    `/p/${o.session}/${o.agent}`,
    o.project ?? "/work/demo",
    o.project ?? "/work/demo",
    o.project ?? "/work/demo",
    o.title === undefined ? "会话标题" : o.title,
    o.createdAt === undefined ? AT : o.createdAt,
    o.updatedAt ?? AT,
    o.missing ?? null,
    AT,
    AT
  );
}

let messageKey = 0;
function seedMessage(
  db: Database.Database,
  o: {
    session: string;
    text: string;
    isHuman: boolean;
    role?: "user" | "assistant";
    at?: string;
  }
): void {
  db.prepare(
    `INSERT INTO agent_user_messages
       (source, source_session_id, source_message_key, project, event_at_utc,
        raw_text, raw_payload_json, cleaned_text, is_human, char_len,
        cleaner_version, parser_version, source_path, source_seen_at,
        ingested_at, updated_at, role)
     VALUES ('kimi', ?, ?, '/work/demo', ?, ?, '{}', ?, ?, ?, 1, 1,
             '/p/x', ?, ?, ?, ?)`
  ).run(
    o.session,
    `k-${messageKey++}`,
    o.at ?? AT,
    o.text,
    o.text,
    o.isHuman ? 1 : 0,
    o.text.length,
    AT,
    AT,
    AT,
    o.role ?? (o.isHuman ? "user" : "assistant")
  );
}

function markSyncRan(db: Database.Database, status = "success", error: string | null = null): void {
  db.prepare(
    `INSERT INTO agent_user_messages_sync_state
       (source, watermark_ms, last_run_at, last_status, last_error)
     VALUES ('kimi', 0, ?, ?, ?)`
  ).run(AT, status, error);
}

describe("listKimiDashboardSessions —— 粒度", () => {
  it("一个会话有多个 agent 时只出一行(不是每 agent 一行)", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main" });
    seedAgent(db, { session: "s1", agent: "agent-0" });
    seedAgent(db, { session: "s1", agent: "agent-1" });
    const { sessions } = listKimiDashboardSessions(db);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.agentCount).toBe(3);
    db.close();
  });

  it("各 agent 的时间戳不同时,取最早的 created 与最晚的 updated", () => {
    const db = freshDb();
    seedAgent(db, {
      session: "s1", agent: "main",
      createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
    });
    seedAgent(db, {
      session: "s1", agent: "agent-0",
      createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z",
    });
    const { sessions } = listKimiDashboardSessions(db);
    // DISTINCT 会在这里退化成两行 —— 这正是评审里那个写法在真库上翻车的原因。
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.createdAt).toBe("2026-08-10T00:00:00.000Z");
    expect(sessions[0]!.lastUpdatedAt).toBe("2026-08-15T00:00:00.000Z");
    db.close();
  });

  it("missing_since 的 agent 不进列表;整场都 missing 则会话消失", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main" });
    seedAgent(db, { session: "s1", agent: "agent-0", missing: AT });
    seedAgent(db, { session: "s2", agent: "main", missing: AT });
    const { sessions } = listKimiDashboardSessions(db);
    expect(sessions.map((s) => s.sessionId)).toEqual(["s1"]);
    expect(sessions[0]!.agentCount).toBe(1);
    db.close();
  });

  it("按最后更新倒序", () => {
    const db = freshDb();
    seedAgent(db, { session: "old", agent: "main", updatedAt: "2026-08-01T00:00:00.000Z" });
    seedAgent(db, { session: "new", agent: "main", updatedAt: "2026-08-20T00:00:00.000Z" });
    const { sessions } = listKimiDashboardSessions(db);
    expect(sessions.map((s) => s.sessionId)).toEqual(["new", "old"]);
    db.close();
  });
});

describe("listKimiDashboardSessions —— 计数与 preview", () => {
  it("messageCount 数真人提问,不数 AI 正文", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main" });
    seedMessage(db, { session: "s1", text: "我的问题", isHuman: true });
    seedMessage(db, { session: "s1", text: "AI 的回答", isHuman: false });
    seedMessage(db, { session: "s1", text: "又一个 AI 回答", isHuman: false });
    const s = listKimiDashboardSessions(db).sessions[0]!;
    expect(s.humanMessageCount).toBe(1);
    expect(s.totalMessageCount).toBe(3);
    db.close();
  });

  it("preview 取最早的真人提问(按时间,不是字典序)", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main" });
    // 字典序在前但时间在后 —— MIN(cleaned_text) 会取错这条。
    seedMessage(db, { session: "s1", text: "AAA 后问的", isHuman: true, at: "2026-08-19T05:00:00.000Z" });
    seedMessage(db, { session: "s1", text: "先问的", isHuman: true, at: "2026-08-19T01:00:00.000Z" });
    expect(listKimiDashboardSessions(db).sessions[0]!.preview).toBe("先问的");
    db.close();
  });

  it("零真人提问的会话仍上列,preview 退回最早的 AI 正文", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main" });
    seedMessage(db, { session: "s1", text: "只有 AI 说话", isHuman: false });
    const s = listKimiDashboardSessions(db).sessions[0]!;
    expect(s.humanMessageCount).toBe(0);
    expect(s.totalMessageCount).toBe(1);
    expect(s.preview).toBe("只有 AI 说话");
    db.close();
  });
});

describe("listKimiDashboardSessions —— 正文侧缺失的三种原因", () => {
  it("同步从未跑过 → not-ingested", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main" });
    const { sessions, diagnostics } = listKimiDashboardSessions(db);
    expect(sessions).toHaveLength(1);
    expect(diagnostics.map((d) => d.kind)).toEqual(["kimi-messages-not-ingested"]);
    db.close();
  });

  it("同步报错 → sync-failed(与「从未跑过」不是同一句话)", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main" });
    markSyncRan(db, "failed", "读不了 wire.jsonl");
    const { diagnostics } = listKimiDashboardSessions(db);
    expect(diagnostics[0]!.kind).toBe("kimi-messages-sync-failed");
    expect(diagnostics[0]!.message).toContain("读不了 wire.jsonl");
    db.close();
  });

  it("同步成功但这场就是没有正文 → messages-missing", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main" });
    markSyncRan(db);
    const { diagnostics } = listKimiDashboardSessions(db);
    expect(diagnostics[0]!.kind).toBe("kimi-messages-missing");
    db.close();
  });

  it("每场都有正文时不报诊断", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main" });
    seedMessage(db, { session: "s1", text: "问题", isHuman: true });
    markSyncRan(db);
    expect(listKimiDashboardSessions(db).diagnostics).toHaveLength(0);
    db.close();
  });

  it("token 表被删(旧库)→ 出诊断,不抛,不静默返回空", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main" });
    db.exec("DROP TABLE kimi_agent_token_usage");
    const { sessions, diagnostics } = listKimiDashboardSessions(db);
    expect(sessions).toHaveLength(0);
    expect(diagnostics.map((d) => d.kind)).toEqual(["kimi-sessions-unavailable"]);
    db.close();
  });
});

describe("listKimiSessionMessages", () => {
  it("按时序返回真人提问与 AI 正文", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main" });
    seedMessage(db, { session: "s1", text: "问", isHuman: true, at: "2026-08-19T01:00:00.000Z" });
    seedMessage(db, { session: "s1", text: "答", isHuman: false, at: "2026-08-19T02:00:00.000Z" });
    const m = listKimiSessionMessages(db, "s1");
    expect(m.map((x) => x.text)).toEqual(["问", "答"]);
    expect(m.map((x) => x.role)).toEqual(["user", "assistant"]);
    db.close();
  });

  it("排除 role=user 但 is_human=0 的工具噪音(<bash-input> 那类)", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main" });
    seedMessage(db, { session: "s1", text: "真问题", isHuman: true });
    seedMessage(db, { session: "s1", text: "<bash-input> ls </bash-input>", isHuman: false, role: "user" });
    const m = listKimiSessionMessages(db, "s1");
    expect(m.map((x) => x.text)).toEqual(["真问题"]);
    db.close();
  });

  it("全是工具噪音的会话 → 空数组,与列表页的「提问 0」对得上", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main" });
    seedMessage(db, { session: "s1", text: "<bash-input> ls </bash-input>", isHuman: false, role: "user" });
    expect(listKimiSessionMessages(db, "s1")).toHaveLength(0);
    expect(listKimiDashboardSessions(db).sessions[0]!.humanMessageCount).toBe(0);
    db.close();
  });

  it("不存在的会话 → 空数组,不抛", () => {
    const db = freshDb();
    expect(listKimiSessionMessages(db, "nope")).toEqual([]);
    expect(getKimiDashboardSession(db, "nope")).toBeNull();
    db.close();
  });
});

describe("路由", () => {
  function app(db: Database.Database) {
    return createApp({ db } as never);
  }

  it("GET /api/kimi-history/sessions 返回列表与诊断", async () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main" });
    seedMessage(db, { session: "s1", text: "问题", isHuman: true });
    markSyncRan(db);
    const res = await app(db).request("http://x/api/kimi-history/sessions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[]; diagnostics: unknown[] };
    expect(body.sessions).toHaveLength(1);
    expect(body.diagnostics).toHaveLength(0);
    db.close();
  });

  it("GET /api/kimi-history/sessions/:id 返回会话与正文", async () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main" });
    seedMessage(db, { session: "s1", text: "问题", isHuman: true });
    const res = await app(db).request("http://x/api/kimi-history/sessions/s1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { agentCount: number }; messages: unknown[] };
    expect(body.session.agentCount).toBe(1);
    expect(body.messages).toHaveLength(1);
    db.close();
  });

  it("会话不存在 → 404;会话存在但无正文 → 200 加空数组", async () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main" });
    const missing = await app(db).request("http://x/api/kimi-history/sessions/nope");
    expect(missing.status).toBe(404);
    // 「没内容」不能长得像「不存在」—— 前端据此走空态而不是错误页。
    const empty = await app(db).request("http://x/api/kimi-history/sessions/s1");
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { messages: unknown[] }).messages).toHaveLength(0);
    db.close();
  });
});
