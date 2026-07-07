import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessionIndex,
  getSessionIndex,
  getSessionIndexCacheStats,
  readLineRange,
  resetSessionIndexCache,
} from "../src/claudeCodeHistory/sessionIndex.js";
import { buildClaudeSession } from "../src/claudeCodeHistory/normalize.js";
import { parseJsonlText } from "../src/claudeCodeHistory/parseJsonl.js";

// TZ 固定,避免 Date 展示随机器时区漂移(本套断言用 getTime 绝对值,固定亦为规范一致)。
const PRIOR_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Asia/Shanghai";
});
afterAll(() => {
  process.env.TZ = PRIOR_TZ;
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai2nao-sessidx-"));
  resetSessionIndexCache();
});
afterAll(() => {
  // 用例目录留在 OS tmp 下即可;这里不强清,避免与并发用例互相踩。
});

// fixture 里所有 cwd 用 FAKE `/tmp/...`(gitleaks 会拦真实 /Users/X/ 家目录路径)。
const FAKE_CWD = "/tmp/work/app";

function line(rec: Record<string, unknown>): string {
  return JSON.stringify(rec);
}

function write(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

/** 假设文件内容为 lines.join("\n") + 每行后跟一个 \n(全部完整行)时的字节偏移。 */
function expectedOffsets(lines: string[]): number[] {
  const offs: number[] = [];
  let acc = 0;
  for (const l of lines) {
    offs.push(acc);
    acc += Buffer.byteLength(l + "\n", "utf8");
  }
  return offs;
}

const userLine = (ts: string, content: string, extra: Record<string, unknown> = {}) =>
  line({
    type: "user",
    uuid: `u-${ts}`,
    timestamp: ts,
    sessionId: "sid",
    cwd: FAKE_CWD,
    message: { role: "user", content },
    ...extra,
  });

const asstLine = (ts: string, text: string) =>
  line({
    type: "assistant",
    uuid: `a-${ts}`,
    timestamp: ts,
    sessionId: "sid",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      model: "m",
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  });

const eventLine = (ts: string) =>
  line({ type: "queue-operation", timestamp: ts, sessionId: "sid" });

describe("sessionIndex 偏移与切片", () => {
  it("lineOffsets 指向每行起始;readLineRange 精确回读该范围(含多字节中文)", async () => {
    const lines = [
      userLine("2026-01-01T00:00:01.000Z", "第一条用户消息 hello"),
      asstLine("2026-01-01T00:00:02.000Z", "world 世界"),
      eventLine("2026-01-01T00:00:03.000Z"),
    ];
    const p = write("a.jsonl", lines.join("\n") + "\n");

    const idx = await buildSessionIndex(p, { fileMtimeMs: 0, projectId: "proj", sessionId: "sid" });

    expect(idx.lineOffsets).toEqual(expectedOffsets(lines));
    expect(idx.lineCount).toBe(3);
    expect(idx.byteLength).toBe(Buffer.byteLength(lines.join("\n") + "\n", "utf8"));

    // 全量回读 == 原始行
    expect(await readLineRange(p, idx, 0, idx.lineCount)).toEqual(lines);
    // 子区间(半开):[1,2) → 只有第 2 行
    expect(await readLineRange(p, idx, 1, 2)).toEqual([lines[1]]);
    // endLine 越界 → 读到 EOF
    expect(await readLineRange(p, idx, 2, 99)).toEqual([lines[2]]);
    // 空区间
    expect(await readLineRange(p, idx, 1, 1)).toEqual([]);
  });

  it("末尾无 \\n 的半截行被排除出 lineOffsets/计数,byteLength 停在半截行之前", async () => {
    const lines = [
      userLine("2026-01-01T00:00:01.000Z", "hi"),
      asstLine("2026-01-01T00:00:02.000Z", "yo"),
      eventLine("2026-01-01T00:00:03.000Z"),
    ];
    // 注意:没有末尾 \n,最后一行是半截行
    const p = write("tail.jsonl", lines.join("\n"));

    const idx = await buildSessionIndex(p, { fileMtimeMs: 0 });

    expect(idx.lineCount).toBe(2); // 只有前两行完整
    expect(idx.lineOffsets).toEqual(expectedOffsets(lines).slice(0, 2));
    expect(idx.byteLength).toBe(expectedOffsets(lines)[2]); // = 半截行的起点
    expect(idx.header.messageCount).toBe(2); // 半截行不计入展示条数
    expect(await readLineRange(p, idx, 0, idx.lineCount)).toEqual(lines.slice(0, 2));
  });
});

describe("sessionIndex header 聚合(对齐 buildClaudeSession)", () => {
  it("messageCount / createdAt / lastUpdatedAt / firstUserText / workspacePath / warnings 均一致", async () => {
    const lines = [
      userLine("2026-01-01T00:00:03.000Z", "第一条用户消息 hello"),
      asstLine("2026-01-01T00:00:01.000Z", "world"),
      eventLine("2026-01-01T00:00:05.000Z"),
    ];
    const content = lines.join("\n") + "\n";
    const p = write("hdr.jsonl", content);
    const fileMtimeMs = 1_700_000_000_000;

    const idx = await buildSessionIndex(p, {
      fileMtimeMs,
      projectId: "proj",
      sessionId: "sid",
    });
    // 交叉核对:同内容跑 buildClaudeSession
    const { session, warnings } = buildClaudeSession({
      projectId: "proj",
      sessionId: "sid",
      parse: parseJsonlText(content),
      fileMtimeMs,
    });

    expect(idx.header.messageCount).toBe(session.messageCount);
    expect(idx.header.createdAt.getTime()).toBe(session.createdAt.getTime()); // = min(ts) = 00:00:01
    expect(idx.header.lastUpdatedAt.getTime()).toBe(session.lastUpdatedAt.getTime()); // = max(ts) = 00:00:05
    expect(idx.header.title).toBe(session.title);
    expect(idx.header.workspacePath).toBe(session.workspacePath); // = FAKE_CWD
    expect(idx.header.firstUserText).toBe("第一条用户消息 hello");
    expect(idx.header.warnings).toEqual(warnings);
    expect(idx.header.warnings).toEqual([]);
  });

  it("时间戳全缺失 → createdAt/lastUpdatedAt 回退 fileMtime", async () => {
    const lines = [line({ type: "user", sessionId: "sid", message: { role: "user", content: "no ts" } })];
    const p = write("nots.jsonl", lines.join("\n") + "\n");
    const fileMtimeMs = 1_711_111_111_111;
    const idx = await buildSessionIndex(p, { fileMtimeMs });
    expect(idx.header.createdAt.getTime()).toBe(fileMtimeMs);
    expect(idx.header.lastUpdatedAt.getTime()).toBe(fileMtimeMs);
  });

  it("多个 sessionId / sessionId 不匹配 → 告警对齐 buildClaudeSession", async () => {
    const content =
      [
        line({ type: "user", timestamp: "2026-01-01T00:00:01.000Z", sessionId: "sA", message: { role: "user", content: "x" } }),
        line({ type: "user", timestamp: "2026-01-01T00:00:02.000Z", sessionId: "sB", message: { role: "user", content: "y" } }),
      ].join("\n") + "\n";
    const p = write("multi.jsonl", content);
    const idx = await buildSessionIndex(p, { fileMtimeMs: 0, sessionId: "sA" });
    const { warnings } = buildClaudeSession({
      projectId: "proj",
      sessionId: "sA",
      parse: parseJsonlText(content),
      fileMtimeMs: 0,
    });
    expect(idx.header.warnings).toEqual(warnings);
    expect(idx.header.warnings).toContain("multiple distinct sessionId values in file (2)");
  });
});

describe("sessionIndex 坏行与边界", () => {
  it("坏行:计入 warnings、排除出展示计数,但物理偏移仍记录", async () => {
    const lines = [
      userLine("2026-01-01T00:00:01.000Z", "ok1"),
      "not-json", // JSON.parse 失败
      asstLine("2026-01-01T00:00:02.000Z", "ok2"),
    ];
    const content = lines.join("\n") + "\n";
    const p = write("bad.jsonl", content);
    const idx = await buildSessionIndex(p, { fileMtimeMs: 0 });

    expect(idx.lineCount).toBe(3); // 物理行 3(含坏行)
    expect(idx.lineOffsets).toEqual(expectedOffsets(lines)); // 坏行偏移仍在
    expect(idx.header.messageCount).toBe(2); // 展示条数只算 ok 行
    expect(idx.header.warnings).toEqual(["1 JSONL line(s) failed to parse"]);
    // 坏行原文仍可按物理索引回读
    expect(await readLineRange(p, idx, 1, 2)).toEqual(["not-json"]);

    // 交叉核对 messageCount 口径
    const { session } = buildClaudeSession({
      projectId: "proj",
      sessionId: "sid",
      parse: parseJsonlText(content),
      fileMtimeMs: 0,
    });
    expect(idx.header.messageCount).toBe(session.messageCount);
  });

  it("空文件 → 空索引", async () => {
    const p = write("empty.jsonl", "");
    const idx = await buildSessionIndex(p, { fileMtimeMs: 42 });
    expect(idx.lineOffsets).toEqual([]);
    expect(idx.lineCount).toBe(0);
    expect(idx.byteLength).toBe(0);
    expect(idx.header.messageCount).toBe(0);
    expect(idx.header.title).toBe("(无用户消息)");
    expect(idx.header.createdAt.getTime()).toBe(42);
    expect(await readLineRange(p, idx, 0, 5)).toEqual([]);
  });

  it("单行(带 \\n) → 1 条", async () => {
    const one = userLine("2026-01-01T00:00:01.000Z", "solo");
    const p = write("one.jsonl", one + "\n");
    const idx = await buildSessionIndex(p, { fileMtimeMs: 0 });
    expect(idx.lineCount).toBe(1);
    expect(idx.lineOffsets).toEqual([0]);
    expect(await readLineRange(p, idx, 0, 1)).toEqual([one]);
  });
});

describe("sessionIndex 缓存有效性", () => {
  it("live append:size 增长 → 增量续扫(非重建),旧偏移不变,新行折叠进 header", async () => {
    const base = [
      userLine("2026-01-01T00:00:01.000Z", "第一条用户消息 hello"),
      asstLine("2026-01-01T00:00:02.000Z", "a"),
    ];
    const p = write("live.jsonl", base.join("\n") + "\n");

    const idx1 = await getSessionIndex(p, { fileMtimeMs: 0, projectId: "proj", sessionId: "sid" });
    expect(getSessionIndexCacheStats().fullBuilds).toBe(1);
    expect(getSessionIndexCacheStats().extends).toBe(0);
    const before = idx1.lineOffsets.slice();

    // 追加一行(size 增长)
    const appended = eventLine("2026-01-01T00:00:09.000Z");
    appendFileSync(p, appended + "\n", "utf8");

    const idx2 = await getSessionIndex(p, { fileMtimeMs: 0, projectId: "proj", sessionId: "sid" });
    expect(getSessionIndexCacheStats().extends).toBe(1); // 走了续扫
    expect(getSessionIndexCacheStats().fullBuilds).toBe(1); // 没有重建

    // 旧偏移原样保留在前缀
    expect(idx2.lineOffsets.slice(0, before.length)).toEqual(before);
    expect(idx1.lineOffsets).toEqual(before); // 缓存里的旧对象未被改动
    expect(idx2.lineCount).toBe(idx1.lineCount + 1);
    expect(idx2.header.messageCount).toBe(3);
    // 新行时间戳被折叠进 lastUpdatedAt
    expect(idx2.header.lastUpdatedAt.getTime()).toBe(Date.parse("2026-01-01T00:00:09.000Z"));

    // 续扫结果 == 整文件重扫结果
    const fresh = await buildSessionIndex(p, { fileMtimeMs: 0, projectId: "proj", sessionId: "sid" });
    expect(idx2.lineOffsets).toEqual(fresh.lineOffsets);
    expect(idx2.byteLength).toBe(fresh.byteLength);
    expect(idx2.header).toEqual(fresh.header);
  });

  it("续扫能补齐『上次的半截尾行』(旧 EOF 现处于行中)", async () => {
    // 初始文件末尾没有 \n:最后一行是半截行,被排除
    const p = write("grow.jsonl", "a\nb");
    const idx1 = await getSessionIndex(p, { fileMtimeMs: 0 });
    expect(idx1.lineCount).toBe(1); // 只有 "a"
    expect(idx1.byteLength).toBe(2); // "a\n" 之后

    // 追加 "\nc\n" → 文件变成 "a\nb\nc\n","b" 现在补全
    appendFileSync(p, "\nc\n", "utf8");
    const idx2 = await getSessionIndex(p, { fileMtimeMs: 0 });
    expect(getSessionIndexCacheStats().extends).toBe(1);
    expect(idx2.lineOffsets).toEqual([0, 2, 4]); // a, b, c
    expect(await readLineRange(p, idx2, 0, 3)).toEqual(["a", "b", "c"]);
  });

  it("完全未变(size 与 mtime 都不变)→ 直接返回缓存,不重建/不续扫", async () => {
    const p = write("same.jsonl", userLine("2026-01-01T00:00:01.000Z", "x") + "\n");
    const a = await getSessionIndex(p, { fileMtimeMs: 0 });
    const b = await getSessionIndex(p, { fileMtimeMs: 0 });
    expect(b).toBe(a); // 同一缓存对象
    expect(getSessionIndexCacheStats().fullBuilds).toBe(1);
    expect(getSessionIndexCacheStats().extends).toBe(0);
  });

  it("truncate:size 缩小 → 整文件重建(不返回陈旧头部)", async () => {
    const big =
      [
        userLine("2026-01-01T00:00:01.000Z", "第一条 old"),
        asstLine("2026-01-01T00:00:02.000Z", "a"),
        eventLine("2026-01-01T00:00:03.000Z"),
      ].join("\n") + "\n";
    const p = write("shrink.jsonl", big);
    const idx1 = await getSessionIndex(p, { fileMtimeMs: 0 });
    expect(idx1.header.messageCount).toBe(3);

    // 截断为更短内容
    const small = userLine("2026-01-01T00:00:07.000Z", "第一条 new") + "\n";
    writeFileSync(p, small, "utf8");
    const idx2 = await getSessionIndex(p, { fileMtimeMs: 0 });

    expect(getSessionIndexCacheStats().fullBuilds).toBe(2); // 重建
    expect(getSessionIndexCacheStats().extends).toBe(0);
    expect(idx2.header.messageCount).toBe(1);
    expect(idx2.header.firstUserText).toBe("第一条 new");
    expect(idx2.header.lastUpdatedAt.getTime()).toBe(Date.parse("2026-01-01T00:00:07.000Z"));
  });

  it("同 size 改写但 mtime 变 → 整文件重建(不返回陈旧头部)", async () => {
    // 两份内容字节长度相同(仅用户文本 AAAA/BBBB 差异,等长)
    const x = userLine("2026-01-01T00:00:01.000Z", "AAAA") + "\n";
    const y = userLine("2026-01-01T00:00:01.000Z", "BBBB") + "\n";
    expect(Buffer.byteLength(x)).toBe(Buffer.byteLength(y));

    const p = write("rewrite.jsonl", x);
    const idx1 = await getSessionIndex(p, { fileMtimeMs: 0 });
    expect(idx1.header.firstUserText).toBe("AAAA");
    const m0 = statSync(p).mtimeMs;

    // 同 size 改写 + 强制 mtime 明显变化
    writeFileSync(p, y, "utf8");
    const newTime = new Date(m0 + 10_000);
    utimesSync(p, newTime, newTime);

    const idx2 = await getSessionIndex(p, { fileMtimeMs: 0 });
    expect(getSessionIndexCacheStats().fullBuilds).toBe(2); // 重建
    expect(idx2.header.firstUserText).toBe("BBBB"); // 不是陈旧的 AAAA
  });

  it("in-flight 去重:同一文件两个并发调用只构建一次", async () => {
    const p = write("dedup.jsonl", userLine("2026-01-01T00:00:01.000Z", "x") + "\n");
    resetSessionIndexCache();
    const [a, b] = await Promise.all([
      getSessionIndex(p, { fileMtimeMs: 0 }),
      getSessionIndex(p, { fileMtimeMs: 0 }),
    ]);
    expect(getSessionIndexCacheStats().fullBuilds).toBe(1); // 只构建一次
    expect(a).toBe(b); // 共享同一结果
  });
});
