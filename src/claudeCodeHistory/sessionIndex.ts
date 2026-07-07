import { open, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { MAX_JSONL_BYTES, MAX_JSONL_LINES } from "./constants.js";
import { ClaudeTranscriptTooLargeError } from "./load.js";
import { cleanClaudeUserMessage } from "./myMessages.js";

/**
 * 大 Claude transcript 分页的地基(T1a):对一个 `.jsonl` 会话文件做「一次流式扫描」,
 * 同时产出两样东西,后续分页时都不用再整文件重读:
 *   1. 每一条「完整行」(以 `\n` 结尾)的字节偏移 `lineOffsets`,分页游标据此 seek。
 *   2. 详情页头部需要的聚合 `header`(条数/时间范围/首条用户文本/告警),边扫边折叠,
 *      解析完每行就丢弃记录,绝不把全部 record 攒成数组——内存有界。
 *
 * header 的取值口径与 {@link buildClaudeSession} 完全对齐(见下方各字段注释),这样
 * 「流式头部」和「整文件解析后的头部」永远一致。
 */

/** 详情页头部所需的聚合字段(全部在同一次流式扫描里算出)。 */
export type SessionHeader = {
  /**
   * 展示口径的消息条数 = 可解析(JSON 根为对象)的行数。对齐 buildClaudeSession:
   * 那里每一条 okLine 恰好产出一条 message(user / assistant / 其它折叠为 appendix),
   * 所以 messageCount === okLines.length。空行与解析失败行都不计入。
   */
  messageCount: number;
  /** = min(timestamp) 覆盖所有 ok 行;全无有效时间戳时回退到 fileMtime。对齐 `tMin ?? new Date(fileMtimeMs)`。 */
  createdAt: Date;
  /** = max(timestamp) 覆盖所有 ok 行;全无有效时间戳时回退到 fileMtime。对齐 `tMax ?? new Date(fileMtimeMs)`。 */
  lastUpdatedAt: Date;
  /** 首条非空用户消息的可见文本(已 trim);无则 null。 */
  /** 首条**有意义**的用户文本(已过 cleanClaudeUserMessage:命令→`/名 参数`、样板→跳过)。 */
  firstUserText: string | null;
  /** 标题:firstUserText 截断到 120 字符 + `…`;无用户消息时为「(无用户消息)」。 */
  title: string;
  /** 预览:firstUserText 截断到 100 字符 + `…`;无用户消息时为「(无用户消息)」。 */
  preview: string;
  /**
   * 工作区路径 = 首个非空 `cwd` 回退值 || projectId。未传 projectId 时退化为 cwd(可能为 "")。
   * 对齐 `cwdFallback || projectId`。
   */
  workspacePath: string;
  /**
   * 告警,顺序对齐 buildClaudeSession:
   *   [0] `${n} JSONL line(s) failed to parse`(有解析错误时)
   *   [1] `multiple distinct sessionId values in file (${size})`(sessionId 多于 1 个)
   *   [2] `sessionId mismatch: file name ${sessionId} vs payload ${only}`(唯一 sessionId 且与传入不符)
   * 说明:cwd 回退不产生告警(只影响 workspacePath),与 buildClaudeSession 一致。
   * mismatch 告警需要 opts.sessionId;未提供时跳过该项。
   */
  warnings: string[];
};

/**
 * 会话索引:分页游标(lineOffsets/lineCount/byteLength)+ 头部聚合(header)。
 * - `lineOffsets[i]`:第 i 条「完整行」(以 `\n` 结尾)起始的字节偏移。包含空行与坏行
 *   的物理行(游标按物理行 seek);末尾没有 `\n` 的半截行被排除(codex#9)。
 * - `lineCount` = lineOffsets.length(物理完整行数)。
 * - `byteLength` = 最后一条完整行结尾(即最后一个 `\n` 之后)的字节偏移;文件增长时从这里续扫。
 */
export type SessionIndex = {
  lineOffsets: number[];
  lineCount: number;
  byteLength: number;
  header: SessionHeader;
};

/** buildSessionIndex / getSessionIndex 的可选项。projectId/sessionId 仅用于让 header 与 buildClaudeSession 完全对齐。 */
export type SessionIndexOpts = {
  /** 时间戳全缺失时头部时间的回退基准;不传则 stat 取 mtimeMs。 */
  fileMtimeMs?: number;
  /** 用于 workspacePath 回退(cwdFallback || projectId)。 */
  projectId?: string;
  /** 用于 sessionId mismatch 告警;不传则跳过该告警项。 */
  sessionId?: string;
};

/**
 * 流式扫描的内部累加器——只保留聚合,绝不保留全部记录(内存有界)。文件增长做增量续扫时,
 * 会在这份累加器基础上继续折叠新行,得到与「整文件重扫」完全一致的结果(各字段均为
 * 加法 / min / max / 集合并 / 保序取首,与顺序无关或按文件顺序保序)。
 */
type HeaderAcc = {
  okCount: number;
  errorCount: number;
  tMinMs: number | null;
  tMaxMs: number | null;
  sessionIds: Set<string>;
  cwdFallback: string;
  firstUserText: string | null;
  fileMtimeMs: number;
};

// ── 与 normalize.ts 语义完全一致的小工具(normalize.ts 未导出,故此处复刻) ──

/** 对齐 normalize.ts 的 isoDate,返回毫秒时间戳;非字符串或非法日期 → null。 */
function isoDateMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

/** 对齐 normalize.ts 的 recordType。 */
function recordType(rec: Record<string, unknown>): string | undefined {
  const t = rec.type;
  return typeof t === "string" ? t : undefined;
}

/** 对齐 normalize.ts 的 userVisibleFromContent:string 原样;数组取 text 块 join("\n\n")。 */
function userVisibleFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n\n");
}

/** 对齐 normalize.ts 的 isUserShape。 */
function isUserShape(rec: Record<string, unknown>): boolean {
  if (recordType(rec) !== "user") return false;
  const msg = rec.message;
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return false;
  return (msg as Record<string, unknown>).role === "user";
}

function newAcc(fileMtimeMs: number): HeaderAcc {
  return {
    okCount: 0,
    errorCount: 0,
    tMinMs: null,
    tMaxMs: null,
    sessionIds: new Set<string>(),
    cwdFallback: "",
    firstUserText: null,
    fileMtimeMs,
  };
}

function cloneAcc(a: HeaderAcc): HeaderAcc {
  return { ...a, sessionIds: new Set(a.sessionIds) };
}

/**
 * 把单条「完整行」的原始文本折叠进累加器。offset 早在调用前已 push(空行/坏行也保留物理偏移),
 * 这里只负责聚合口径:空行跳过(既不计 ok 也不计 error,对齐 parseJsonlText);
 * JSON.parse 失败或根非对象 → errorCount++;成功对象 → okCount++ 并折叠时间/sessionId/cwd/首用户文本。
 */
function foldLine(raw: string, acc: HeaderAcc): void {
  if (raw.trim() === "") return; // 空行:物理偏移已记,但不计入 ok/error(对齐 parseJsonlText)
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    acc.errorCount++; // 解析失败 → 记一条 error(对齐 parseJsonlText)
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    acc.errorCount++; // 根不是对象 → error："JSON root must be an object"
    return;
  }
  const rec = parsed as Record<string, unknown>;
  acc.okCount++;
  // 时间范围:对每条 ok 行(不分 user/assistant/其它)都参与 min/max,对齐 buildClaudeSession 的 bumpTime。
  const ts = isoDateMs(rec.timestamp);
  if (ts != null) {
    if (acc.tMinMs == null || ts < acc.tMinMs) acc.tMinMs = ts;
    if (acc.tMaxMs == null || ts > acc.tMaxMs) acc.tMaxMs = ts;
  }
  const sid = rec.sessionId;
  if (typeof sid === "string") acc.sessionIds.add(sid);
  const cwd = rec.cwd;
  if (typeof cwd === "string" && cwd && !acc.cwdFallback) acc.cwdFallback = cwd; // 首个非空 cwd
  if (!acc.firstUserText && isUserShape(rec)) {
    const msg = rec.message as Record<string, unknown>;
    const body = userVisibleFromContent(msg.content);
    // 首条**有意义**的用户文本:走后端权威清洗(cleanClaudeUserMessage,versioned +
    // parity 测试)。命令注入回显 → 紧凑 `/名 参数`;skill 正文 / caveat / 压缩摘要等
    // 机器注入 → 清成空则跳过、继续找下一条。标题/预览由此派生,不再裸露 XML 标签/SGR 残骸。
    const cleaned = cleanClaudeUserMessage(body).trim();
    if (cleaned) acc.firstUserText = cleaned;
  }
}

/** 从累加器派生最终 header(纯函数;增量续扫后重新派生,结果与整文件重扫一致)。 */
function deriveHeader(acc: HeaderAcc, opts?: SessionIndexOpts): SessionHeader {
  const warnings: string[] = [];
  if (acc.errorCount > 0) {
    warnings.push(`${acc.errorCount} JSONL line(s) failed to parse`);
  }
  if (acc.sessionIds.size > 1) {
    warnings.push(`multiple distinct sessionId values in file (${acc.sessionIds.size})`);
  } else if (acc.sessionIds.size === 1 && opts?.sessionId != null) {
    const [only] = [...acc.sessionIds];
    if (only !== opts.sessionId) {
      warnings.push(`sessionId mismatch: file name ${opts.sessionId} vs payload ${only}`);
    }
  }

  const firstUserText = acc.firstUserText;
  const title = firstUserText
    ? firstUserText.length > 120
      ? `${firstUserText.slice(0, 120)}…`
      : firstUserText
    : "(无用户消息)";
  const preview = firstUserText
    ? firstUserText.length > 100
      ? `${firstUserText.slice(0, 100)}…`
      : firstUserText
    : "(无用户消息)";

  const workspacePath = acc.cwdFallback || (opts?.projectId ?? "");

  return {
    messageCount: acc.okCount,
    createdAt: new Date(acc.tMinMs ?? acc.fileMtimeMs),
    lastUpdatedAt: new Date(acc.tMaxMs ?? acc.fileMtimeMs),
    firstUserText,
    title,
    preview,
    workspacePath,
    warnings,
  };
}

/**
 * 从 `startOffset` 起流式扫描到 EOF:逐字节找 `\n`,对每条完整行 push 起始偏移并 foldLine。
 * 跨 chunk 的半行字节暂存在 `partials`(避免把整文件读进内存,也避免在多字节 UTF-8 中间切断)。
 * 返回 `byteLength`(最后一条完整行结尾偏移;末尾半截行被排除)与 `totalSize`(文件总字节)。
 */
async function scanFrom(
  filePath: string,
  startOffset: number,
  acc: HeaderAcc,
  lineOffsets: number[]
): Promise<{ byteLength: number; totalSize: number }> {
  const fh = await open(filePath, "r");
  try {
    const CHUNK = 1 << 16; // 64KB
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = startOffset; // 全局读位置
    let lineStart = startOffset; // 当前在读行的起始偏移
    let partials: Buffer[] = []; // 当前行在本 chunk 之前累积的字节
    while (true) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (bytesRead === 0) break;
      let searchStart = 0;
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0x0a) {
          // 命中 \n:得到一条完整行 [lineStart, 本 \n)
          const content =
            partials.length === 0
              ? buf.toString("utf8", searchStart, i)
              : Buffer.concat([...partials, buf.subarray(searchStart, i)]).toString("utf8");
          partials = [];
          lineOffsets.push(lineStart);
          if (lineOffsets.length > MAX_JSONL_LINES) {
            throw new ClaudeTranscriptTooLargeError(
              `transcript exceeds ${MAX_JSONL_LINES} lines; raise the limit or split the file`
            );
          }
          foldLine(content, acc);
          lineStart = pos + i + 1; // 下一行从 \n 之后开始
          searchStart = i + 1;
        }
      }
      // 本 chunk 中最后一个 \n 之后的残余属于当前(未完成)行,拷贝入 partials(buf 会被复用)
      if (searchStart < bytesRead) {
        partials.push(Buffer.from(buf.subarray(searchStart, bytesRead)));
      }
      pos += bytesRead;
    }
    // pos 现在 = 文件总字节;lineStart = 最后一条完整行结尾(半截尾行被排除)
    return { byteLength: lineStart, totalSize: pos };
  } finally {
    await fh.close();
  }
}

/** 全量新建:从 0 开始扫全文件。 */
async function buildFresh(
  filePath: string,
  fileMtimeMs: number,
  opts?: SessionIndexOpts
): Promise<{ index: SessionIndex; acc: HeaderAcc; totalSize: number }> {
  fullBuildCount++;
  const acc = newAcc(fileMtimeMs);
  const lineOffsets: number[] = [];
  const { byteLength, totalSize } = await scanFrom(filePath, 0, acc, lineOffsets);
  const header = deriveHeader(acc, opts);
  return {
    index: { lineOffsets, lineCount: lineOffsets.length, byteLength, header },
    acc,
    totalSize,
  };
}

/**
 * 增量续扫:文件增长时,从旧的 `prev.index.byteLength`(上次最后一条完整行结尾)开始续扫。
 * 这样即使「上次的半截尾行现在已补全」也会被正确重扫并计入(codex#9);旧偏移原样保留、不重算。
 */
async function extendFrom(
  filePath: string,
  prev: CacheEntry,
  opts?: SessionIndexOpts
): Promise<{ index: SessionIndex; acc: HeaderAcc; totalSize: number }> {
  extendCount++;
  const acc = cloneAcc(prev.acc); // 克隆:成功前不污染缓存里的旧累加器
  const lineOffsets = prev.index.lineOffsets.slice(); // 复制旧偏移后追加
  const { byteLength, totalSize } = await scanFrom(
    filePath,
    prev.index.byteLength,
    acc,
    lineOffsets
  );
  const header = deriveHeader(acc, opts);
  return {
    index: { lineOffsets, lineCount: lineOffsets.length, byteLength, header },
    acc,
    totalSize,
  };
}

/**
 * 直接构建一个会话索引(不走缓存)。会 stat 文件并按 MAX_JSONL_BYTES 卡上限;
 * 行数上限 MAX_JSONL_LINES 在扫描过程中即时触发。
 */
export async function buildSessionIndex(
  filePath: string,
  opts?: SessionIndexOpts
): Promise<SessionIndex> {
  const st = await stat(filePath);
  guardSize(st);
  const fileMtimeMs = opts?.fileMtimeMs ?? st.mtimeMs;
  const { index } = await buildFresh(filePath, fileMtimeMs, opts);
  return index;
}

function guardSize(st: Stats): void {
  if (st.size > MAX_JSONL_BYTES) {
    throw new ClaudeTranscriptTooLargeError(
      `transcript exceeds ${MAX_JSONL_BYTES} bytes; open in Claude Code or raise the limit`
    );
  }
}

/**
 * 从指定字节位置读取若干「物理行」的原始文本切片(不整文件重读)。
 * 半开区间 [startLine, endLine):seek 到 `lineOffsets[startLine]`,读到 `lineOffsets[endLine]`
 * (或 endLine 越界时读到 `byteLength`)。切片必然以某个 `\n` 结尾,故 split 后丢弃末尾空串。
 * 每条记录 → 消息的映射是 T1b 的事,这里只高效返回该范围内的原始行字符串。
 */
export async function readLineRange(
  filePath: string,
  index: SessionIndex,
  startLine: number,
  endLine: number
): Promise<string[]> {
  const n = index.lineCount;
  const s = Math.max(0, Math.min(startLine, n));
  const e = Math.max(s, Math.min(endLine, n));
  if (s >= n || e <= s) return [];
  const startByte = index.lineOffsets[s];
  const endByte = e < n ? index.lineOffsets[e] : index.byteLength;
  const length = endByte - startByte;
  if (length <= 0) return [];

  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(length);
    let readTotal = 0;
    while (readTotal < length) {
      const { bytesRead } = await fh.read(buf, readTotal, length - readTotal, startByte + readTotal);
      if (bytesRead === 0) break;
      readTotal += bytesRead;
    }
    const text = buf.subarray(0, readTotal).toString("utf8");
    const parts = text.split("\n");
    // 切片以 \n 结尾 → split 末尾多一个空串,丢弃(区间内本身的空行会被保留)
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    return parts;
  } finally {
    await fh.close();
  }
}

// ─────────────────────────── 缓存(模块级) ───────────────────────────

/** 缓存条目:公开索引 + 内部累加器(增量续扫用)+ 用于校验的 size/mtime。 */
type CacheEntry = {
  index: SessionIndex;
  acc: HeaderAcc;
  size: number;
  mtimeMs: number;
};

/** LRU:按 Map 插入顺序,读命中/写入时移到末尾,超限从头部淘汰最旧。 */
const MAX_CACHE_ENTRIES = 32;
/** 所有条目 lineOffsets 长度之和的上限(≈ 8 个 MAX_JSONL_LINES 文件),偏移数组占内存的粗略护栏。 */
const MAX_CACHE_OFFSETS = 4_000_000;

const cache = new Map<string, CacheEntry>();
/** 并发去重(codex#11):同一文件的并发请求共享同一次构建 Promise,避免重复扫 100MB。 */
const inflight = new Map<string, Promise<SessionIndex>>();

// 测试可观测计数(也便于 resetSessionIndexCache 在用例间隔离)。
let fullBuildCount = 0;
let extendCount = 0;

function touch(filePath: string): void {
  const e = cache.get(filePath);
  if (!e) return;
  cache.delete(filePath);
  cache.set(filePath, e);
}

function evictIfNeeded(): void {
  while (cache.size > MAX_CACHE_ENTRIES || totalOffsets() > MAX_CACHE_OFFSETS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function totalOffsets(): number {
  let sum = 0;
  for (const e of cache.values()) sum += e.index.lineOffsets.length;
  return sum;
}

function storeEntry(
  filePath: string,
  r: { index: SessionIndex; acc: HeaderAcc },
  st: Stats
): void {
  cache.delete(filePath);
  cache.set(filePath, { index: r.index, acc: r.acc, size: st.size, mtimeMs: st.mtimeMs });
  evictIfNeeded();
}

/**
 * 缓存版:命中即返回,否则构建。有效性规则:
 *   - size 不变 且 mtime 不变            → 直接返回缓存;
 *   - size 增长                          → 从旧 EOF 增量续扫(不整文件重建);
 *   - size 缩小,或 size 相同但 mtime 变 → 整文件重建(截断/改写/轮转,codex#10)。
 * 并发去重:同一文件在途的构建只跑一次(codex#11)。
 */
export async function getSessionIndex(
  filePath: string,
  opts?: SessionIndexOpts
): Promise<SessionIndex> {
  const existing = inflight.get(filePath);
  if (existing) return existing;

  const p = (async (): Promise<SessionIndex> => {
    const st = await stat(filePath);
    guardSize(st);
    const cached = cache.get(filePath);
    if (cached) {
      if (cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
        touch(filePath);
        return cached.index; // 完全未变
      }
      if (st.size > cached.size) {
        const r = await extendFrom(filePath, cached, opts); // 增长 → 续扫
        storeEntry(filePath, r, st);
        return r.index;
      }
      // 缩小 或 (同 size 异 mtime) → 落到下面整文件重建
    }
    const fileMtimeMs = opts?.fileMtimeMs ?? st.mtimeMs;
    const r = await buildFresh(filePath, fileMtimeMs, opts);
    storeEntry(filePath, r, st);
    return r.index;
  })();

  inflight.set(filePath, p);
  try {
    return await p;
  } finally {
    inflight.delete(filePath);
  }
}

/** 清空缓存与在途表并归零计数——用例隔离用。 */
export function resetSessionIndexCache(): void {
  cache.clear();
  inflight.clear();
  fullBuildCount = 0;
  extendCount = 0;
}

/** 观测缓存/构建统计——测试用于断言「增量续扫而非重建」「并发只构建一次」。 */
export function getSessionIndexCacheStats(): {
  entries: number;
  fullBuilds: number;
  extends: number;
} {
  return { entries: cache.size, fullBuilds: fullBuildCount, extends: extendCount };
}
