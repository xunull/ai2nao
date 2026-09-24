/**
 * Cherry Studio → agent_user_messages 摄取(v1)。
 *
 * **全量重扫,不用水位。** 真库 1558 条非 root 消息 / 626 个 topic,一轮全扫是毫秒级;
 * 而水位是这个仓库翻过车的地方(opencode 的「筛选时钟 ≠ 推进时钟」永久丢过
 * 550/1934 条)。`watermarkMs` 仍然写(记本轮最大时间戳),但**不参与过滤** ——
 * 只作可观测性。与 hermesIngest 同一个取舍。
 *
 * 口径与 `/cherry-studio-history` 详情页**逐字一致**(两边都走 `partsOf`):
 * 搜索命中之后跳过去,高亮的位置才对得上。实测 `partsOf` 与 Cherry 自己算的
 * `searchable_text` 在 1557/1558 条上完全相同,差的那一条只是两个 text part 之间的
 * 空白 —— 不值得为它引入第二套口径。
 *
 * 不入库的三类:
 *  - `role='root'`:每个 topic 一条的树根,没有正文(626 条)
 *  - `reasoning`:思考过程(531 段),与 kimi 的 think 同口径,只进 payload
 *  - `dynamic-tool`:工具调用载荷,不是模型说的话
 *
 * 取的是**激活路径**(topic.active_node_id 沿 parent 回溯),不是全部消息 ——
 * 重新生成过的回答只算当前那条,否则同一个问题会入库两个答案。见
 * docs/adr/0003-cherry-studio-sqlite.md。
 */
import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import {
  listTopics,
  loadTopic,
  openCherryStudioDb,
} from "../cherryStudioHistory/db.js";
import {
  cherryStudioDbPath,
  resolveCherryStudioRoot,
} from "../cherryStudioHistory/paths.js";
import { getSyncState, setSyncState, upsertUserMessagesBatch } from "./store.js";
import type { UpsertUserMessageInput } from "./types.js";

/**
 * 清洗口径版本。改「收哪些行 / cleaned_text 取哪一层 / payload 存什么」时 +1。
 *
 * 1 = 首版。取激活路径上的 user + assistant;cleaned_text 走 partsOf 的 text
 *     (含 data-error 的 message);reasoning 只进 payload;root 丢弃。
 */
export const CHERRY_CLEANER_VERSION = 1;
export const CHERRY_PARSER_VERSION = 1;

/** 每 N 条一事务。1558 条量级下只有几批,留着是为了以后长大不用改结构。 */
const BATCH_ROWS = 500;

export type CherryIngestResult = {
  status: "success" | "skipped" | "failed";
  scannedTopics: number;
  upserted: number;
  watermarkMs: number;
  error?: string;
};

export function ingestCherryUserMessages(
  db: Database.Database,
  opts: { cherryRoot?: string; now?: Date } = {}
): CherryIngestResult {
  const nowIso = (opts.now ?? new Date()).toISOString();
  const prior = getSyncState(db, "cherry");
  const dbPath = cherryStudioDbPath(resolveCherryStudioRoot(opts.cherryRoot));

  // 没装 Cherry Studio(或还是 2.0.14 之前的版本)= 干净跳过,不是故障。
  if (!existsSync(dbPath)) {
    setSyncState(db, "cherry", {
      watermarkMs: prior?.watermarkMs ?? 0,
      lastRunAt: nowIso,
      lastStatus: "skipped",
      lastError: null,
      ingestVersion: prior?.ingestVersion ?? 0,
    });
    return { status: "skipped", scannedTopics: 0, upserted: 0, watermarkMs: prior?.watermarkMs ?? 0 };
  }

  let src: Database.Database;
  try {
    src = openCherryStudioDb(dbPath);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    setSyncState(db, "cherry", {
      watermarkMs: prior?.watermarkMs ?? 0,
      lastRunAt: nowIso,
      lastStatus: "failed",
      lastError: error,
      ingestVersion: prior?.ingestVersion ?? 0,
    });
    return {
      status: "failed",
      scannedTopics: 0,
      upserted: 0,
      watermarkMs: prior?.watermarkMs ?? 0,
      error,
    };
  }

  let scanned = 0;
  let upserted = 0;
  let maxTs = 0;

  try {
    let pending: UpsertUserMessageInput[] = [];
    const flush = () => {
      if (pending.length === 0) return;
      upserted += upsertUserMessagesBatch(db, pending, nowIso);
      pending = [];
    };

    for (const summary of listTopics(src)) {
      scanned++;
      const session = loadTopic(src, summary.id);
      if (!session) continue;
      for (const row of buildRowsForTopic(session, dbPath)) {
        const ms = new Date(row.eventAtUtc).getTime();
        if (Number.isFinite(ms) && ms > maxTs) maxTs = ms;
        pending.push(row);
      }
      if (pending.length >= BATCH_ROWS) flush();
    }
    flush();

    setSyncState(db, "cherry", {
      watermarkMs: maxTs,
      lastRunAt: nowIso,
      lastStatus: "success",
      lastError: null,
      ingestVersion: CHERRY_CLEANER_VERSION,
    });
    return { status: "success", scannedTopics: scanned, upserted, watermarkMs: maxTs };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    setSyncState(db, "cherry", {
      watermarkMs: prior?.watermarkMs ?? 0,
      lastRunAt: nowIso,
      lastStatus: "failed",
      lastError: error,
      ingestVersion: prior?.ingestVersion ?? 0,
    });
    return {
      status: "failed",
      scannedTopics: scanned,
      upserted,
      watermarkMs: prior?.watermarkMs ?? 0,
      error,
    };
  } finally {
    src.close();
  }
}

type LoadedSession = NonNullable<ReturnType<typeof loadTopic>>;

/** 把一场会话折成待写入的行。导出供测试直接喂造好的会话。 */
export function buildRowsForTopic(
  session: LoadedSession,
  sourcePath: string
): UpsertUserMessageInput[] {
  const assistant = String(
    (session.metadata as { assistant?: unknown } | undefined)?.assistant ?? ""
  );
  const out: UpsertUserMessageInput[] = [];
  let lastUserKey: string | null = null;

  for (const m of session.messages) {
    const key = m.id ?? "";
    if (!key) continue; // 没有稳定 id 的行不入库,好过造一个会漂的键
    const isHuman = m.role === "user";
    if (isHuman) lastUserKey = key;
    out.push({
      source: "cherry",
      sourceSessionId: session.id,
      sourceMessageKey: key,
      // Cherry 的对话没有工作目录概念,恒为 null —— 不发明伪 project_key 去污染
      // 按项目组织的聚合页(与 hermes 同一条原则)。助手名是它唯一的归类维度,
      // 扔掉就再也拿不回来,所以存进 payload。
      project: null,
      eventAtUtc: m.timestamp.toISOString(),
      rawText: m.content,
      rawPayloadJson: JSON.stringify({
        id: key,
        role: m.role,
        assistant: assistant || null,
        model: m.model ?? null,
        // 思考过程只进这里 —— 进 cleaned_text 就是让搜索搜到模型的草稿。
        reasoning: m.thinking ?? null,
      }),
      cleanedText: m.content,
      isHuman,
      cleanerVersion: CHERRY_CLEANER_VERSION,
      parserVersion: CHERRY_PARSER_VERSION,
      sourcePath,
      role: isHuman ? "user" : "assistant",
      answeringUserKey: isHuman ? null : lastUserKey,
    });
  }
  return out;
}
