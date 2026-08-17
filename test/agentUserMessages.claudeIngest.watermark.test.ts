import Database from "better-sqlite3";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/store/migrations.js";
import { ingestClaudeUserMessages } from "../src/agentUserMessages/claudeIngest.js";
import { getSyncState } from "../src/agentUserMessages/store.js";

/**
 * 水位钳制:两处静默永久丢失的回归测试。
 *
 * 缺陷长这样 —— 水位是「已处理干净的时间点」,而两处 `catch { continue }` 会跳过文件
 * 却让**同批其它文件**把水位推过去。下一轮 `mtimeMs >= watermark` 就把被跳过的东西
 * 永久排除了,并且一声不吭(sync_state 照写 success)。
 *
 * 构造失败必须用 `chmod 0000` 而**不是** 0400:实测 0400 下 stat 和 readFile 都不抛
 * (readAndParseFile 第一行的 stat 只要父目录的 x 权限),测试会恒绿 —— 那正是它要防的
 * 失败模式。0000 才让 readFile 抛 EACCES。
 */
describe("claudeIngest 水位钳制", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        // 先恢复权限,否则删不掉。
        chmodSync(join(d, "projects", "-p-a", "bad.jsonl"), 0o600);
      } catch {
        /* 该用例没造这个文件 */
      }
      rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  /** 造一个 projects 根,里面按 (会话名, mtime 秒, 内容) 铺文件。 */
  const makeRoot = (
    specs: { project: string; session: string; mtimeSec: number; body: string }[]
  ) => {
    const root = mkdtempSync(join(tmpdir(), "aum-wm-"));
    dirs.push(root);
    const projects = join(root, "projects");
    for (const s of specs) {
      const dir = join(projects, s.project);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${s.session}.jsonl`);
      writeFileSync(file, s.body);
      utimesSync(file, s.mtimeSec, s.mtimeSec);
    }
    return { root, projects };
  };

  /** 一条最小的合法 user 记录。 */
  const line = (uuid: string, text: string, ts: string) =>
    JSON.stringify({
      uuid,
      type: "user",
      timestamp: ts,
      message: { role: "user", content: [{ type: "text", text }] },
    }) + "\n";

  const fresh = () => {
    const db = new Database(":memory:");
    migrate(db);
    return db;
  };

  it("解析失败的文件:水位钳在它之前,下轮仍会重试", async () => {
    const { projects } = makeRoot([
      // 早的坏文件(不可读) + 晚的好文件。升序处理时坏的在前。
      { project: "-p-a", session: "bad", mtimeSec: 1_000_000, body: line("u1", "x", "2026-01-01T00:00:00Z") },
      { project: "-p-b", session: "good", mtimeSec: 2_000_000, body: line("u2", "能读到的提问", "2026-01-02T00:00:00Z") },
    ]);
    chmodSync(join(projects, "-p-a", "bad.jsonl"), 0o000);

    const db = fresh();
    const r1 = await ingestClaudeUserMessages(db, { projectsRoot: projects });

    // 好文件照常入库。
    expect(r1.upserted).toBeGreaterThan(0);
    // 但整轮被标成 partial,而不是以前那样无条件 success。
    expect(r1.status).toBe("partial");
    expect(r1.error).toMatch(/解析失败/);

    // 关键:水位没有越过坏文件的 mtime。
    const st = getSyncState(db, "claude");
    expect(st!.watermarkMs).toBeLessThan(1_000_000 * 1000);
    expect(st!.lastStatus).toBe("partial");

    // 下一轮它仍在待扫范围里(修好权限后能被读到)。
    chmodSync(join(projects, "-p-a", "bad.jsonl"), 0o600);
    const r2 = await ingestClaudeUserMessages(db, { projectsRoot: projects });
    expect(r2.status).toBe("success");
    const rows = db
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_user_messages WHERE source_session_id LIKE '%bad'"
      )
      .get() as { n: number };
    expect(rows.n).toBeGreaterThan(0);
    db.close();
  });

  it("全部文件可读时水位正常推进(钳制不误伤)", async () => {
    const { projects } = makeRoot([
      { project: "-p-a", session: "s1", mtimeSec: 1_000_000, body: line("u1", "第一个提问", "2026-01-01T00:00:00Z") },
      { project: "-p-b", session: "s2", mtimeSec: 2_000_000, body: line("u2", "第二个提问", "2026-01-02T00:00:00Z") },
    ]);
    const db = fresh();
    const r = await ingestClaudeUserMessages(db, { projectsRoot: projects });
    expect(r.status).toBe("success");
    const st = getSyncState(db, "claude");
    // 推到最晚那个文件的 mtime。
    expect(st!.watermarkMs).toBe(2_000_000 * 1000);
    expect(st!.lastStatus).toBe("success");
    expect(st!.lastError).toBeNull();
    db.close();
  });

  it("project 目录列举失败:整轮不推水位(那些文件没有 mtime 可钳)", async () => {
    const { projects } = makeRoot([
      { project: "-p-ok", session: "s1", mtimeSec: 2_000_000, body: line("u1", "可读目录里的提问", "2026-01-01T00:00:00Z") },
    ]);
    // 造一个读不进去的 project 目录。
    const locked = join(projects, "-p-locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "hidden.jsonl"), line("u9", "藏起来的提问", "2026-01-03T00:00:00Z"));
    chmodSync(locked, 0o000);

    const db = fresh();
    const r = await ingestClaudeUserMessages(db, { projectsRoot: projects });

    // 可读目录的内容照常入库……
    expect(r.upserted).toBeGreaterThan(0);
    // ……但水位一步都不推,否则 -p-locked 下的历史会被永久排除。
    expect(r.status).toBe("partial");
    expect(r.error).toMatch(/目录列举失败/);
    const st = getSyncState(db, "claude");
    expect(st!.watermarkMs).toBe(0);

    chmodSync(locked, 0o700);
    // 恢复后能拿到那个目录的内容(水位没跑过头)。
    const r2 = await ingestClaudeUserMessages(db, { projectsRoot: projects });
    expect(r2.status).toBe("success");
    const n = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_user_messages WHERE source_session_id LIKE '%hidden'"
        )
        .get() as { n: number }
    ).n;
    expect(n).toBeGreaterThan(0);
    db.close();
  });

  it("chmod 语义 pin:0400 不抛、0000 才抛 —— 换回 0400 会让上面的测试恒绿", async () => {
    const { projects } = makeRoot([
      { project: "-p-a", session: "s1", mtimeSec: 1_000_000, body: line("u1", "提问", "2026-01-01T00:00:00Z") },
    ]);
    const file = join(projects, "-p-a", "s1.jsonl");

    chmodSync(file, 0o400);
    const db1 = fresh();
    const readable = await ingestClaudeUserMessages(db1, { projectsRoot: projects });
    expect(readable.status).toBe("success"); // 0400 完全可读
    db1.close();

    chmodSync(file, 0o000);
    const db2 = fresh();
    const blocked = await ingestClaudeUserMessages(db2, { projectsRoot: projects });
    expect(blocked.status).toBe("partial"); // 0000 才触发 EACCES
    db2.close();

    chmodSync(file, 0o600);
  });
});
