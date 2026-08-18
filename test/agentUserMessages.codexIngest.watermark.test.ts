import Database from "better-sqlite3";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestCodexUserMessages } from "../src/agentUserMessages/codexIngest.js";
import { getSyncState } from "../src/agentUserMessages/store.js";
import { migrate } from "../src/store/migrations.js";

/**
 * codexIngest 的水位钳制。
 *
 * `7de68d1` 给 claudeIngest 修过一模一样的缺陷,当时**没有同步到这里** ——
 * 这个测试就是那次漏改的回归网。缺陷长这样:单文件解析失败 → `catch { continue }`
 * → 批内后面一个成功的文件把 batchMaxMs 推过去 → 下一轮 `mtimeMs >= watermark`
 * 把被跳过的文件永久排除,而 sync_state 照写 success,整条链上没有任何地方会响。
 *
 * 构造失败用 `chmod 0000` 而**不是** 0400:实测 0400 下 stat 不抛(只需要父目录的
 * x 权限),测试会恒绿 —— 那正是它要防的失败模式。
 */
describe("codexIngest 水位钳制", () => {
  const dirs: string[] = [];
  const badFiles: string[] = [];
  afterEach(() => {
    for (const f of badFiles) {
      try { chmodSync(f, 0o600); } catch { /* 该用例没造 */ }
    }
    badFiles.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  /** codex 的布局:<root>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl */
  const makeRoot = (specs: { uuid: string; mtimeSec: number; body: string }[]) => {
    const root = mkdtempSync(join(tmpdir(), "aum-codex-wm-"));
    dirs.push(root);
    const day = join(root, "sessions", "2026", "08", "18");
    mkdirSync(day, { recursive: true });
    const paths: Record<string, string> = {};
    for (const s of specs) {
      const p = join(day, `rollout-2026-08-18T00-00-00-${s.uuid}.jsonl`);
      writeFileSync(p, s.body);
      utimesSync(p, s.mtimeSec, s.mtimeSec);
      paths[s.uuid] = p;
    }
    return { root, paths };
  };

  /**
   * 一个最小的合法 codex rollout。真人消息必须走 `event_msg` / `user_message` ——
   * codex 把同一条消息同时写进 event_msg 和 response_item,后者是副本
   * (readingHidden='duplicate'),抽取侧只认前者。用 response_item 造夹具会得到 0 行。
   */
  const body = (text: string) =>
    JSON.stringify({
      timestamp: "2026-08-18T00:00:00.000Z",
      type: "session_meta",
      payload: { id: "s", timestamp: "2026-08-18T00:00:00.000Z", cwd: "/tmp/p", originator: "codex_cli" },
    }) + "\n" +
    JSON.stringify({
      timestamp: "2026-08-18T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: text },
    }) + "\n";

  const fresh = () => {
    const db = new Database(":memory:");
    migrate(db);
    return db;
  };

  it("坏文件被跳过时,水位不得越过它", async () => {
    // 坏文件 mtime 更早,好文件更晚 —— 不钳的话好文件会把水位推过坏文件。
    const { root, paths } = makeRoot([
      { uuid: "019dd7aa-c50c-7182-a0c6-000000000001", mtimeSec: 1000, body: body("坏文件里的提问") },
      { uuid: "019dd7aa-c50c-7182-a0c6-000000000002", mtimeSec: 2000, body: body("好文件里的提问") },
    ]);
    const bad = paths["019dd7aa-c50c-7182-a0c6-000000000001"];
    badFiles.push(bad);
    chmodSync(bad, 0o000);

    const db = fresh();
    const r = await ingestCodexUserMessages(db, { codexRoot: root });

    // 缺陷状态下这里是 2000000(好文件的 mtime),坏文件从此再也不会被扫。
    expect(r.watermarkMs).toBeLessThan(2000 * 1000);
    expect(getSyncState(db, "codex")!.watermarkMs).toBeLessThan(2000 * 1000);
    db.close();
  });

  it("有跳过时状态是 partial 而不是 success —— 缺陷最难发现的地方就是它一直报 success", async () => {
    const { root, paths } = makeRoot([
      { uuid: "019dd7aa-c50c-7182-a0c6-000000000003", mtimeSec: 1000, body: body("坏") },
      { uuid: "019dd7aa-c50c-7182-a0c6-000000000004", mtimeSec: 2000, body: body("好") },
    ]);
    const bad = paths["019dd7aa-c50c-7182-a0c6-000000000003"];
    badFiles.push(bad);
    chmodSync(bad, 0o000);

    const db = fresh();
    const r = await ingestCodexUserMessages(db, { codexRoot: root });
    expect(r.status).toBe("partial");
    const st = getSyncState(db, "codex")!;
    expect(st.lastStatus).toBe("partial");
    expect(st.lastError).toMatch(/水位钳在/);
    db.close();
  });

  it("下一轮仍然会重扫那个被跳过的文件(权限恢复后能补回来)", async () => {
    const { root, paths } = makeRoot([
      { uuid: "019dd7aa-c50c-7182-a0c6-000000000005", mtimeSec: 1000, body: body("先失败后成功的提问") },
      { uuid: "019dd7aa-c50c-7182-a0c6-000000000006", mtimeSec: 2000, body: body("一直正常的提问") },
    ]);
    const bad = paths["019dd7aa-c50c-7182-a0c6-000000000005"];
    badFiles.push(bad);
    chmodSync(bad, 0o000);

    const db = fresh();
    await ingestCodexUserMessages(db, { codexRoot: root });
    const n1 = (db.prepare("SELECT COUNT(*) n FROM agent_user_messages WHERE source='codex'").get() as { n: number }).n;

    chmodSync(bad, 0o600); // 修好权限
    const r2 = await ingestCodexUserMessages(db, { codexRoot: root });
    const n2 = (db.prepare("SELECT COUNT(*) n FROM agent_user_messages WHERE source='codex'").get() as { n: number }).n;

    // 缺陷状态下 n2 === n1(那条提问永久丢了),且 r2 会报 success 装作没事。
    expect(n2).toBeGreaterThan(n1);
    expect(r2.status).toBe("success");
    db.close();
  });

it("「文件太大」是确定性拒绝:不钳水位(重扫也没用),但要在 lastError 里可见", async () => {
    // 造一个超过 MAX_CODEX_JSONL_BYTES 的文件。它不会因为重扫而变小,
    // 钳水位只会让整条管子永久卡在它之前 —— 实测真机上就是这样:24 个超限文件
    // 把水位钉在 2026-05-04,每小时白扫 319 个文件。
    const big = "x".repeat(70 * 1024 * 1024);
    const { root } = makeRoot([
      { uuid: "019dd7aa-c50c-7182-a0c6-000000000009", mtimeSec: 1000, body: big },
      { uuid: "019dd7aa-c50c-7182-a0c6-00000000000a", mtimeSec: 2000, body: body("正常的提问") },
    ]);
    const db = fresh();
    const r = await ingestCodexUserMessages(db, { codexRoot: root });

    // 水位正常推到最新 —— 没有被那个永远不会变小的文件钉住
    expect(r.watermarkMs).toBe(2000 * 1000);
    // 但它必须是可见的,不能退回静默
    expect(getSyncState(db, "codex")!.lastError).toMatch(/超过.*字节上限/);
    db.close();
  });

  it("全都正常时不受影响:水位正常推进,状态是 success", async () => {
    const { root } = makeRoot([
      { uuid: "019dd7aa-c50c-7182-a0c6-000000000007", mtimeSec: 1000, body: body("提问一") },
      { uuid: "019dd7aa-c50c-7182-a0c6-000000000008", mtimeSec: 2000, body: body("提问二") },
    ]);
    const db = fresh();
    const r = await ingestCodexUserMessages(db, { codexRoot: root });
    expect(r.status).toBe("success");
    expect(r.watermarkMs).toBe(2000 * 1000);
    expect(getSyncState(db, "codex")!.lastError).toBeNull();
    db.close();
  });
});
