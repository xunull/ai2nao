import BetterSqlite from "better-sqlite3";
import type { Database } from "better-sqlite3";
import {
  ChatSession,
  ChatSessionSummary,
  Message,
  SearchResult,
  SearchSnippet,
} from "../cursorHistory/types.js";

/**
 * Cherry Studio 2.0.14 起,对话存在 `Data/cherrystudio.sqlite`(Drizzle 管的单库)。
 * 在此之前它散在 IndexedDB 的 leveldb 与 `Data/agents.db` 里,那两处自迁移当天起
 * 一个字节都不再写 —— 本仓库不再读它们,见 docs/adr/0003-cherry-studio-sqlite.md。
 *
 * ## 这个库的几个形状
 *
 * **消息是棵树。** `message.parent_id` 串起来,每个 topic 有一条 `role='root'` 的
 * 树根(无正文),`topic.active_node_id` 指向当前激活的叶子。重新生成会在同一个
 * parent 下挂第二个子节点,靠 `siblings_group_id` 分组。所以取正文要**从激活叶子
 * 沿 parent 回溯**,不能按 `created_at` 平铺 —— 平铺会把重生成前后的两个回答都列出来,
 * 看起来像模型说了两遍。(真库当前 0 个分支,两种取法输出一致。)
 *
 * **正文在 `data` 的 parts 数组里**,AI SDK 形状:`text` / `reasoning` /
 * `dynamic-tool` / `data-error`。`content` 只收 `text`,`reasoning` 单独进
 * `thinking` —— 与 Cherry 自己的口径一致:它的 `searchable_text` 长度正好等于
 * text 部分之和,不含思考过程。
 *
 * **`message_fts` 是 FTS5 trigram。** 中文能子串匹配,但**三个字起**:
 * 实测「如何查看」17 条、「哪些端口」2 条、「端口」0 条。不足三字回退 LIKE。
 */

export const CHERRY_STUDIO_MIN_VERSION = "2.0.14";

/** trigram 的硬下限。少于这个长度 MATCH 恒空,要走 LIKE。 */
const FTS_MIN_QUERY_CHARS = 3;

export function openCherryStudioDb(dbPath: string): Database {
  return new BetterSqlite(dbPath, { readonly: true, fileMustExist: true });
}

type TopicRow = {
  id: string;
  name: string;
  assistant_name: string | null;
  active_node_id: string | null;
  created_at: number;
  last_activity_at: number;
  message_count: number;
  preview: string | null;
};

type MessageRow = {
  id: string;
  parent_id: string | null;
  role: string;
  data: string;
  searchable_text: string;
  created_at: number;
  model_name: string | null;
};

/** parts 数组 → 可见正文与思考过程。两者分开,搜索口径只认前者。 */
export function partsOf(dataJson: string): { text: string; thinking: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataJson);
  } catch {
    return { text: "", thinking: "" };
  }
  const parts = (parsed as { parts?: unknown })?.parts;
  if (!Array.isArray(parts)) return { text: "", thinking: "" };
  const text: string[] = [];
  const thinking: string[] = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const { type, text: value, data } = p as { type?: unknown; text?: unknown; data?: unknown };
    // data-error 的值不在 `.text` 而在 `.data.message`,真库里是「Request was aborted」——
    // 用户点了停止。留下它,否则那场对话里会出现「连问两次、中间没有回答」的断层。
    // 措辞照抄 Cherry 自己的:它把同一句话填进了 searchable_text。
    if (type === "data-error") {
      const message = (data as { message?: unknown } | undefined)?.message;
      if (typeof message === "string" && message) text.push(message);
      continue;
    }
    if (typeof value !== "string" || !value) continue;
    if (type === "text") text.push(value);
    else if (type === "reasoning") thinking.push(value);
    // dynamic-tool 不入正文 —— 那是工具调用的载荷,不是模型说的话
  }
  return { text: text.join("\n"), thinking: thinking.join("\n") };
}

/**
 * 从激活叶子回溯到根,返回**时序**的消息 id。
 *
 * 防环:Cherry 不该产生环,但这是外部程序写的库,一个坏 parent 指针就能让这里
 * 死循环。见过的节点直接停,好过挂住整个请求。
 */
export function activePath(
  byId: Map<string, MessageRow>,
  activeNodeId: string | null
): MessageRow[] {
  const path: MessageRow[] = [];
  const seen = new Set<string>();
  let cursor = activeNodeId;
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const row = byId.get(cursor);
    if (!row) break;
    path.push(row);
    cursor = row.parent_id;
  }
  return path.reverse();
}

const TOPIC_COLUMNS = `
  t.id,
  t.name,
  a.name AS assistant_name,
  t.active_node_id,
  t.created_at,
  t.last_activity_at,
  (SELECT COUNT(*) FROM message m
    WHERE m.topic_id = t.id AND m.deleted_at IS NULL AND m.role <> 'root') AS message_count,
  (SELECT m.searchable_text FROM message m
    WHERE m.topic_id = t.id AND m.deleted_at IS NULL AND m.role = 'user'
    ORDER BY m.created_at LIMIT 1) AS preview
`;

function toSummary(row: TopicRow, index: number): ChatSessionSummary {
  return {
    id: row.id,
    index,
    title: row.name.trim() || null,
    createdAt: new Date(row.created_at),
    lastUpdatedAt: new Date(row.last_activity_at),
    messageCount: row.message_count,
    workspaceId: row.id,
    // Cherry 的对话没有工作目录概念,助手名是它唯一的归类维度。
    workspacePath: row.assistant_name ?? "",
    preview: (row.preview ?? "").slice(0, 200),
    source: "cherry-studio",
    metadata: { assistant: row.assistant_name },
  };
}

export function listTopics(db: Database): ChatSessionSummary[] {
  const rows = db
    .prepare(
      `SELECT ${TOPIC_COLUMNS}
       FROM topic t
       LEFT JOIN assistant a ON a.id = t.assistant_id
       WHERE t.deleted_at IS NULL
       ORDER BY t.last_activity_at DESC, t.id`
    )
    .all() as TopicRow[];
  return rows.map((r, i) => toSummary(r, i + 1));
}

export function countTopics(db: Database): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM topic WHERE deleted_at IS NULL`)
    .get() as { n: number };
  return row.n;
}

export function loadTopic(db: Database, topicId: string): ChatSession | null {
  const topic = db
    .prepare(
      `SELECT ${TOPIC_COLUMNS}
       FROM topic t
       LEFT JOIN assistant a ON a.id = t.assistant_id
       WHERE t.id = ? AND t.deleted_at IS NULL`
    )
    .get(topicId) as TopicRow | undefined;
  if (!topic) return null;

  const rows = db
    .prepare(
      `SELECT m.id, m.parent_id, m.role, m.data, m.searchable_text, m.created_at,
              um.name AS model_name
       FROM message m
       LEFT JOIN user_model um ON um.id = m.model_id
       WHERE m.topic_id = ? AND m.deleted_at IS NULL`
    )
    .all(topicId) as MessageRow[];

  const byId = new Map(rows.map((r) => [r.id, r]));
  const path = activePath(byId, topic.active_node_id);
  const messages: Message[] = [];
  for (const row of path) {
    if (row.role === "root") continue; // 树根,没有正文
    const { text, thinking } = partsOf(row.data);
    if (!text && !thinking) continue;
    messages.push({
      id: row.id,
      role: row.role === "assistant" ? "assistant" : "user",
      content: text,
      timestamp: new Date(row.created_at),
      codeBlocks: [],
      thinking: thinking || undefined,
      model: row.model_name ?? undefined,
    });
  }

  const summary = toSummary(topic, 1);
  return {
    id: summary.id,
    index: summary.index,
    title: summary.title,
    createdAt: summary.createdAt,
    lastUpdatedAt: summary.lastUpdatedAt,
    messageCount: messages.length,
    messages,
    workspaceId: summary.workspaceId,
    workspacePath: summary.workspacePath,
    source: "cherry-studio",
    metadata: summary.metadata,
  };
}

/**
 * FTS 的查询串。trigram 只做子串匹配,所以把整个查询当一个短语,
 * 双引号内的 `"` 按 FTS5 规矩转义成 `""`。不拆词 —— 拆了中文就散了。
 */
export function ftsQuery(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

/** 中文两字词(「端口」「压缩」)在 trigram 下恒空,这类查询必须走 LIKE。 */
export function usesFts(query: string): boolean {
  return [...query].length >= FTS_MIN_QUERY_CHARS;
}

type HitRow = { topic_id: string; role: string; searchable_text: string };

export function searchMessages(
  db: Database,
  query: string,
  opts: { limit: number; contextChars: number }
): SearchResult[] {
  const q = query.trim();
  if (!q) return [];

  // 两条路径取的是同一批列,只是命中判据不同:FTS 走倒排,LIKE 全表扫。
  // 真库 2184 行,LIKE 是亚毫秒级 —— 回退不是降级,只是对短查询更诚实。
  const rows = usesFts(q)
    ? (db
        .prepare(
          `SELECT m.topic_id, m.role, m.searchable_text
           FROM message_fts f
           JOIN message m ON m.fts_rowid = f.rowid
           WHERE f.message_fts MATCH ? AND m.deleted_at IS NULL AND m.role <> 'root'
           ORDER BY m.created_at DESC`
        )
        .all(ftsQuery(q)) as HitRow[])
    : (db
        .prepare(
          `SELECT m.topic_id, m.role, m.searchable_text
           FROM message m
           WHERE m.deleted_at IS NULL AND m.role <> 'root'
             AND m.searchable_text LIKE ? ESCAPE '\\'
           ORDER BY m.created_at DESC`
        )
        .all(`%${q.replace(/[\\%_]/g, "\\$&")}%`) as HitRow[]);

  const summaries = new Map(listTopics(db).map((s) => [s.id, s]));
  const lower = q.toLowerCase();
  const byTopic = new Map<string, SearchSnippet[]>();

  for (const row of rows) {
    const snippets = byTopic.get(row.topic_id) ?? [];
    if (snippets.length >= 3) continue; // 与旧实现一致:每场最多 3 条
    const idx = row.searchable_text.toLowerCase().indexOf(lower);
    if (idx < 0) continue; // FTS 命中的是 trigram,再用原串确认一次位置
    const text = snippetAround(row.searchable_text, idx, q.length, opts.contextChars);
    // 偏移相对**截取后**的文本算。旧实现给的是原串里的绝对偏移,配上截取又压缩过
    // 空白的 text,指到的是别处 —— 没人发现是因为前端压根没用这个字段。
    const at = text.toLowerCase().indexOf(lower);
    snippets.push({
      messageRole: row.role === "assistant" ? "assistant" : "user",
      text,
      matchPositions: at >= 0 ? [[at, at + q.length]] : [],
    });
    byTopic.set(row.topic_id, snippets);
  }

  const results: SearchResult[] = [];
  for (const [topicId, snippets] of byTopic) {
    const summary = summaries.get(topicId);
    if (!summary || snippets.length === 0) continue;
    results.push({
      sessionId: topicId,
      index: summary.index,
      workspacePath: summary.workspacePath,
      createdAt: summary.createdAt,
      matchCount: snippets.length,
      snippets,
    });
    if (results.length >= opts.limit) break;
  }
  return results;
}

/**
 * 命中处前后各截一段。`matchPositions` 是相对**截取后**文本的偏移 ——
 * 前端按它高亮,与旧实现同一个契约。
 */
function snippetAround(
  text: string,
  index: number,
  matchLength: number,
  contextChars: number
): string {
  const start = Math.max(0, index - contextChars);
  const end = Math.min(text.length, index + matchLength + contextChars);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}
