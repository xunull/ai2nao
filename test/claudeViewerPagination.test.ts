import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeSession,
  mapRecordToMessage,
} from "../src/claudeCodeHistory/normalize.js";
import { parseJsonlText } from "../src/claudeCodeHistory/parseJsonl.js";
import {
  listSessionSummaries,
  loadClaudeSessionMessagePage,
  loadClaudeSessionMeta,
} from "../src/claudeCodeHistory/load.js";
import { resetSessionIndexCache } from "../src/claudeCodeHistory/sessionIndex.js";
import { MAX_JSONL_LINES } from "../src/claudeCodeHistory/constants.js";
import { createApp } from "../src/serve/app.js";
import { openDatabase } from "../src/store/open.js";

// TZ 固定,避免 Date 展示随机器时区漂移。
const PRIOR_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Asia/Shanghai";
});
afterAll(() => {
  process.env.TZ = PRIOR_TZ;
});

let root: string; // projects 根
let projectDir: string; // 单个 project 目录
const PROJECT_ID = "proj-x";
const FAKE_CWD = "/tmp/work/app"; // FAKE 路径(gitleaks 会拦真实 /Users/X/)

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "ai2nao-viewer-"));
  root = join(base, "projects");
  projectDir = join(root, PROJECT_ID);
  mkdirSync(projectDir, { recursive: true });
  resetSessionIndexCache();
});

function line(rec: Record<string, unknown>): string {
  return JSON.stringify(rec);
}

const userLine = (
  ts: string,
  content: string,
  extra: Record<string, unknown> = {}
) =>
  line({
    type: "user",
    uuid: `u-${ts}`,
    timestamp: ts,
    sessionId: "sid",
    cwd: FAKE_CWD,
    message: { role: "user", content },
    ...extra,
  });

const asstLine = (
  ts: string,
  text: string,
  extra: Record<string, unknown> = {}
) =>
  line({
    type: "assistant",
    uuid: `a-${ts}`,
    timestamp: ts,
    sessionId: "sid",
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        { type: "tool_use", name: "Read", input: { path: "/tmp/f" } },
      ],
      model: "m",
      usage: { input_tokens: 1, output_tokens: 2 },
    },
    ...extra,
  });

const eventLine = (ts: string, extra: Record<string, unknown> = {}) =>
  line({ type: "queue-operation", timestamp: ts, sessionId: "sid", ...extra });

/** 写一个 session 文件(带末尾 \n),返回 { sessionId, content }。 */
function writeSession(name: string, lines: string[]): { sessionId: string; content: string } {
  const content = lines.join("\n") + "\n";
  writeFileSync(join(projectDir, `${name}.jsonl`), content, "utf8");
  return { sessionId: name, content };
}

describe("mapRecordToMessage 抽取后与 buildClaudeSession 逐字对齐", () => {
  it("单条记录映射:user/assistant(折叠 tool_use)/appendix + 缺 uuid 用绝对行号合成 id", () => {
    const mtime = 1_700_000_000_000;

    // user 带 uuid
    const u = mapRecordToMessage(
      { type: "user", uuid: "U1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hi" } },
      3,
      mtime
    )!;
    expect(u.id).toBe("U1");
    expect(u.role).toBe("user");
    expect(u.content).toBe("hi");

    // user 无 uuid → user-L<绝对行号>
    const u2 = mapRecordToMessage(
      { type: "user", message: { role: "user", content: "no id" } },
      7,
      mtime
    )!;
    expect(u2.id).toBe("user-L7");
    // 缺 timestamp → 回退到 fileMtime
    expect(u2.timestamp.getTime()).toBe(mtime);

    // assistant 折叠 tool_use
    const a = mapRecordToMessage(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "answer" },
            { type: "tool_use", name: "Bash", input: { cmd: "ls" } },
          ],
          model: "opus",
          usage: { input_tokens: 5, output_tokens: 9 },
        },
      },
      9,
      mtime
    )!;
    expect(a.id).toBe("assistant-L9");
    expect(a.role).toBe("assistant");
    expect(a.content).toBe("answer");
    expect(a.model).toBe("opus");
    expect(a.toolCalls).toEqual([
      { name: "Bash", status: "completed", params: { cmd: "ls" } },
    ]);
    expect(a.tokenUsage?.outputTokens).toBe(9);

    // 其它类型 → appendix(role=assistant, metadata.claudeAppendix)
    const ev = mapRecordToMessage(
      { type: "queue-operation", timestamp: "2026-01-01T00:00:05.000Z" },
      11,
      mtime
    )!;
    expect(ev.id).toBe("event-L11");
    expect(ev.role).toBe("assistant");
    expect(ev.metadata?.claudeAppendix).toBe(true);
    expect(ev.metadata?.claudeEventType).toBe("queue-operation");
  });

  it("整条会话:buildClaudeSession 的消息序列(id/role/toolCalls/appendix)符合预期", () => {
    const lines = [
      userLine("2026-01-01T00:00:01.000Z", "第一条用户消息 hello"),
      asstLine("2026-01-01T00:00:02.000Z", "world"),
      line({ type: "user", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: "no uuid user" } }), // 缺 uuid → user-L3
      eventLine("2026-01-01T00:00:04.000Z", { uuid: "E1" }),
    ];
    const content = lines.join("\n") + "\n";
    const { session } = buildClaudeSession({
      projectId: PROJECT_ID,
      sessionId: "sid",
      parse: parseJsonlText(content),
      fileMtimeMs: 0,
    });

    expect(session.messages.map((m) => m.id)).toEqual([
      "u-2026-01-01T00:00:01.000Z",
      "a-2026-01-01T00:00:02.000Z",
      "user-L3",
      "E1",
    ]);
    expect(session.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    // assistant 折叠出 toolCalls
    expect(session.messages[1].toolCalls).toEqual([
      { name: "Read", status: "completed", params: { path: "/tmp/f" } },
    ]);
    // 事件行折叠为 appendix
    expect(session.messages[3].metadata?.claudeAppendix).toBe(true);
    expect(session.title).toBe("第一条用户消息 hello");
  });
});

describe("loadClaudeSessionMessagePage 游标分页", () => {
  it("两页拼接 == 整会话消息;游标推进无重复无丢失;末页 nextCursor=null", async () => {
    const lines = [
      userLine("2026-01-01T00:00:01.000Z", "第一条用户消息 hello"), // L1 → u
      asstLine("2026-01-01T00:00:02.000Z", "a1"), // L2 → a
      line({ type: "user", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: "third" } }), // L3 → user-L3
      eventLine("2026-01-01T00:00:04.000Z", { uuid: "E1" }), // L4 → appendix E1
      line({ type: "assistant", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "last" }] } }), // L5 → assistant-L5
    ];
    const { sessionId, content } = writeSession("multi", lines);

    // 参照:整文件 buildClaudeSession(时间戳齐全,不触发 mtime 回退)
    const { session: ref } = buildClaudeSession({
      projectId: PROJECT_ID,
      sessionId,
      parse: parseJsonlText(content),
      fileMtimeMs: 0,
    });

    // 逐页取(limit=2)
    const collected: unknown[] = [];
    let cursor: number | null = 0;
    const cursorsSeen: number[] = [];
    const nextCursors: (number | null)[] = [];
    while (cursor != null) {
      const page = await loadClaudeSessionMessagePage(root, PROJECT_ID, sessionId, {
        cursor,
        limit: 2,
      });
      expect(page).not.toBeNull();
      cursorsSeen.push(cursor);
      collected.push(...page!.messages);
      nextCursors.push(page!.nextCursor);
      cursor = page!.nextCursor;
    }

    // 游标序列:0 → 2 → 4 → (null)
    expect(cursorsSeen).toEqual([0, 2, 4]);
    expect(nextCursors).toEqual([2, 4, null]);

    // 拼接的消息序列(id)== 整会话,顺序 oldest→new,无重复无丢失
    expect(collected.map((m: any) => m.id)).toEqual(ref.messages.map((m) => m.id));
    // 合成 id 使用「绝对物理行号」
    expect(collected.map((m: any) => m.id)).toContain("user-L3");
    expect(collected.map((m: any) => m.id)).toContain("assistant-L5");
    // 消息对象与整文件路径逐字段一致(role/content/toolCalls/metadata/timestamp/…)
    expect(collected).toEqual(ref.messages);
  });

  it("绝对行号计入空行/坏行:合成 id 用物理行号,页内静默跳过空行与坏行", async () => {
    const lines = [
      "", // L1 空行
      "not-json", // L2 坏行
      line({ type: "assistant", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "x" }] } }), // L3 → assistant-L3(无 uuid)
    ];
    const { sessionId } = writeSession("holes", lines);

    const page = await loadClaudeSessionMessagePage(root, PROJECT_ID, sessionId, {
      cursor: 0,
      limit: 50,
    });
    expect(page).not.toBeNull();
    // 只产出 1 条消息(空行 + 坏行被跳过),且用物理行号 L3
    expect(page!.messages.map((m) => m.id)).toEqual(["assistant-L3"]);
    expect(page!.hasMore).toBe(false);
    expect(page!.nextCursor).toBeNull();
  });

  it("limit 被裁剪到上限 200;找不到 session → null", async () => {
    const { sessionId } = writeSession("solo", [
      userLine("2026-01-01T00:00:01.000Z", "hi"),
    ]);
    const page = await loadClaudeSessionMessagePage(root, PROJECT_ID, sessionId, {
      cursor: 0,
      limit: 9999,
    });
    expect(page!.messages).toHaveLength(1);
    expect(page!.hasMore).toBe(false);

    const miss = await loadClaudeSessionMessagePage(root, PROJECT_ID, "nope", {});
    expect(miss).toBeNull();
  });
});

describe("loadClaudeSessionMeta 头部", () => {
  it("header 的 messageCount/title/时间范围与整会话一致", async () => {
    const lines = [
      userLine("2026-01-01T00:00:03.000Z", "第一条用户消息 hello"),
      asstLine("2026-01-01T00:00:01.000Z", "world"),
      eventLine("2026-01-01T00:00:05.000Z"),
    ];
    const { sessionId, content } = writeSession("meta", lines);
    const { session } = buildClaudeSession({
      projectId: PROJECT_ID,
      sessionId,
      parse: parseJsonlText(content),
      fileMtimeMs: 0,
    });

    const meta = await loadClaudeSessionMeta(root, PROJECT_ID, sessionId);
    expect(meta).not.toBeNull();
    expect(meta!.header.messageCount).toBe(session.messageCount); // 3
    expect(meta!.header.title).toBe(session.title);
    expect(meta!.header.createdAt.getTime()).toBe(session.createdAt.getTime()); // min = 00:00:01
    expect(meta!.header.lastUpdatedAt.getTime()).toBe(session.lastUpdatedAt.getTime()); // max = 00:00:05
    expect(meta!.header.workspacePath).toBe(FAKE_CWD);

    const miss = await loadClaudeSessionMeta(root, PROJECT_ID, "nope");
    expect(miss).toBeNull();
  });
});

describe("listSessionSummaries 走 sessionIndex header", () => {
  it("小文件:摘要字段(title/preview/messageCount/时间/workspacePath)正确", async () => {
    const lines = [
      userLine("2026-01-01T00:00:02.000Z", "第一条用户消息 hello"),
      asstLine("2026-01-01T00:00:04.000Z", "world"),
    ];
    const { sessionId, content } = writeSession("small", lines);
    const { summary: ref } = buildClaudeSession({
      projectId: PROJECT_ID,
      sessionId,
      parse: parseJsonlText(content),
      fileMtimeMs: 0,
    });

    const rows = await listSessionSummaries(root, PROJECT_ID);
    expect(rows).toHaveLength(1);
    const s = rows[0];
    expect(s.id).toBe(sessionId);
    expect(s.title).toBe(ref.title);
    expect(s.preview).toBe(ref.preview);
    expect(s.messageCount).toBe(ref.messageCount); // 2
    expect(s.workspacePath).toBe(FAKE_CWD);
    expect(s.createdAt.getTime()).toBe(ref.createdAt.getTime());
    expect(s.lastUpdatedAt.getTime()).toBe(ref.lastUpdatedAt.getTime());
    expect(s.index).toBe(1); // 排序后 1-based
  });

  it("行数超限文件 → 保留『(行数过多)』占位摘要(guard 未丢)", async () => {
    // MAX_JSONL_LINES+1 条极简 ok 行 → getSessionIndex 抛 ClaudeTranscriptTooLargeError(lines)
    writeFileSync(
      join(projectDir, "huge.jsonl"),
      "{}\n".repeat(MAX_JSONL_LINES + 1),
      "utf8"
    );
    const rows = await listSessionSummaries(root, PROJECT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("(行数过多)");
    expect(rows[0].messageCount).toBe(0);
    expect(rows[0].preview).toContain("lines");
  });
});

describe("createApp 详情路由分页集成", () => {
  it("?meta=1 → 200 + header;?cursor=0&limit=2 → 200 + 一页消息", async () => {
    const lines = [
      userLine("2026-01-01T00:00:01.000Z", "第一条用户消息 hello"),
      asstLine("2026-01-01T00:00:02.000Z", "a1"),
      eventLine("2026-01-01T00:00:03.000Z", { uuid: "E1" }),
    ];
    const { sessionId } = writeSession("api", lines);

    const base = mkdtempSync(join(tmpdir(), "ai2nao-viewer-db-"));
    const db = openDatabase(join(base, "idx.db"));
    try {
      const app = createApp({ db });
      const q = `projectsRoot=${encodeURIComponent(root)}`;
      const url = `http://x/api/claude-code-history/projects/${PROJECT_ID}/sessions/${sessionId}`;

      // meta
      const metaRes = await app.request(`${url}?${q}&meta=1`);
      expect(metaRes.status).toBe(200);
      const metaJson = (await metaRes.json()) as {
        ok: boolean;
        header: { messageCount: number; title: string; createdAt: string; lastUpdatedAt: string; workspacePath: string };
      };
      expect(metaJson.ok).toBe(true);
      expect(metaJson.header.messageCount).toBe(3);
      expect(metaJson.header.title).toBe("第一条用户消息 hello");
      expect(metaJson.header.workspacePath).toBe(FAKE_CWD);
      expect(typeof metaJson.header.createdAt).toBe("string");

      // page
      const pageRes = await app.request(`${url}?${q}&cursor=0&limit=2`);
      expect(pageRes.status).toBe(200);
      const pageJson = (await pageRes.json()) as {
        ok: boolean;
        messages: { id: string; role: string }[];
        nextCursor: number | null;
        hasMore: boolean;
      };
      expect(pageJson.ok).toBe(true);
      expect(pageJson.messages).toHaveLength(2);
      expect(pageJson.messages[0].id).toBe("u-2026-01-01T00:00:01.000Z");
      expect(pageJson.messages[0].role).toBe("user");
      expect(pageJson.hasMore).toBe(true);
      expect(pageJson.nextCursor).toBe(2);

      // 末页
      const lastRes = await app.request(`${url}?${q}&cursor=2&limit=2`);
      const lastJson = (await lastRes.json()) as {
        messages: unknown[];
        nextCursor: number | null;
        hasMore: boolean;
      };
      expect(lastJson.messages).toHaveLength(1);
      expect(lastJson.hasMore).toBe(false);
      expect(lastJson.nextCursor).toBeNull();

      // 缺省(无参)仍回整会话(向后兼容)
      const wholeRes = await app.request(`${url}?${q}`);
      expect(wholeRes.status).toBe(200);
      const wholeJson = (await wholeRes.json()) as { ok: boolean; session: { messages: unknown[] } };
      expect(wholeJson.ok).toBe(true);
      expect(wholeJson.session.messages).toHaveLength(3);
    } finally {
      db.close();
    }
  });
});
