import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Message } from "@ag-ui/client";
import { putBlob, sniffImageMime } from "../blobStore.js";
// 跨目录 import cost 在 llmChat 里早有先例(`config.ts` 与 `providerRoutes.ts` 都引
// `../cost/modelCatalog.js`);moduleLayering 测试只管 llmChat 内部三个模块的方向。
import { priceFor, type PriceMap } from "../cost/pricing.js";
import {
  readCachedCatalog,
  type ModelTieredPrice,
  type TierRate,
} from "../cost/modelCatalog.js";

const MAX_MESSAGES = 200;
const MAX_SYNC_RAW_BYTES = 1_500_000;
/**
 * 协议原文留在行里的上限,超过就移进 blob,行里只留 sha 引用。
 *
 * **不是沿用 `MAX_SYNC_RAW_BYTES`。** 设计文档写的是「单行 `raw_json.length` 上限」,
 * 但仓库里从来没有过单行上限 —— `MAX_SYNC_RAW_BYTES` 的两个使用点都是把整批
 * `raw_json.length` **求和**后抛 413。所以这里新引入一个 per-message 阈值,
 * 让那道整批闸继续当外层兜底,两者分工不同,不互相冒充。
 *
 * 取 64K 字符的理由:协议原文是纯回传数据,不参与展示,留在行里没有任何好处;
 * 而绝大多数回答远小于这个数,不会让每条短消息都平白产生一个 blob 文件。
 */
const MAX_INLINE_PROTOCOL_CHARS = 64_000;
const PREVIEW_LEN = 140;
const AG_UI_ROLES = new Set([
  "developer",
  "system",
  "user",
  "assistant",
  "tool",
  "activity",
  "reasoning",
]);

export type LlmChatSessionSummary = {
  id: string;
  title: string;
  protocol?: string;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  message_count: number;
  /**
   * 会话累计花费。**读取时从 `metadata_json` 解析出来**,不是表里的一列。
   *
   * 为什么不把 `metadata_json` 原样透出:那样前端每次都要自己 `JSON.parse`,
   * 而类型上它只是个 `string` —— 等于把解析责任推出去、类型还不说实话。
   * 代价是这个类型不再与表列一一对应,不过它本来就有 `protocol?` 这种可选项。
   *
   * 旧会话没有这个键 → `undefined`,界面按「还没算过」处理,不是「花了 0 元」。
   */
  usage?: SessionUsageTotals;
};

/** 写进 `metadata_json` 的累计。与 `UsageTotals` 同形,单独命名是因为它要跨进程存活。 */
export type SessionUsageTotals = {
  costUsd: number;
  /** 存在 partial / unknown / unpriced / pending 时为 true,界面加 `≥`。 */
  atLeast: boolean;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** 重算这份累计时的时间戳,用于对账时判断新鲜度。 */
  updatedAt: string;
};

export type LlmChatMessageRow = {
  id: string;
  session_id: string;
  message_id: string;
  message_index: number;
  role: "developer" | "system" | "user" | "assistant" | "tool" | "activity" | "reasoning";
  raw_json: string;
  plain_text: string;
  preview: string;
  status: string | null;
  created_at: string;
  updated_at: string;
};

export type LlmChatSessionDetail = LlmChatSessionSummary & {
  messages: LlmChatMessageRow[];
};

export type PersistLlmChatMessagesInput = {
  title?: unknown;
  messages: Message[];
};

export class LlmChatSessionError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// 轮级占位行:跨进程互斥、执行权令牌、重复提交判定
// ---------------------------------------------------------------------------

/**
 * 服务端专有行的 message_id 前缀。客户端产生的 id 是 uuid,不会撞上;
 * 可信边界那一侧也会拒绝客户端写入带这个前缀的消息。
 */
const SERVER_ONLY_MESSAGE_PREFIX = "ai2nao:";

/**
 * 占位行的 message_index 保留区。
 *
 * `llm_chat_messages` 上有 `UNIQUE(session_id, message_index)`,而
 * `replaceLlmChatSessionMessages` 会把普通消息重排成 0..n-1(中间还要先把
 * 全部行取负腾挪)。占位行放进一个远离该区间的高位段:既不参与重排,
 * 也不可能与普通消息、或与上一轮的占位行撞号。
 */
const RUN_ROW_INDEX_BASE = 1_000_000;

/** 租约时长。进行中每 15 秒续期一次,60 秒留了 4 倍余量。 */
const RUN_LEASE_MS = 60_000;

/**
 * 心跳间隔。导出是为了让调用方的续期节奏与上面的租约时长绑在一处 ——
 * 两边各写各的数字,迟早会调一个忘一个。
 */
export const RUN_LEASE_RENEW_MS = 15_000;

/** 本进程实例 id。桌面版与开发版同时跑时,用它区分「这一轮是谁持有的」。 */
const INSTANCE_ID = randomUUID();

export type ChatRunStatus = "running" | "completed" | "failed" | "aborted";

export type ChatRun = {
  v: 1;
  runId: string;
  /** 递增令牌。租约只是心跳,这个才是执行权 —— 每占住一次 +1。 */
  fence: number;
  ownerInstanceId: string;
  leaseUntil: string;
  status: ChatRunStatus;
  userMessageId: string | null;
  startedAt: string;
  endedAt: string | null;
};

export type ClaimChatRunResult =
  | { ok: true; run: ChatRun }
  | { ok: false; reason: "running" }
  | { ok: false; reason: "duplicate"; runId: string };

export function isServerOnlyMessageId(messageId: string): boolean {
  return messageId.startsWith(SERVER_ONLY_MESSAGE_PREFIX);
}

function runRowMessageId(runId: string): string {
  return `${SERVER_ONLY_MESSAGE_PREFIX}run:${runId}`;
}

function parseChatRun(rawJson: string): ChatRun | null {
  try {
    const parsed = JSON.parse(rawJson) as { content?: unknown };
    const content = parsed?.content;
    if (typeof content === "string") return JSON.parse(content) as ChatRun;
    if (content && typeof content === "object") return content as ChatRun;
  } catch {
    return null;
  }
  return null;
}

/** 按 fence 从大到小。走 `(session_id, role)` 索引,不扫全表。 */
function readChatRuns(db: Database.Database, sessionId: string): ChatRun[] {
  const rows = db
    .prepare(
      `SELECT raw_json FROM llm_chat_messages
       WHERE session_id = ? AND role = 'activity' AND message_id LIKE ?
       ORDER BY message_index DESC`
    )
    .all(sessionId, `${SERVER_ONLY_MESSAGE_PREFIX}run:%`) as { raw_json: string }[];
  return rows
    .map((r) => parseChatRun(r.raw_json))
    .filter((r): r is ChatRun => r !== null && typeof r.fence === "number");
}

function writeChatRunRow(
  db: Database.Database,
  sessionId: string,
  run: ChatRun,
  now: string
): void {
  const messageId = runRowMessageId(run.runId);
  db.prepare(
    `INSERT INTO llm_chat_messages (
       id, session_id, message_id, message_index, role, raw_json,
       plain_text, preview, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'activity', ?, '', '[activity]', ?, ?, ?)
     ON CONFLICT(session_id, message_id) DO UPDATE SET
       raw_json = excluded.raw_json,
       status = excluded.status,
       updated_at = excluded.updated_at`
  ).run(
    `${sessionId}:${messageId}`,
    sessionId,
    messageId,
    RUN_ROW_INDEX_BASE + run.fence,
    JSON.stringify({
      id: messageId,
      role: "activity",
      activityType: "ai2nao.run",
      content: JSON.stringify(run),
    }),
    run.status,
    now,
    now
  );
}

/**
 * 「检查并占住」收在**一个 IMMEDIATE 写事务**里。
 *
 * 旧做法是进程内的一个 Set(`runningThreadIds`),桌面版与开发版同时跑同一个
 * 会话时完全挡不住;而「先查再写」如果不在同一个写事务里,本身也会被插队。
 * IMMEDIATE 让 SQLite 立刻拿到写锁,两个进程只会有一个赢。
 */
export function claimChatRun(
  db: Database.Database,
  sessionId: string,
  userMessageId: string | null
): ClaimChatRunResult {
  return db.transaction((): ClaimChatRunResult => {
    const runs = readChatRuns(db, sessionId);
    const nowMs = Date.now();

    const latest = runs[0];
    if (latest && latest.status === "running" && Date.parse(latest.leaseUntil) > nowMs) {
      return { ok: false, reason: "running" };
    }
    // **租约已过期的 running:持有者崩了,或者休眠了。** 规格:它名下 pending 的账在下次
    // 加载时变为 aborted。不做的话这一轮永远是 running、那几笔永远是 pending,左栏的 `≥`
    // 再也摘不掉。原持有者醒来若拿到用量,`finishChatCall` 的补写路径(canBackfill)
    // 正是为这一步准备的 —— 它只认「已被别人标成 aborted」的账。
    // 放在占位这个 IMMEDIATE 事务里:只有真正要接管的那一方才动它,判定与改写不可分。
    if (latest && latest.status === "running") {
      const nowIso = new Date(nowMs).toISOString();
      writeChatRunRow(db, sessionId, { ...latest, status: "aborted", endedAt: nowIso }, nowIso);
      settlePendingChatCalls(db, sessionId, latest.runId, "aborted");
    }

    // 重复提交按**轮级**判定,不看请求级的账目 —— 一次失败的尝试、或一次只做了
    // 压缩的运行,都满足「有终态记录」,用那个判会把没答完的轮次误判成已完成。
    if (userMessageId) {
      const done = runs.find(
        (r) => r.userMessageId === userMessageId && r.status === "completed"
      );
      if (done) return { ok: false, reason: "duplicate", runId: done.runId };
    }

    const fence = runs.reduce((max, r) => Math.max(max, r.fence), 0) + 1;
    const nowIso = new Date(nowMs).toISOString();
    const run: ChatRun = {
      v: 1,
      runId: randomUUID(),
      fence,
      ownerInstanceId: INSTANCE_ID,
      leaseUntil: new Date(nowMs + RUN_LEASE_MS).toISOString(),
      status: "running",
      userMessageId,
      startedAt: nowIso,
      endedAt: null,
    };
    writeChatRunRow(db, sessionId, run, nowIso);
    return { ok: true, run };
  }).immediate();
}

/**
 * 执行权校验:本会话最新占位行的 fence 是否还是自己的。
 *
 * 租约过期被别的进程接管后,原进程醒来仍会想继续写消息、发请求、跑工具 ——
 * 每一步之前都要过这道校验,不符就立刻停。
 */
export function isChatRunCurrent(
  db: Database.Database,
  sessionId: string,
  fence: number
): boolean {
  const latest = readChatRuns(db, sessionId)[0];
  return latest ? latest.fence === fence : false;
}

/** 进行中续期。只续自己的、且仍在 running 的那一行。 */
export function renewChatRunLease(
  db: Database.Database,
  sessionId: string,
  runId: string
): void {
  db.transaction(() => {
    const run = readChatRuns(db, sessionId).find((r) => r.runId === runId);
    if (!run || run.status !== "running") return;
    const now = Date.now();
    writeChatRunRow(
      db,
      sessionId,
      { ...run, leaseUntil: new Date(now + RUN_LEASE_MS).toISOString() },
      new Date(now).toISOString()
    );
  }).immediate();
}

/** 落终态。**终态不可回退** —— 迟到的事件改不动已经结束的那一轮。 */
export function completeChatRun(
  db: Database.Database,
  sessionId: string,
  runId: string,
  status: Exclude<ChatRunStatus, "running">
): void {
  db.transaction(() => {
    const run = readChatRuns(db, sessionId).find((r) => r.runId === runId);
    if (!run || run.status !== "running") return;
    const now = new Date().toISOString();
    writeChatRunRow(db, sessionId, { ...run, status, endedAt: now }, now);
  }).immediate();
}

/**
 * 把某一轮名下仍是 pending 的账一并落终态,用量一律记「不知道」。
 *
 * 两个调用方:同进程这一轮收尾时的兜底(中间件没结算到的 —— 流被取消、上游半路断开),
 * 以及占位时接管一轮租约已过期的运行。**终态不回退**的规则由 `finishChatCall` 保证,
 * 已结算的账不会被这里改动。返回处理了几笔,供测试与日志用。
 */
export function settlePendingChatCalls(
  db: Database.Database,
  sessionId: string,
  runId: string,
  status: "failed" | "aborted"
): number {
  const pending = readChatCalls(db, sessionId).filter(
    (c) => c.runId === runId && c.status === "pending"
  );
  for (const c of pending) finishChatCall(db, sessionId, c.callId, status, null);
  return pending.length;
}

export function listChatRuns(db: Database.Database, sessionId: string): ChatRun[] {
  return readChatRuns(db, sessionId);
}

// ---------------------------------------------------------------------------
// 请求账目:**一次模型 HTTP 请求一笔**
// ---------------------------------------------------------------------------

/**
 * 账目行的 message_index 保留区,与占位行(1_000_000 段)分开。
 * 两类服务端行都在普通消息之上,但必须各占一段 ——
 * `UNIQUE(session_id, message_index)` 不允许撞号。
 */
const CALL_ROW_INDEX_BASE = 2_000_000;

/**
 * 本次请求**实际发送内容**的指纹。用途是判断「上一笔账能不能当作这次的估算基准」——
 * 前缀一致才可比。
 *
 * `prefixHash` 按顺序对 `(messageId, transformTag)` 求哈希,**两样都要**:
 * 只对 id 求,工具结果省略状态变化、历史图移出窗口、思考回传方式改变都不会让
 * 哈希变,于是拿一个内容早已不同的旧账当基准,估算静默偏掉。
 */
export type SendView = {
  /** 发送的消息条数。产出为空而被跳过的消息**不计入**。 */
  count: number;
  prefixHash: string;
  /** system 参数(含摘要)的哈希。 */
  systemHash: string;
  /** 工具定义的哈希。 */
  toolsHash: string;
};

export type ChatCallPurpose = "answer" | "finalize" | "compact";
export type ChatCallStatus = "pending" | "completed" | "failed" | "aborted";

/**
 * 计价状态。**按优先级从上到下判定,命中即停** —— 顺序本身就是语义,
 * 反过来判会把「没价格」误报成「缺分桶」。
 *
 * - `pending`  还没结算。**不计入合计。**
 * - `unknown`  input 与 output 都为 null,界面显示「—」。
 * - `unpriced` 没有该模型的价格:token 照计,费用为 null,显示「未定价」。
 * - `partial`  有价格但必需项不全,`costUsd` 是**真下限**,界面要加 `≥`。
 * - `priced`   必需项齐全。
 */
export type ChatCallCostState = "pending" | "unknown" | "unpriced" | "partial" | "priced";

/** 分桶与既有 token 口径一致:reasoning 是 output 的子集,不另计。 */
export type ChatCallUsage = {
  input: number | null;
  noCache: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
};

export type ChatCall = {
  v: 1;
  callId: string;
  runId: string;
  /** 写这笔账时持有的执行权令牌,用于对账「这笔是谁记的」。 */
  fence: number;
  purpose: ChatCallPurpose;
  stepIndex: number;
  /** 第几次 HTTP 尝试。SDK 不告诉中间件重试序号,由中间件自己数。 */
  attempt: number;
  status: ChatCallStatus;
  ownerInstanceId: string;
  /** 不 import LlmChatModelSnapshot —— sessions.ts 的依赖受 moduleLayering 测试约束。 */
  model: { modelId: string; provider: string; model: string; label: string } | null;
  usage: ChatCallUsage | null;
  /**
   * 本次发送内容的指纹。**可选,因为这两个键是后加的** —— 在此之前落的账目行里
   * 根本没有它们,类型写成必填就是对库里的数据撒谎,读取侧会以为一定拿得到。
   *
   * 写入侧的强制放在 `AccountingContext` 上(那边必填),由编译器逼着每个中间件
   * 构造点都提供。「可选字段没人传、tsc 不报、测试照样绿」这个坑,
   * 本仓库在 `onCallCompleted` 上已经踩过一次。
   */
  sendView?: SendView;
  /** 传给 `streamText` 的输出预留。与预算算出来的是同一个值,不另取。 */
  maxOutputTokens?: number;
  /**
   * 计价当时的单价快照。**趋势页与会话累计一律用账目里存的 `costUsd`,不按新价重算** ——
   * 价格会变,而已经发生的花费不会。`tier` 给分段价留位,本片先恒为 null。
   */
  price: { input: number; output: number; cacheRead: number; cacheWrite: number; tier: string | null } | null;
  costUsd: number | null;
  costState: ChatCallCostState;
  startedAt: string;
  endedAt: string | null;
};

function callRowMessageId(callId: string): string {
  return `${SERVER_ONLY_MESSAGE_PREFIX}call:${callId}`;
}

function parseChatCall(rawJson: string): ChatCall | null {
  try {
    const parsed = JSON.parse(rawJson) as { content?: unknown };
    const content = parsed?.content;
    if (typeof content === "string") return JSON.parse(content) as ChatCall;
    if (content && typeof content === "object") return content as ChatCall;
  } catch {
    return null;
  }
  return null;
}

function readChatCalls(db: Database.Database, sessionId: string): ChatCall[] {
  const rows = db
    .prepare(
      `SELECT raw_json FROM llm_chat_messages
       WHERE session_id = ? AND role = 'activity' AND message_id LIKE ?
       ORDER BY message_index ASC`
    )
    .all(sessionId, `${SERVER_ONLY_MESSAGE_PREFIX}call:%`) as { raw_json: string }[];
  return rows
    .map((r) => parseChatCall(r.raw_json))
    .filter((c): c is ChatCall => c !== null && typeof c.callId === "string");
}

function writeChatCallRow(
  db: Database.Database,
  sessionId: string,
  call: ChatCall,
  now: string,
  index: number
): void {
  const messageId = callRowMessageId(call.callId);
  db.prepare(
    `INSERT INTO llm_chat_messages (
       id, session_id, message_id, message_index, role, raw_json,
       plain_text, preview, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'activity', ?, '', '[activity]', ?, ?, ?)
     ON CONFLICT(session_id, message_id) DO UPDATE SET
       raw_json = excluded.raw_json,
       status = excluded.status,
       updated_at = excluded.updated_at`
  ).run(
    `${sessionId}:${messageId}`,
    sessionId,
    messageId,
    index,
    JSON.stringify({
      id: messageId,
      role: "activity",
      activityType: "ai2nao.call",
      content: JSON.stringify(call),
    }),
    call.status,
    now,
    now
  );
}

/**
 * 请求**发出之前**落一笔待定账。
 *
 * 首包之前的 HTTP 错误、中止、进程崩溃,都因为这一行而留下痕迹 ——
 * 等拿到响应再记账,恰恰漏掉的就是这几种最需要记录的情况。
 */
export function insertPendingChatCall(
  db: Database.Database,
  sessionId: string,
  call: Omit<
    ChatCall,
    | "v"
    | "status"
    | "ownerInstanceId"
    | "usage"
    // `price` 与 `costUsd` / `costState` 同类:请求刚发出时还没有用量,
    // 调用方无从知晓,由本函数填 null。不该让它去编一个值。
    | "price"
    | "costUsd"
    | "costState"
    | "startedAt"
    | "endedAt"
  >
): ChatCall {
  return db.transaction(() => {
    const now = new Date().toISOString();
    const row: ChatCall = {
      ...call,
      v: 1,
      status: "pending",
      ownerInstanceId: INSTANCE_ID,
      usage: null,
      // 请求刚发出,还没有用量也就谈不上计价 —— 这是五档里的第 1 档。
      price: null,
      costUsd: null,
      costState: "pending",
      startedAt: now,
      endedAt: null,
    };
    const index = CALL_ROW_INDEX_BASE + readChatCalls(db, sessionId).length;
    writeChatCallRow(db, sessionId, row, now, index);
    // 同事务更新累计。**pending 这一笔不产生费用,但会让 `atLeast` 变 true** ——
    // 所以这里也要更新,否则「正在跑的那一轮」在左栏是不带 `≥` 的,看着像已经算准了。
    writeSessionUsageTotals(db, sessionId, now);
    return row;
  }).immediate();
}

/**
 * 落终态并写用量。**终态不可回退,只有一个例外。**
 *
 * 例外是:这台机器合盖导致租约过期、这笔账被别人标成 `aborted`,而厂商的用量
 * 在唤醒后才报回来。那时状态保持 `aborted` 不动,只把用量补上 —— 钱确实花了,
 * 账上不能是「—」。补写只认原持有者,别的进程不许碰。
 */
export function finishChatCall(
  db: Database.Database,
  sessionId: string,
  callId: string,
  status: Exclude<ChatCallStatus, "pending">,
  usage: ChatCallUsage | null,
  /**
   * 可选:传了才计价,不传退化成原来的「只记 pending/unknown」。
   *
   * 做成可选是为了让「没接上」这件事在测试里看得见 —— 必填的话 tsc 会逼所有
   * 调用点传值,反而掩盖了"忘了接"这种缺口(今天已经有两次这样的教训)。
   */
  priceMap?: PriceMap
): void {
  db.transaction(() => {
    const calls = readChatCalls(db, sessionId);
    const index = calls.findIndex((c) => c.callId === callId);
    if (index < 0) return;
    const call = calls[index]!;
    const now = new Date().toISOString();

    if (call.status === "pending") {
      const nextUsage = usage ?? call.usage;
      const priced = priceMap
        ? priceChatCall(nextUsage, call.model?.model ?? null, priceMap, tieredPriceOf(call))
        : {
            price: null,
            costUsd: null,
            costState: (nextUsage ? "pending" : "unknown") as ChatCallCostState,
          };
      writeChatCallRow(
        db,
        sessionId,
        {
          ...call,
          status,
          usage: nextUsage,
          ...priced,
          endedAt: now,
        },
        now,
        CALL_ROW_INDEX_BASE + index
      );
      // **费用是在这一刻产生的,累计必须跟着更新。** 只在 insertPendingChatCall
      // 那处更新的话,累计会永远停在「只有 pending」——左栏显示 ≥$0,看着像没花钱。
      writeSessionUsageTotals(db, sessionId, now);
      return;
    }

    const canBackfill =
      call.status === "aborted" &&
      !call.usage &&
      usage !== null &&
      call.ownerInstanceId === INSTANCE_ID;
    if (canBackfill) {
      // **这条路径同样要计价。** 合盖导致租约过期、醒来才补回用量的那种账,
      // 只接上面那条的话会永远停在 `pending` —— 而这条路径存在的全部理由
      // 就是「钱确实花了,账上不能是『—』」。
      const priced = priceMap
        ? priceChatCall(usage, call.model?.model ?? null, priceMap, tieredPriceOf(call))
        : { price: null, costUsd: null, costState: "pending" as ChatCallCostState };
      writeChatCallRow(
        db,
        sessionId,
        { ...call, usage, ...priced },
        now,
        CALL_ROW_INDEX_BASE + index
      );
      // 补写用量这条路径同样要更新累计 —— 合盖唤醒后补回来的钱,
      // 不跟着更新的话左栏会一直少算那一笔。
      writeSessionUsageTotals(db, sessionId, now);
    }
    // 其余情况一律忽略:迟到的事件改不动已经结束的那一笔。
  }).immediate();
}

/**
 * 找这次估算可用的**基准账目**。设计文档《预算》的四个条件缺一不可:
 *
 * 1. `purpose: "answer"` 且 `completed`、`usage.input` 非空。
 *    **`finalize` / `compact` 永不作基准** —— 补答只发问题与工具证据,
 *    内容形状与正常轮次完全不同,拿它当基准等于拿另一种请求的用量去推这一种。
 * 2. 模型条目相同:不同模型的分词不可比。
 * 3. `systemHash` 与 `toolsHash` 相同。
 * 4. 本次发送视图**前 `count` 条**的哈希等于它的 `prefixHash` ——
 *    工具结果省略状态变化、历史图移出窗口、思考回传方式改变,都会让它不等。
 *
 * 第 4 条要用**本次**的发送视图条目重算,那是 runtime 那一层的东西,所以由调用方
 * 传 `prefixHashOfFirst` 进来,这里只负责逐条筛。
 *
 * **没有指纹的老账目一律跳过。** 这两个键是后加的,之前落的行里没有;
 * 把缺失当成「匹配」会拿一笔内容未知的账当基准,估算错得毫无声息。
 */
export function findEstimateBaseline(
  db: Database.Database,
  sessionId: string,
  current: {
    model: { provider: string; model: string } | null;
    systemHash: string;
    toolsHash: string;
    prefixHashOfFirst: (count: number) => string | null;
  }
): ChatCall | null {
  if (!current.model) return null;
  const calls = readChatCalls(db, sessionId);
  // 从新到旧:要的是「最近一笔」可比的。
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const c = calls[i]!;
    if (c.purpose !== "answer" || c.status !== "completed") continue;
    if (typeof c.usage?.input !== "number") continue;
    const view = c.sendView;
    if (!view) continue;
    if (c.model?.provider !== current.model.provider) continue;
    if (c.model?.model !== current.model.model) continue;
    if (view.systemHash !== current.systemHash) continue;
    if (view.toolsHash !== current.toolsHash) continue;
    if (current.prefixHashOfFirst(view.count) !== view.prefixHash) continue;
    return c;
  }
  return null;
}

export function listChatCalls(db: Database.Database, sessionId: string): ChatCall[] {
  return readChatCalls(db, sessionId);
}

/**
 * 把该会话全部账目求和,写进 `llm_chat_sessions.metadata_json` 的 `usage` 键。
 *
 * **必须在写账目的同一个事务里调用**(评审 12A)。分开写的话,进程在两次写入之间
 * 挂掉就会留下一份与明细对不上的累计,而那正是这份缓存值最不该出现的状态。
 *
 * **覆盖写而不是合并写。** `llm_chat_sessions` 这一行的 `metadata_json` 只有对话
 * 代码一个写入方(其它模块的同名列在各自的表上),所以不必学 `software/syncRuns`
 * 那样做 `{...existing, ...}` 的合并 —— 那是给多方写同一行准备的。
 * 但仍然保留 `usage` 之外的键,万一将来有人往这里塞别的。
 */
function writeSessionUsageTotals(db: Database.Database, sessionId: string, now: string): void {
  const totals = computeSessionTotals(readChatCalls(db, sessionId), now);
  const row = db
    .prepare("SELECT metadata_json FROM llm_chat_sessions WHERE id = ?")
    .get(sessionId) as { metadata_json?: unknown } | undefined;
  let meta: Record<string, unknown> = {};
  if (typeof row?.metadata_json === "string") {
    try {
      const parsed = JSON.parse(row.metadata_json) as unknown;
      if (isRecord(parsed)) meta = parsed;
    } catch {
      // 坏数据直接重建 —— 累计是可重算的。
    }
  }
  meta.usage = totals;
  db.prepare("UPDATE llm_chat_sessions SET metadata_json = ? WHERE id = ?").run(
    JSON.stringify(meta),
    sessionId
  );
}

/** 会话级压缩设置。**默认关闭**(规格:自动压缩默认关)。 */
export type SessionCompactionSettings = {
  /** 自动压缩开关。关时只有手动「立即压缩」。 */
  auto: boolean;
};

/**
 * 读会话的压缩设置。
 *
 * 存在 `metadata_json.compaction` 下,与累计用量(`metadata_json.usage`)同住一列。
 * 安全性已查证:`writeSessionUsageTotals` 是**读-改-写**,只设 `meta.usage`,
 * 其余键原样保留 —— 所以两者不会互相抹掉。
 *
 * **缺失一律当「关」。** 旧会话没有这个键;把缺失读成「开」会让用户在毫不知情的
 * 情况下被扣压缩的钱。
 */
export function readSessionCompactionSettings(
  db: Database.Database,
  sessionId: string
): SessionCompactionSettings {
  const row = db
    .prepare("SELECT metadata_json FROM llm_chat_sessions WHERE id = ?")
    .get(sessionId) as { metadata_json?: unknown } | undefined;
  if (typeof row?.metadata_json !== "string") return { auto: false };
  try {
    const meta = JSON.parse(row.metadata_json) as unknown;
    const c = isRecord(meta) ? meta.compaction : null;
    return { auto: isRecord(c) && c.auto === true };
  } catch {
    return { auto: false };
  }
}

/** 写会话的压缩设置。与 `writeSessionUsageTotals` 同样是读-改-写,保留其它键。 */
export function setSessionCompactionAuto(
  db: Database.Database,
  sessionId: string,
  auto: boolean
): void {
  db.transaction(() => {
    const row = db
      .prepare("SELECT metadata_json FROM llm_chat_sessions WHERE id = ?")
      .get(sessionId) as { metadata_json?: unknown } | undefined;
    let meta: Record<string, unknown> = {};
    if (typeof row?.metadata_json === "string") {
      try {
        const parsed = JSON.parse(row.metadata_json) as unknown;
        if (isRecord(parsed)) meta = parsed;
      } catch {
        // 坏数据重建 —— 但这会丢掉 usage,所以下面立刻标注:
        // 累计是可重算的(recomputeSessionUsage),开关不是,优先保住开关的写入语义。
      }
    }
    meta.compaction = { auto };
    db.prepare("UPDATE llm_chat_sessions SET metadata_json = ? WHERE id = ?").run(
      JSON.stringify(meta),
      sessionId
    );
  }).immediate();
}

/** account 求和。与 `sessionUsage` 的 `session` 块口径一致:pending 不计费但标下限。 */
function computeSessionTotals(calls: ChatCall[], now: string): SessionUsageTotals {
  const t = emptyTotals();
  for (const c of calls) addCall(t, c);
  return {
    costUsd: t.costUsd,
    atLeast: t.atLeast,
    input: t.input,
    output: t.output,
    reasoning: t.reasoning,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite,
    updatedAt: now,
  };
}

/**
 * 按明细重算并写回累计。**对账与修复用的兜底**(规格要求)。
 *
 * 正常路径靠写账目时的同事务更新;这个函数给「怀疑累计与明细对不上」时用,
 * 也给旧会话补上从来没算过的那份。返回重算后的值,便于调用方比对。
 */
export function recomputeSessionUsage(
  db: Database.Database,
  sessionId: string
): SessionUsageTotals {
  return db.transaction(() => {
    const now = new Date().toISOString();
    writeSessionUsageTotals(db, sessionId, now);
    return computeSessionTotals(readChatCalls(db, sessionId), now);
  }).immediate();
}

/**
 * 从目录缓存里取这笔账所用模型的分段价。取不到一律返回 undefined —— 退回基础价。
 *
 * **两处 provider id 是同一套,这点实测过:** `deepseek` / `minimax` / `volcengine`
 * 等在 models.dev 里同名存在。而 `openai-compatible` 这种 ai2nao 特有的 id 在那边
 * 没有对应,取不到就退回基础价 —— 那是正确行为,不是缺陷:我们根本不知道它对面是谁。
 */
function tieredPriceOf(call: ChatCall): ModelTieredPrice | undefined {
  return tieredPriceForModel(call.model);
}

function tieredPriceForModel(m: ChatCall["model"]): ModelTieredPrice | undefined {
  if (!m) return undefined;
  // 缓存可能整个没有、可能是升级前的旧格式(没有 pricing 键)—— 都按「没有」处理。
  return readCachedCatalog()?.pricing?.[m.provider]?.[m.model];
}

/**
 * 给一笔**还没发生**的请求估价(「立即压缩(约 $X)」用)。
 *
 * 与账本走**同一个** `priceChatCall` 与同一条分段价取用路径 —— 另写一套的话,
 * 预估与事后入账各算各的,而且不报错。只有算得出确数(`priced`)才给数;
 * 缺价格就是 null,界面据此不写「约 $X」,而不是编一个 $0。
 */
export function estimateChatCallCostUsd(
  model: ChatCall["model"],
  usage: ChatCallUsage,
  priceMap: PriceMap
): number | null {
  const r = priceChatCall(usage, model?.model ?? null, priceMap, tieredPriceForModel(model));
  return r.costState === "priced" ? r.costUsd : null;
}

/**
 * 逐笔计价:五档判定 + `partial` 的下限算法。
 *
 * **写在这里而不是扩 `src/cost/pricing.ts`**:那个模块被趋势页等既有来源共用,
 * 设计明写「分段计价只作用于新账目,不改动现有来源的计价算法」。这里只借它的
 * `priceFor` 取单价,判定与下限是这一侧的事。
 *
 * **三套命名在这里汇合,映射只有一处名字不同:** 账本的 `cacheWrite` 对应
 * `ModelPrice.cacheCreation`(其余 `noCache→input`、`cacheRead`、`output` 同名)。
 * 写错不会报错,只会静默算错钱 —— 所以单测里专门拿它当断言。
 */
/**
 * 选档:取 `size` 小于当前输入 token 数的**最大**那一档;都不小于就用基础价。
 *
 * **判据是 `usage.input`,这一点是推断,不是设计文档写死的。** 通篇只有「无法确定
 * 价格档位(`input` 为 null)时按最低档计」这一句间接把两者挂钩。之所以认为成立:
 * 一次请求的 `input` 就是它携带的上下文总量(历史全在里面),而 models.dev 的
 * `tier.type` 恰是 `"context"`。曾担心「输入 token ≠ 上下文长度会系统性少算」,
 * 但那只适用于「只统计新增消息」的口径,这里不是。
 *
 * `tiers` 已在解析时按 size 升序存好,所以从后往前第一个命中的就是最大档。
 */
function tierRateFor(
  tiered: ModelTieredPrice,
  inputTokens: number | null
): { rate: TierRate; tier: string | null } {
  if (inputTokens !== null) {
    for (let i = tiered.tiers.length - 1; i >= 0; i -= 1) {
      const t = tiered.tiers[i]!;
      if (inputTokens > t.size) {
        // 带上类型前缀:实测 `tier.type` 只有 "context" 一种,但写死前缀后,
        // 将来真出现别的类型时,旧账目行里的标识不会被误读成新类型。
        return { rate: t, tier: `context:${t.size}` };
      }
    }
  }
  return { rate: tiered.base, tier: null };
}

export function priceChatCall(
  usage: ChatCallUsage | null,
  model: string | null,
  priceMap: PriceMap,
  /**
   * 该模型的分段价。**可选** —— 不传则与加这个参数之前的行为一字不差,
   * 既不破坏既有调用,也让「忘了接」在测试里看得见。
   */
  tiered?: ModelTieredPrice
): { price: ChatCall["price"]; costUsd: number | null; costState: ChatCallCostState } {
  // 2. input 与 output 都不知道 —— 连「花没花」都谈不上。
  if (!usage || (usage.input === null && usage.output === null)) {
    return { price: null, costUsd: null, costState: "unknown" };
  }

  // 3. 没有这个模型的价格:token 照计,费用留空。
  //    **分段价优先**:目录缓存里有这个模型就用它,否则退回内置/同步来的价格表。
  //    两者都没有才是 unpriced。
  const picked = tiered ? tierRateFor(tiered, usage.input) : null;
  const p = picked
    ? {
        input: picked.rate.input,
        output: picked.rate.output,
        cacheRead: picked.rate.cacheRead,
        // **这对名字不同,今天已经踩过一次。** `TierRate` 叫 cacheWrite,
        // `ModelPrice` 叫 cacheCreation —— 显式转,不靠结构相似蒙混。
        cacheCreation: picked.rate.cacheWrite,
      }
    : priceFor(model, priceMap);
  if (!p) return { price: null, costUsd: null, costState: "unpriced" };

  const snapshot = {
    input: p.input,
    output: p.output,
    cacheRead: p.cacheRead,
    // **唯一名字不同的一对。**
    cacheWrite: p.cacheCreation,
    // 用了哪一档。基础价与无分段价时都是 null —— 两者在账目上不必区分,
    // 因为快照里已经存了当时的四个单价。
    tier: picked?.tier ?? null,
  };

  // 输入侧分桶:三个都已知就直接用;否则由 input 减去两个缓存桶反推 noCache。
  const { input, noCache, cacheRead, cacheWrite, output } = usage;
  const bucketsKnown = noCache !== null && cacheRead !== null && cacheWrite !== null;
  const derivable = input !== null && cacheRead !== null && cacheWrite !== null;
  const fresh = bucketsKnown ? noCache : derivable ? Math.max(0, input - cacheRead - cacheWrite) : null;

  // 4/5. 必需项 = output 齐 + 输入分桶可确定。
  if (output !== null && fresh !== null) {
    const usd =
      fresh * p.input + cacheRead! * p.cacheRead + cacheWrite! * p.cacheCreation + output * p.output;
    return { price: snapshot, costUsd: usd, costState: "priced" };
  }

  // 4. partial —— **算出来的必须是真下限**,宁可低估,不可高估。
  let usd = 0;
  // 已确定的分桶按各自单价计。
  if (cacheRead !== null) usd += cacheRead * p.cacheRead;
  if (cacheWrite !== null) usd += cacheWrite * p.cacheCreation;
  if (fresh !== null) {
    usd += fresh * p.input;
  } else if (input !== null) {
    // 拆不开的那部分,按**输入侧最便宜**的单价计 —— 这样才是下限。
    const cheapest = Math.min(p.input, p.cacheRead, p.cacheCreation);
    const counted = (cacheRead ?? 0) + (cacheWrite ?? 0);
    usd += Math.max(0, input - counted) * cheapest;
  }
  // output 未知时这部分计 0(而不是拿 input 估),否则就不是下限了。
  if (output !== null) usd += output * p.output;

  return { price: snapshot, costUsd: usd, costState: "partial" };
}

// ---------------------------------------------------------------------------
// 有副作用的工具:**执行之前**落记录
// ---------------------------------------------------------------------------

/**
 * tool-exec 行的 message_index 保留区,与占位行(1_000_000)、账目(2_000_000)分开。
 * 三类服务端行各占一段 —— `UNIQUE(session_id, message_index)` 不允许撞号。
 */
const TOOL_EXEC_ROW_INDEX_BASE = 3_000_000;

/**
 * `unknown` 不是一种执行结果,是**我们不知道**。
 *
 * 进程在命令跑到一半时没了,醒来后既不能断定它跑过、也不能断定没跑过 ——
 * 而恰恰是租约恢复会触发重新生成。所以不自动重跑,标成 unknown 交给用户判断。
 */
export type ChatToolExecStatus = "started" | "completed" | "failed" | "unknown";

export type ChatToolExec = {
  v: 1;
  /** SDK 给的 tool call id。一次工具调用一行,重复事件只会覆盖同一行。 */
  toolCallId: string;
  runId: string;
  /** 落这行时持有的执行权令牌。被接管后,旧 fence 的 started 行会被标成 unknown。 */
  fence: number;
  toolName: string;
  command: string;
  cwd: string | null;
  status: ChatToolExecStatus;
  ownerInstanceId: string;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
};

function toolExecRowMessageId(toolCallId: string): string {
  return `${SERVER_ONLY_MESSAGE_PREFIX}tool-exec:${toolCallId}`;
}

function parseChatToolExec(rawJson: string): ChatToolExec | null {
  try {
    const parsed = JSON.parse(rawJson) as { content?: unknown };
    const content = parsed?.content;
    if (typeof content === "string") return JSON.parse(content) as ChatToolExec;
    if (content && typeof content === "object") return content as ChatToolExec;
  } catch {
    return null;
  }
  return null;
}

function readChatToolExecs(db: Database.Database, sessionId: string): ChatToolExec[] {
  const rows = db
    .prepare(
      `SELECT raw_json FROM llm_chat_messages
       WHERE session_id = ? AND role = 'activity' AND message_id LIKE ?
       ORDER BY message_index ASC`
    )
    .all(sessionId, `${SERVER_ONLY_MESSAGE_PREFIX}tool-exec:%`) as { raw_json: string }[];
  return rows
    .map((r) => parseChatToolExec(r.raw_json))
    .filter((e): e is ChatToolExec => e !== null && typeof e.toolCallId === "string");
}

function writeChatToolExecRow(
  db: Database.Database,
  sessionId: string,
  exec: ChatToolExec,
  now: string,
  index: number
): void {
  const messageId = toolExecRowMessageId(exec.toolCallId);
  db.prepare(
    `INSERT INTO llm_chat_messages (
       id, session_id, message_id, message_index, role, raw_json,
       plain_text, preview, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'activity', ?, '', '[activity]', ?, ?, ?)
     ON CONFLICT(session_id, message_id) DO UPDATE SET
       raw_json = excluded.raw_json,
       status = excluded.status,
       updated_at = excluded.updated_at`
  ).run(
    `${sessionId}:${messageId}`,
    sessionId,
    messageId,
    index,
    JSON.stringify({
      id: messageId,
      role: "activity",
      activityType: "ai2nao.tool-exec",
      content: JSON.stringify(exec),
    }),
    exec.status,
    now,
    now
  );
}

export type ChatCompactionSummary = {
  decisions: string[];
  constraints: string[];
  state: string[];
  nextSteps: string[];
};

/**
 * 压缩事件(粗 T7)。**只追加、不修改** —— 撤销是追加一条 `revert`,不是改旧行。
 *
 * 字段表照《1. 数据形状》。**已执行动作清单与图片轮次占位不在事件里**:
 * 规格把那两段描述为后端「纯读取、不额外花钱」地生成,也就是**发送时再算**。
 * 先前实现把它们存进了行里,是与规格的偏离,这次改回。
 *
 * 生效规则:按行序回放,`compaction` 入栈、`revert` 出栈,**栈顶即当前生效压缩**。
 */
export type ChatCompactionEvent =
  | {
      v: 1;
      kind: "compaction";
      id: string;
      /** 创建时生效的那条压缩(没有则 null)。它的摘要是本次摘要的输入之一。 */
      baseId: string | null;
      trigger: "manual" | "auto";
      /** 本压缩生效时**不发送**的全部消息 id —— 累计集合,含 base 已排除的。 */
      excludedMessageIds: string[];
      summary: ChatCompactionSummary;
      /** 生成摘要的那些请求;分块时多笔,callId 互不相同。 */
      summaryCallIds: string[];
      /**
       * 这次压缩让下一轮少发多少 token(估算):生效前后各算一次全量估算,取差。
       * 规格《7》「成功后显示释放量」要的就是它。**在压缩那一刻算好存下**,因为事后
       * 已无从得知「压缩前」的发送视图。字段是后加的,老事件没有 —— 读到 undefined
       * 按「不知道」处理,不是 0。
       */
      freedTokens?: number;
      createdAt: string;
    }
  | { v: 1; kind: "revert"; targetId: string; createdAt: string };

export type ChatCompaction = Extract<ChatCompactionEvent, { kind: "compaction" }>;

/**
 * 压缩事件行的 `message_index` 保留区,与占位行(1e6)、账目(2e6)、tool-exec(3e6)分开。
 *
 * 保留区不参与 `replaceLlmChatSessionMessages` 的负数重排 —— 那条 UPDATE 的
 * `WHERE` 显式排除了 `ai2nao:%` 前缀(实测确认)。回放依赖行序,所以按事件总数递增分配。
 */
const COMPACTION_ROW_INDEX_BASE = 4_000_000;

/**
 * 两种事件用**不同前缀**。同前缀会让「撤销 X」与「压缩 X」撞
 * `UNIQUE(session_id, message_id)` —— 撤销会把被撤销的那条原地覆盖掉,栈就废了。
 */
/**
 * 分隔线行的 `message_id`。**导出**是因为快照那边要按它放行 —— 形状在两个文件里
 * 各写一遍的话,改一处就会让分隔线静默消失(界面上本来就看不见它)。
 */
export function compactionDividerMessageId(compactionId: string): string {
  return `${SERVER_ONLY_MESSAGE_PREFIX}compaction:${compactionId}`;
}

function compactionEventRowMessageId(event: ChatCompactionEvent): string {
  return event.kind === "compaction"
    ? compactionDividerMessageId(event.id)
    : `${SERVER_ONLY_MESSAGE_PREFIX}compaction-revert:${event.targetId}`;
}

function parseChatCompactionEvent(rawJson: string): ChatCompactionEvent | null {
  try {
    const parsed = JSON.parse(rawJson) as { content?: unknown };
    const content = parsed?.content;
    const v: unknown = typeof content === "string" ? JSON.parse(content) : content;
    if (!isRecord(v)) return null;
    if (v.kind === "compaction" && typeof v.id === "string") {
      return v as unknown as ChatCompactionEvent;
    }
    if (v.kind === "revert" && typeof v.targetId === "string") {
      return v as unknown as ChatCompactionEvent;
    }
    return null;
  } catch {
    return null;
  }
}

/** 按**行序**(写入顺序)返回全部压缩事件。回放的正确性依赖这个顺序。 */
export function readChatCompactionEvents(
  db: Database.Database,
  sessionId: string
): ChatCompactionEvent[] {
  const rows = db
    .prepare(
      `SELECT raw_json FROM llm_chat_messages
       WHERE session_id = ? AND role = 'activity'
         AND (message_id LIKE ? OR message_id LIKE ?)
       ORDER BY message_index ASC`
    )
    .all(
      sessionId,
      `${SERVER_ONLY_MESSAGE_PREFIX}compaction:%`,
      `${SERVER_ONLY_MESSAGE_PREFIX}compaction-revert:%`
    ) as { raw_json: string }[];
  return rows
    .map((r) => parseChatCompactionEvent(r.raw_json))
    .filter((e): e is ChatCompactionEvent => e !== null);
}

/**
 * 回放成栈:`compaction` 入栈,`revert` 仅在 `targetId` 等于栈顶时出栈,对不上的**跳过**。
 *
 * 读取侧跳过而不是抛:库里若真有一条不合法的 revert(手改、旧版写入),
 * 整个会话不该因此打不开。把关在写入侧(见 `revertChatCompaction`)。
 */
export function replayCompactionStack(events: ChatCompactionEvent[]): ChatCompaction[] {
  const stack: ChatCompaction[] = [];
  for (const e of events) {
    if (e.kind === "compaction") stack.push(e);
    else if (stack.length > 0 && stack[stack.length - 1]!.id === e.targetId) stack.pop();
  }
  return stack;
}

/** 当前生效的压缩 = 栈顶。没有就是 null(整段历史都在)。 */
export function activeCompaction(
  db: Database.Database,
  sessionId: string
): ChatCompaction | null {
  const stack = replayCompactionStack(readChatCompactionEvents(db, sessionId));
  return stack.length > 0 ? stack[stack.length - 1]! : null;
}

function writeChatCompactionEventRow(
  db: Database.Database,
  sessionId: string,
  event: ChatCompactionEvent,
  index: number
): void {
  const messageId = compactionEventRowMessageId(event);
  db.prepare(
    `INSERT INTO llm_chat_messages (
       id, session_id, message_id, message_index, role, raw_json,
       plain_text, preview, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'activity', ?, '', '[activity]', ?, ?, ?)
     ON CONFLICT(session_id, message_id) DO UPDATE SET
       raw_json = excluded.raw_json,
       status = excluded.status,
       updated_at = excluded.updated_at`
  ).run(
    `${sessionId}:${messageId}`,
    sessionId,
    messageId,
    index,
    JSON.stringify({
      id: messageId,
      role: "activity",
      activityType:
        event.kind === "compaction" ? "ai2nao.compaction" : "ai2nao.compaction-revert",
      // **对象,不是字符串。** AG-UI 的 `ActivityMessageSchema` 规定
      // `content: Record<string, any>`,这是声明契约;渲染器组件拿到的就是这个值,
      // 写成字符串的话组件得自己 `JSON.parse`,而类型上它仍被当作对象。
      //
      // (**更正一版**:先前这里写着「不会让分隔线消失」,是错的。读 CopilotKit
      // 的实现可见 —— `findRenderer(message.activityType)` 选中渲染器之后,会跑
      // `renderer.content.safeParse(message.content)`,**失败就 `return null`**,
      // 只留一句 `console.warn`。对用户就是「界面什么都没有、也没有任何提示」。
      //
      // 另一处落差:类型声明写的是 `content: StandardSchemaV1<...>`,运行期却直接
      // 调 `.safeParse` —— 所以渲染器那个 schema 必须是 zod,光实现 standard-schema
      // 接口不够。)
      //
      // 只改这一条:另外三类 activity 行(run / call / tool-exec)永不出
      // `threadSnapshot` 的闸,不面向 AG-UI 客户端,改它们属于无谓波及。
      // 读取侧 `parseChatCompactionEvent` 两种形式都收,老行照样读得回来。
      content: event,
    }),
    event.kind,
    event.createdAt,
    event.createdAt
  );
}

/**
 * **原子激活**:全部成功后在一个事务里追加一条 `compaction` 事件。
 * 任一步失败则不写 —— 已发生的账目照常保留,原上下文保持有效。
 *
 * `baseId` 取**写入时**的栈顶,不是调用方传进来的 —— 调用方读到栈顶与写入之间
 * 可能又落了一条,以事务内读到的为准。
 */
export function activateChatCompaction(
  db: Database.Database,
  sessionId: string,
  input: {
    id: string;
    trigger: "manual" | "auto";
    excludedMessageIds: string[];
    summary: ChatCompactionSummary;
    summaryCallIds: string[];
    freedTokens?: number;
  }
): ChatCompaction {
  return db.transaction(() => {
    const events = readChatCompactionEvents(db, sessionId);
    const stack = replayCompactionStack(events);
    const event: ChatCompaction = {
      v: 1,
      kind: "compaction",
      id: input.id,
      baseId: stack.length > 0 ? stack[stack.length - 1]!.id : null,
      trigger: input.trigger,
      excludedMessageIds: input.excludedMessageIds,
      summary: input.summary,
      summaryCallIds: input.summaryCallIds,
      ...(input.freedTokens !== undefined ? { freedTokens: input.freedTokens } : {}),
      createdAt: new Date().toISOString(),
    };
    writeChatCompactionEventRow(db, sessionId, event, COMPACTION_ROW_INDEX_BASE + events.length);
    return event;
  }).immediate();
}

export type RevertChatCompactionResult =
  | { ok: true; event: Extract<ChatCompactionEvent, { kind: "revert" }> }
  | { ok: false; reason: "not-top" | "empty" };

/**
 * 撤销:追加一条 `revert` 事件。
 *
 * **`targetId` 必须等于栈顶,否则拒绝写入。** 只能逐层回退 —— 允许跳层的话,
 * 「发给模型的内容」就不再是事件序列的函数,同一串事件回放出的结果会含糊。
 */
export function revertChatCompaction(
  db: Database.Database,
  sessionId: string,
  targetId: string
): RevertChatCompactionResult {
  return db.transaction((): RevertChatCompactionResult => {
    const events = readChatCompactionEvents(db, sessionId);
    const stack = replayCompactionStack(events);
    if (stack.length === 0) return { ok: false, reason: "empty" };
    if (stack[stack.length - 1]!.id !== targetId) return { ok: false, reason: "not-top" };
    const event = {
      v: 1 as const,
      kind: "revert" as const,
      targetId,
      createdAt: new Date().toISOString(),
    };
    writeChatCompactionEventRow(db, sessionId, event, COMPACTION_ROW_INDEX_BASE + events.length);
    return { ok: true, event };
  }).immediate();
}

export type StartChatToolExecResult =
  | { ok: true; exec: ChatToolExec }
  | { ok: false; reason: "superseded" };

/**
 * 命令**执行之前**落记录,并在同一个事务里确认执行权还是自己的。
 *
 * 两件事必须同事务:只落记录不校验,被接管的旧进程醒来照样会跑命令;
 * 只校验不落记录,崩在 spawn 与首次写库之间的那条命令就查无此行。
 * 返回 `superseded` 时调用方必须放弃执行 —— 这一轮已经不归它了。
 */
export function startChatToolExec(
  db: Database.Database,
  sessionId: string,
  input: {
    toolCallId: string;
    runId: string;
    fence: number;
    toolName: string;
    command: string;
    cwd?: string | null;
  }
): StartChatToolExecResult {
  return db.transaction((): StartChatToolExecResult => {
    if (!isChatRunCurrent(db, sessionId, input.fence)) return { ok: false, reason: "superseded" };
    const now = new Date().toISOString();
    const existing = readChatToolExecs(db, sessionId);
    const at = existing.findIndex((e) => e.toolCallId === input.toolCallId);
    const row: ChatToolExec = {
      v: 1,
      toolCallId: input.toolCallId,
      runId: input.runId,
      fence: input.fence,
      toolName: input.toolName,
      command: input.command,
      cwd: input.cwd ?? null,
      status: "started",
      ownerInstanceId: INSTANCE_ID,
      exitCode: null,
      startedAt: now,
      endedAt: null,
    };
    writeChatToolExecRow(
      db,
      sessionId,
      row,
      now,
      TOOL_EXEC_ROW_INDEX_BASE + (at >= 0 ? at : existing.length)
    );
    return { ok: true, exec: row };
  }).immediate();
}

/** 落终态。**终态不可回退** —— 迟到的事件改不动已经结束的那一条。 */
export function finishChatToolExec(
  db: Database.Database,
  sessionId: string,
  toolCallId: string,
  status: Exclude<ChatToolExecStatus, "started">,
  exitCode: number | null
): void {
  db.transaction(() => {
    const execs = readChatToolExecs(db, sessionId);
    const at = execs.findIndex((e) => e.toolCallId === toolCallId);
    if (at < 0) return;
    const exec = execs[at]!;
    if (exec.status !== "started") return;
    const now = new Date().toISOString();
    writeChatToolExecRow(
      db,
      sessionId,
      { ...exec, status, exitCode, endedAt: now },
      now,
      TOOL_EXEC_ROW_INDEX_BASE + at
    );
  }).immediate();
}

/**
 * 新一轮占住会话后,把旧 fence 遗留的 `started` 行标成 `unknown`。
 *
 * 判据用 fence 而不是租约时间:租约过期只说明心跳停了,而 fence 变了说明
 * 执行权**确实**易主 —— 那条命令的持有者已经无权收尾,它的结果没人会再写。
 */
export function markStaleToolExecsUnknown(
  db: Database.Database,
  sessionId: string,
  currentFence: number
): number {
  return db.transaction(() => {
    const execs = readChatToolExecs(db, sessionId);
    const now = new Date().toISOString();
    let marked = 0;
    execs.forEach((exec, at) => {
      if (exec.status !== "started" || exec.fence === currentFence) return;
      writeChatToolExecRow(
        db,
        sessionId,
        { ...exec, status: "unknown", endedAt: now },
        now,
        TOOL_EXEC_ROW_INDEX_BASE + at
      );
      marked += 1;
    });
    return marked;
  }).immediate();
}

export function listChatToolExecs(db: Database.Database, sessionId: string): ChatToolExec[] {
  return readChatToolExecs(db, sessionId);
}

export function listLlmChatSessions(
  db: Database.Database,
  limit = 50
): LlmChatSessionSummary[] {
  const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit) || 50));
  return db
    .prepare(
      `SELECT id, title, protocol, created_at, updated_at, last_message_at, message_count,
              metadata_json
       FROM llm_chat_sessions
       ORDER BY COALESCE(last_message_at, updated_at) DESC, updated_at DESC
       LIMIT ?`
    )
    .all(safeLimit)
    .map(withParsedUsage);
}

/**
 * 把行里的 `metadata_json` 解析成 `usage` 字段。
 *
 * **不在列表查询里现算累计**(评审 12A):否则每次打开对话页、每轮结束刷新列表,
 * 都要把最近 50 个会话的全部账目行读出来逐行解析 JSON 求和 —— 当主力用几个月后
 * 左栏会线性变慢。累计在写账目的同一个事务里更新,这里只是读一列。
 */
function withParsedUsage(row: unknown): LlmChatSessionSummary {
  const r = row as Record<string, unknown>;
  const { metadata_json: raw, ...rest } = r;
  const summary = rest as unknown as LlmChatSessionSummary;
  if (typeof raw !== "string") return summary;
  try {
    const meta = JSON.parse(raw) as unknown;
    const u = isRecord(meta) ? meta.usage : null;
    // 只认形状对的:坏数据当成「还没算过」,不让它把界面变成 $NaN。
    if (isRecord(u) && typeof u.costUsd === "number" && typeof u.atLeast === "boolean") {
      summary.usage = u as unknown as SessionUsageTotals;
    }
  } catch {
    // 手改坏了或半截写入 —— 当没有。累计是可重算的,不值得为它报错。
  }
  return summary;
}

/** 一笔账在接口上的样子。比 `ChatCall` 少内部字段(fence / ownerInstanceId)。 */
export type ChatCallView = {
  callId: string;
  purpose: ChatCallPurpose;
  stepIndex: number;
  attempt: number;
  status: ChatCallStatus;
  model: ChatCall["model"];
  usage: ChatCallUsage | null;
  price: ChatCall["price"];
  costUsd: number | null;
  costState: ChatCallCostState;
  startedAt: string;
  endedAt: string | null;
};

export type SessionUsage = {
  byRun: Record<
    string,
    { displayMessageId: string | null; calls: ChatCallView[]; totals: UsageTotals }
  >;
  byAssistantMessage: Record<string, { runId: string; callIds: string[] }>;
  byReasoningMessage: Record<
    string,
    { durationMs: number | null; reasoningTokens: number | null; callId: string | null }
  >;
  session: UsageTotals & { costStates: Record<ChatCallCostState, number> };
  /**
   * 下一轮的上下文占用。**由调用方注入,不在这里算。**
   *
   * 算它要用估算件(`contextWindowFor` / `estimateInputForRequest` / 发送视图),
   * 那些都在 `copilotRuntime.ts`,而**本文件引同目录模块数为 0** —— 它是这棵子树的
   * 最底层。反向 import 会造出第一个环,后果是模块加载期 TDZ:报错点离病根很远,
   * 而且未必每条测试都触发(`llmChat.moduleLayering.test.ts` 的文档写明了这一点)。
   * 所以类型住在这里、实现住在上层、由路由层注入。
   *
   * 取不到模型或未注入时是 null,界面按「窗口未知」处理,**不是「占用为 0」**。
   */
  context: SessionContextView | null;
  /** 当前生效的压缩栈与完整事件列表(规格《5》:「当前栈与事件列表」)。 */
  compactions: { stack: ChatCompaction[]; events: ChatCompactionEvent[] };
};

/**
 * 下一轮发送内容的占用快照。
 *
 * **分项各自取整,`estimatedInput` 等于分项之和** —— 四项各 `ceil` 再与另算的总数
 * 并列的话,界面上「分项加起来对不上总数」,而且不会报错。
 */
export type SessionContextView = {
  model: { provider: string; model: string; label: string } | null;
  /** 取不到就是 null:**别当成 0 或无穷**,界面标「窗口未知」。 */
  contextWindow: number | null;
  outputReserve: number;
  estimatedInput: number;
  /** true = 全量估算(没有可比基准),界面数字前加 `≈`;false = 基于同前缀的真实账目。 */
  estimateOnly: boolean;
  breakdown: {
    /** 系统提示 + 工具定义。 */
    system: number;
    /** 生效压缩的摘要段。 */
    summary: number;
    /** 待发送的对话正文。 */
    recent: number;
    /** 工具调用的入参与结果 —— 它们常比正文还长,单列一项才看得出该不该省。 */
    toolResults: number;
    /** 图片按固定估值计入。 */
    images: number;
  };
  /**
   * 分项之和。**与 `estimatedInput` 是两个口径,不要指望它们永远相等。**
   *
   * `estimatedInput` 在对得上基准时返回的是「基准账目的真实 input + 新增部分」,
   * 而分项是一次全量分解。规则:`estimateOnly === true` 时两者必然相等;为 false
   * 时按定义不等,界面要把分项呈现为「构成」而不是「加数」。
   *
   * 不透出这个值的话,前端只能把四项自己加起来跟头条数字比 —— 对不上,
   * 而且没有任何东西说明为什么。
   */
  breakdownTotal: number;
  /** 下一轮是否会省略「最近 3 个用户轮之前」的工具结果(阶梯第 1 步)。 */
  toolResultsOmitted: boolean;
  autoCompaction: boolean;
  /**
   * 建议的折叠上界(`message_index`),供界面的「现在压缩」直接用;不足以压缩时为 null。
   *
   * **为什么由后端给**:压缩路由刻意不给 `upToMessageIndex` 默认值(「折叠到哪」是策略,
   * 该由调用方定),而前端手里只有 AG-UI 消息、**没有 `message_index`** —— 没有这个字段,
   * 界面上那个按钮就没有能填的参数。取「倒数第 3 个用户轮」,与自动压缩同一个判据。
   */
  suggestedCompactUpTo: number | null;
  /**
   * 按 `suggestedCompactUpTo` 压缩的预估花费(美元),供「立即压缩(约 $X)」。
   * 规格要写出来的原因是**压缩会调外部模型、会花钱**。没有折叠点或缺价格时为 null。
   */
  compactCostEstimateUsd: number | null;
};

export type UsageTotals = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  /** 合计里存在 partial / unknown / unpriced / pending 时为 true,界面加 `≥`。 */
  atLeast: boolean;
};

function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, atLeast: false };
}

function addCall(t: UsageTotals, c: ChatCall): void {
  const u = c.usage;
  if (u) {
    t.input += u.input ?? 0;
    t.output += u.output ?? 0;
    t.reasoning += u.reasoning ?? 0;
    t.cacheRead += u.cacheRead ?? 0;
    t.cacheWrite += u.cacheWrite ?? 0;
  }
  // **pending 不计入费用**(设计第 1 档明写),但它让合计变成下限。
  if (c.costState === "priced") t.costUsd += c.costUsd ?? 0;
  else if (c.costState === "partial") {
    t.costUsd += c.costUsd ?? 0;
    t.atLeast = true;
  } else t.atLeast = true; // unknown / unpriced / pending
}

function viewOf(c: ChatCall): ChatCallView {
  return {
    callId: c.callId,
    purpose: c.purpose,
    stepIndex: c.stepIndex,
    attempt: c.attempt,
    status: c.status,
    model: c.model,
    usage: c.usage,
    price: c.price,
    costUsd: c.costUsd,
    costState: c.costState,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
  };
}

/**
 * 会话的用量聚合。
 *
 * **`displayMessageId` 是推导值,不落库**:取该轮**最后一条** assistant 消息的 id
 * (有补答或兜底回答时自然就是它们)。用量行只在这条消息底部显示一次。
 *
 * **必须按前缀分拣。** `agUiMessagesFromSession` 返回**全部**行,含 `ai2nao:` 前缀的
 * 服务端专有行(占位行 / 账目 / tool-exec)。混进来会让 `displayMessageId` 指向
 * 一条根本不是回答的行。
 */
export function sessionUsage(
  db: Database.Database,
  sessionId: string,
  /** 上层注入(见 `SessionContextView` 的注释:方向不能反)。不传就是「未知」。 */
  context: SessionContextView | null = null
): SessionUsage {
  const calls = readChatCalls(db, sessionId);
  const detail = getLlmChatSession(db, sessionId);
  const messages = detail ? agUiMessagesFromSession(detail) : [];

  const byRun: SessionUsage["byRun"] = {};
  const byAssistantMessage: SessionUsage["byAssistantMessage"] = {};
  const session = { ...emptyTotals(), costStates: { pending: 0, unknown: 0, unpriced: 0, partial: 0, priced: 0 } };

  for (const c of calls) {
    const run = (byRun[c.runId] ??= { displayMessageId: null, calls: [], totals: emptyTotals() });
    run.calls.push(viewOf(c));
    addCall(run.totals, c);
    addCall(session, c);
    session.costStates[c.costState] += 1;
  }

  // 每一轮的最后一条 assistant 消息。消息按 message_index 升序取回,所以后来的覆盖先前的。
  for (const m of messages) {
    const id = typeof m.id === "string" ? m.id : "";
    if (!id || isServerOnlyMessageId(id) || m.role !== "assistant") continue;
    const runId = runIdOfAssistantId(id);
    if (!runId) continue;
    const run = byRun[runId];
    if (run) run.displayMessageId = id;
    const ids = (byAssistantMessage[id] ??= { runId, callIds: [] });
    ids.callIds = calls.filter((c) => c.runId === runId).map((c) => c.callId);
  }

  const byReasoningMessage: SessionUsage["byReasoningMessage"] = {};
  for (const m of messages) {
    if (m.role !== "reasoning") continue;
    const id = typeof m.id === "string" ? m.id : "";
    const meta = (m as { ai2naoReasoning?: unknown }).ai2naoReasoning;
    if (!id || !isRecord(meta)) continue;
    const callId = typeof meta.callId === "string" ? meta.callId : null;
    byReasoningMessage[id] = {
      durationMs: typeof meta.durationMs === "number" ? meta.durationMs : null,
      // **不按请求分摊**(设计明写):取不到就是「token 未知」。
      reasoningTokens: calls.find((c) => c.callId === callId)?.usage?.reasoning ?? null,
      callId,
    };
  }

  const events = readChatCompactionEvents(db, sessionId);
  return {
    byRun,
    byAssistantMessage,
    byReasoningMessage,
    session,
    context,
    compactions: { stack: replayCompactionStack(events), events },
  };
}

/** `a:${runId}:${purpose}:${stepIndex}` → runId。形状对不上返回 null。 */
function runIdOfAssistantId(id: string): string | null {
  if (!id.startsWith("a:")) return null;
  const rest = id.slice(2);
  const cut = rest.lastIndexOf(":");
  if (cut < 0) return null;
  const withoutStep = rest.slice(0, cut);
  const cut2 = withoutStep.lastIndexOf(":");
  return cut2 > 0 ? withoutStep.slice(0, cut2) : null;
}

export function createLlmChatSession(
  db: Database.Database,
  title?: string
): LlmChatSessionSummary {
  const now = new Date().toISOString();
  const id = randomUUID();
  const cleanTitle = cleanSessionTitle(title) ?? "新对话";
  db.prepare(
    `INSERT INTO llm_chat_sessions (
      id, title, protocol, created_at, updated_at, last_message_at, message_count
    ) VALUES (?, ?, 'copilotkit-agui', ?, ?, NULL, 0)`
  ).run(id, cleanTitle, now, now);
  const detail = getLlmChatSession(db, id);
  if (!detail) throw new LlmChatSessionError(500, "failed to create session");
  return detail;
}

export function getLlmChatSession(
  db: Database.Database,
  id: string
): LlmChatSessionDetail | null {
  const row = db
    .prepare(
      `SELECT id, title, protocol, created_at, updated_at, last_message_at, message_count,
              metadata_json
       FROM llm_chat_sessions
       WHERE id = ?`
    )
    .get(id);
  if (!row) return null;
  // 列表与详情**必须走同一条解析**:只改一处的话,左栏有累计而详情页没有。
  const session = withParsedUsage(row);
  const all = db
    .prepare(
      `SELECT id, session_id, message_id, message_index, role, raw_json,
              plain_text, preview, status, created_at, updated_at
       FROM llm_chat_messages
       WHERE session_id = ?
       ORDER BY message_index ASC`
    )
    .all(id) as LlmChatMessageRow[];

  // **顺序由 parent 链决定,不是 message_index(V61)。** 后者退化成全局插入序,
  // 只用来保证唯一;有了分支之后它不可能再表达顺序 —— 其他分支的行也占着号。
  //
  // 只保留激活路径上的树节点。切走的分支对「发给模型的上下文」「界面看到的对话」
  // 「压缩的作用域」三者都不存在。activity 行(run/账目/工具执行/压缩)不在树上,
  // 按 message_index 照旧全给。
  const path = activePathIds(db, id);
  if (path.length === 0) return { ...session, messages: all };
  const order = new Map(path.map((mid, i) => [mid, i]));
  const tree = all
    .filter((m) => order.has(m.message_id))
    .sort((a, b) => order.get(a.message_id)! - order.get(b.message_id)!);
  const activity = all.filter((m) => m.message_index >= RUN_ROW_INDEX_BASE);
  return { ...session, messages: [...tree, ...activity] };
}

export function ensureLlmChatSession(
  db: Database.Database,
  id: string,
  title?: string
): LlmChatSessionSummary {
  const existing = getLlmChatSession(db, id);
  if (existing) return existing;
  const now = new Date().toISOString();
  const cleanTitle = cleanSessionTitle(title) ?? "新对话";
  db.prepare(
    `INSERT INTO llm_chat_sessions (
      id, title, protocol, created_at, updated_at, last_message_at, message_count
    ) VALUES (?, ?, 'copilotkit-agui', ?, ?, NULL, 0)`
  ).run(id, cleanTitle, now, now);
  const created = getLlmChatSession(db, id);
  if (!created) throw new LlmChatSessionError(500, "failed to create session");
  return created;
}

export function deleteLlmChatSession(db: Database.Database, id: string): boolean {
  const info = db.prepare("DELETE FROM llm_chat_sessions WHERE id = ?").run(id);
  return info.changes > 0;
}

export function replaceLlmChatSessionMessages(
  db: Database.Database,
  sessionId: string,
  input: PersistLlmChatMessagesInput
): LlmChatSessionDetail {
  const row = db
    .prepare("SELECT id, title FROM llm_chat_sessions WHERE id = ?")
    .get(sessionId) as { id: string; title: string } | undefined;
  if (!row) throw new LlmChatSessionError(404, "session not found");
  if (input.messages.length > MAX_MESSAGES) {
    throw new LlmChatSessionError(
      413,
      `too many messages; max ${MAX_MESSAGES}`
    );
  }

  const now = new Date().toISOString();
  const normalized = input.messages.map((raw, index) =>
    normalizeAgUiMessage(raw, index, now)
  );
  const rawBytes = normalized.reduce((sum, msg) => sum + msg.raw_json.length, 0);
  if (rawBytes > MAX_SYNC_RAW_BYTES) {
    throw new LlmChatSessionError(413, "session payload is too large");
  }

  const explicitTitle = cleanSessionTitle(input.title);
  const title = explicitTitle ?? autoTitle(normalized) ?? row.title;
  const lastMessageAt = normalized.length > 0 ? now : null;
  const visibleMessageCount = normalized.filter(isHumanVisibleMessage).length;
  const incomingIds = new Set(normalized.map((m) => m.message_id));

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE llm_chat_sessions
       SET title = ?, updated_at = ?, last_message_at = ?, message_count = ?
       WHERE id = ?`
    ).run(title, now, lastMessageAt, visibleMessageCount, sessionId);

    const existing = db
      .prepare("SELECT message_id FROM llm_chat_messages WHERE session_id = ?")
      .all(sessionId) as { message_id: string }[];
    const del = db.prepare(
      "DELETE FROM llm_chat_messages WHERE session_id = ? AND message_id = ?"
    );
    // **两类行不参与「不在本次集合里就删」:**
    //
    // 1. 服务端专有行(ai2nao:*)。占位行从来不在客户端的消息集合里,按老规则每轮
    //    结束都会被删掉 —— 那样重复提交判定和崩溃恢复就永远查不到任何记录。
    // 2. **不在激活路径上的行(V61)。** 客户端只认识激活路径,其他分支它根本没见过;
    //    照老规则下一轮对话就会把它们全删光 —— 你点「重新生成」保住的那个旧答案,
    //    再说一句话就没了。
    const onPath = new Set(activePathIds(db, sessionId));
    for (const msg of existing) {
      if (isServerOnlyMessageId(msg.message_id)) continue;
      if (onPath.size > 0 && !onPath.has(msg.message_id)) continue;
      if (!incomingIds.has(msg.message_id)) del.run(sessionId, msg.message_id);
    }

    // **message_index 不再是客户端数组的下标,而是全局插入序(V61)。**
    //
    // 老做法是「先把所有行取负腾空,再按下标 0..N-1 重排」。有了分支之后它会撞车:
    // 其他分支的行还占着 0..N-1 里的某些号(它们曾经在激活路径上),
    // 而取负只腾得空激活路径那些 —— 插入时必然 UNIQUE(session_id, message_index) 冲突。
    //
    // 现在:已经在库里的沿用它自己的号,新来的取 max+1。路径顺序照样成立 ——
    // 孩子永远比父亲后插入,所以一条链上的号天然递增。
    const indexByMessageId = new Map(
      (
        db
          .prepare(
            `SELECT message_id, message_index FROM llm_chat_messages
             WHERE session_id = ? AND message_index < ?`
          )
          .all(sessionId, RUN_ROW_INDEX_BASE) as {
          message_id: string;
          message_index: number;
        }[]
      ).map((r) => [r.message_id, r.message_index])
    );
    let nextIndex = Math.max(-1, ...indexByMessageId.values()) + 1;
    for (const msg of normalized) {
      const known = indexByMessageId.get(msg.message_id);
      msg.message_index = known ?? nextIndex++;
    }

    const upsert = db.prepare(
      `INSERT INTO llm_chat_messages (
        id, session_id, message_id, message_index, role, raw_json, plain_text,
        preview, status, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(session_id, message_id) DO UPDATE SET
        message_index = excluded.message_index,
        role = excluded.role,
        raw_json = excluded.raw_json,
        plain_text = excluded.plain_text,
        preview = excluded.preview,
        status = excluded.status,
        updated_at = excluded.updated_at`
    );

    for (const msg of normalized) {
      upsert.run(
        `${sessionId}:${msg.message_id}`,
        sessionId,
        msg.message_id,
        msg.message_index,
        msg.role,
        msg.raw_json,
        msg.plain_text,
        msg.preview,
        msg.status,
        now,
        now
      );
    }

    // 树结构(V61)。客户端传来的这一串**就是**激活路径,所以:
    //  - 每条消息的父亲是它前面那条,第一条挂在根下
    //  - 只给**新行**写 parent —— 已有行的父子关系是分支结构本身,客户端不知道它,
    //    覆盖它就等于把树压平回一条线
    //  - 激活叶子指向最后一条
    // **客户端传来的这一串就是它主张的激活路径**,所以数组里每一条的 parent
    // 都按数组更新 —— 包括已经在库里的(它可能被重排了,老契约允许)。
    // 不在数组里的行**一律不动**:那些是其他分支,客户端根本没见过它们。
    const setTree = db.prepare(
      `UPDATE llm_chat_messages SET parent_id = ?, branch_index = ?
       WHERE session_id = ? AND message_id = ?`
    );
    let prevId: string | null = null;
    for (const msg of normalized) {
      const isNew = !indexByMessageId.has(msg.message_id);
      // 已有行沿用自己的兄弟序号;新行排在该父亲已有孩子的最后。
      const branch = isNew ? nextBranchIndexIn(db, sessionId, prevId) : 0;
      setTree.run(prevId, branch, sessionId, msg.message_id);
      prevId = msg.message_id;
    }
    if (prevId !== null) {
      db.prepare("UPDATE llm_chat_sessions SET active_leaf_message_id = ? WHERE id = ?").run(
        prevId,
        sessionId
      );
    }
  });
  tx();

  const detail = getLlmChatSession(db, sessionId);
  if (!detail) throw new LlmChatSessionError(500, "failed to reload session");
  return detail;
}

/**
 * 服务端产出消息的统一保存入口:**增量 upsert,不删任何行**。
 *
 * 与 `replaceLlmChatSessionMessages` 的差别就是「增量」二字:那个是整轮覆盖写
 * (客户端传什么就是什么,不在集合里的删掉),这个只往上加。一轮之内每个步骤都会
 * 调它一次,同一条消息被反复 upsert 是正常且幂等的 —— 行 id 由
 * `(sessionId, messageId)` 派生,重复写只会覆盖同一行,不会重复计费也不会重复落行。
 *
 * **不动已有行的 `message_index`。** 表上有 `UNIQUE(session_id, message_index)`,
 * 整轮覆盖写那条路径靠「先全部取负、再重排成 0..n-1」来腾挪;增量写没有那一步,
 * 碰已有索引必然撞唯一约束。所以已存在的保持原位,只有新 id 追加在最大值之后。
 */
export function persistGenerated(
  db: Database.Database,
  sessionId: string,
  messages: Message[]
): void {
  if (messages.length === 0) return;
  const now = new Date().toISOString();
  // index 要在事务里才能定(取决于库里已有多少行),这里先归一化,索引随后覆盖。
  const normalized = messages.map((raw, i) => normalizeAgUiMessage(raw, i, now));
  const rawBytes = normalized.reduce((sum, m) => sum + m.raw_json.length, 0);
  if (rawBytes > MAX_SYNC_RAW_BYTES) {
    throw new LlmChatSessionError(413, "session payload is too large");
  }

  db.transaction(() => {
    const existingRows = db
      .prepare(
        `SELECT message_id, message_index FROM llm_chat_messages
         WHERE session_id = ? AND message_id NOT LIKE ?`
      )
      .all(sessionId, `${SERVER_ONLY_MESSAGE_PREFIX}%`) as {
      message_id: string;
      message_index: number;
    }[];
    const existing = new Map(existingRows.map((r) => [r.message_id, r.message_index]));
    let nextIndex = existingRows.length === 0 ? 0 : Math.max(...existing.values()) + 1;

    const upsert = db.prepare(
      `INSERT INTO llm_chat_messages (
        id, session_id, message_id, message_index, role, raw_json, plain_text,
        preview, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, message_id) DO UPDATE SET
        role = excluded.role,
        raw_json = excluded.raw_json,
        plain_text = excluded.plain_text,
        preview = excluded.preview,
        status = excluded.status,
        updated_at = excluded.updated_at`
    );

    for (const msg of normalized) {
      const index = existing.get(msg.message_id) ?? nextIndex++;
      upsert.run(
        `${sessionId}:${msg.message_id}`,
        sessionId,
        msg.message_id,
        index,
        msg.role,
        msg.raw_json,
        msg.plain_text,
        msg.preview,
        msg.status,
        now,
        now
      );
    }

    // 树结构(V61):服务端产出的这一批接在**当前激活叶子**后面,并把叶子推过去。
    // 不做这件事,新写的 assistant 行没有 parent,会被激活路径直接过滤掉 ——
    // 消息落库了却不显示,而且是静默的。
    const setTree = db.prepare(
      `UPDATE llm_chat_messages SET parent_id = ?, branch_index = ?
       WHERE session_id = ? AND message_id = ? AND parent_id IS NULL`
    );
    let leaf = getActiveLeafId(db, sessionId);
    for (const msg of normalized) {
      if (existing.has(msg.message_id)) {
        // 已有行(同一轮里被反复 upsert)不重挂父亲,但它仍然是新的叶子。
        leaf = msg.message_id;
        continue;
      }
      setTree.run(leaf, nextBranchIndexIn(db, sessionId, leaf), sessionId, msg.message_id);
      leaf = msg.message_id;
    }
    if (leaf) {
      db.prepare("UPDATE llm_chat_sessions SET active_leaf_message_id = ? WHERE id = ?").run(
        leaf,
        sessionId
      );
    }

    // **标题与可见条数从库里全部行重算,不能只看这一批。** 每步落库时这一批
    // 往往只有一条 assistant 消息,按它算会把 message_count 一路清成 1。
    const allRows = db
      .prepare(
        `SELECT role, plain_text FROM llm_chat_messages
         WHERE session_id = ? AND message_id NOT LIKE ?
         ORDER BY message_index ASC`
      )
      .all(sessionId, `${SERVER_ONLY_MESSAGE_PREFIX}%`) as {
      role: string;
      plain_text: string;
    }[];
    const current = db
      .prepare("SELECT title FROM llm_chat_sessions WHERE id = ?")
      .get(sessionId) as { title: string } | undefined;
    // 沿用整轮覆盖写那条路径的优先级:自动标题压过库里存的。
    const title = autoTitle(allRows) ?? current?.title ?? "新对话";
    db.prepare(
      `UPDATE llm_chat_sessions
       SET title = ?, updated_at = ?, last_message_at = ?, message_count = ?
       WHERE id = ?`
    ).run(title, now, now, allRows.filter(isHumanVisibleMessage).length, sessionId);
  }).immediate();
}

/**
 * 超长的协议原文移进 blob,行里换成 `{ v: 1, blobSha256 }`。
 *
 * **与图片抽取同一个位置、同一个理由**:必须赶在 `JSON.stringify` 之前,
 * 否则体积闸看到的仍是整段原文。
 *
 * **写不成就原样留着,绝不两头落空** —— 这条照抄 `slimPartData` 的既有原则:
 * 宁可这一行大一点,也不能出现「原文剥了、blob 没写成」,那是不可逆的丢数据。
 * 协议原文的用途是逐字节回传给厂商,丢了就再也拼不回来。
 */
function spillProtocolToBlob(msg: Message): Message {
  const protocol = (msg as { ai2naoProtocol?: unknown }).ai2naoProtocol;
  if (!isRecord(protocol)) return msg;
  const content = protocol.content;
  if (typeof content !== "string" || content.length <= MAX_INLINE_PROTOCOL_CHARS) return msg;

  const ref = putBlob(Buffer.from(content, "utf8"), null);
  if (!ref) return msg;
  // **只改这一个字段,不用对象字面量重建整条消息。**
  // `Message` 是判别联合,`reasoning` 那一支是 "strip" 模式、只认
  // `{id, role, content, encryptedValue?}`,容不下 `ai2naoProtocol`;
  // 写成 `{...msg, ai2naoProtocol} as Message` 会触发多余属性检查而整个联合匹配不上
  // (TS2352)。TS 建议的 `as unknown as Message` 能过,但那是把整条消息的类型检查
  // 一起关掉 —— 将来少个 id、role 写错都没人提醒。逐字段赋值只让断言作用在这一个
  // 属性上,对象本身仍受检;`GeneratedMessages.setProtocol` 用的也是同一种写法。
  const out = { ...msg };
  (out as Message & { ai2naoProtocol?: unknown }).ai2naoProtocol = {
    v: 1,
    blobSha256: ref.sha256,
  };
  return out;
}

function normalizeAgUiMessage(raw: Message, index: number, now: string) {
  if (!raw || typeof raw !== "object") {
    throw new LlmChatSessionError(400, `message at index ${index} must be an object`);
  }
  const role = typeof raw.role === "string" ? raw.role : "";
  if (!AG_UI_ROLES.has(role)) {
    throw new LlmChatSessionError(
      400,
      `message at index ${index} has unsupported role ${String(raw.role)}`
    );
  }
  const msg = raw as Message & { id?: string; role: string };
  if (!msg.id?.trim()) {
    throw new LlmChatSessionError(400, `message at index ${index} is missing id`);
  }
  // **抽取必须在 stringify 之前。** 落库的是抽取后的形状,而 1.5 MB 上限
  // (MAX_SYNC_RAW_BYTES)是在本函数返回之后按 raw_json 长度累加的 —— 顺序对了,
  // 那道闸看到的就已经是短引用而不是 base64。
  const extracted = spillProtocolToBlob(extractInlineImages(msg, index));
  const rawJson = JSON.stringify(extracted);
  // 存库这一路要的是「这条消息有没有内容」,纯图消息必须算有;
  // 发给模型那一路要的是纯文本,两者语义相反,所以是两个函数。
  const plainText = previewTextFromAgUiMessage(extracted);
  const preview = previewForAgUiMessage(extracted, plainText);
  return {
    message_id: msg.id.trim(),
    message_index: index,
    role: msg.role,
    raw_json: rawJson,
    plain_text: plainText,
    preview,
    status: extractStatus(msg),
    created_at: now,
    updated_at: now,
  };
}

export function agUiMessagesFromSession(detail: LlmChatSessionDetail): Message[] {
  return detail.messages.map((row) => JSON.parse(row.raw_json) as Message);
}

/** 单条消息最多几张图。多图横向对比是真实用法,但没有理由一次几十张。 */
const MAX_IMAGES_PER_MESSAGE = 6;
/** 解码**之后**的字节上限。前端的 maxSize 是浏览器提示,不是边界。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 唯一允许的 url 源前缀 —— 我们自己的 blob 出口。 */
const BLOB_URL_PREFIX = "/api/blobs/";

type MediaSource = { type?: unknown; value?: unknown; mimeType?: unknown };
type MediaPart = { type?: unknown; source?: MediaSource; metadata?: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/**
 * 把消息里内联的图片抽进 blob 仓,正文换成 `/api/blobs/<sha>` 引用。
 *
 * **为什么必须在服务端做,而不是靠前端的 `onUpload`:** CopilotKit 的
 * `useAttachments` 里,`onUpload` 缺席时走的是
 * `source = { type: "data", value: await readFileAsBase64(file), mimeType }`,
 * 默认 `maxSize` 是 20 MB。也就是说前端一个配置失误,整个文件就 base64 进了消息。
 * 服务端不设防的话,后果是**模型已答完、钱已花完**之后落库才 413(那一行在 try 内)。
 *
 * **不要用 `parseDataUri`。** 它的第一行是 `startsWith("data:")`,而
 * `readFileAsBase64` 的文档注释写着 "string (without the data URL prefix)",
 * 实现是 `result.split(",")[1]` —— 拿到的是**裸 base64**。喂给 parseDataUri
 * 只会静默返回 null,抽取什么都不做,图永远内联。
 *
 * **写失败就不剥**(照抄 `slimPartData` 已验证的语义):宁可继续内联占地方,
 * 也不能出现「正文剥了、blob 没写成」那种两头落空的行。
 */
function extractInlineImages(msg: Message & { role: string }, index: number): Message {
  const content = "content" in msg ? msg.content : undefined;
  if (!Array.isArray(content)) return msg;

  let imageCount = 0;
  let changed = false;
  const out = content.map((part) => {
    if (!isRecord(part)) return part;
    const p = part as MediaPart;
    const kind = typeof p.type === "string" ? p.type : "";
    if (kind === "text") return part;

    // 只支持图片。音频/视频/文档没有任何一条下游路径能处理,留着只会撑爆载荷。
    if (kind === "audio" || kind === "video" || kind === "document" || kind === "binary") {
      throw new LlmChatSessionError(
        400,
        `message at index ${index}: 暂不支持 ${kind} 附件，目前只支持图片`
      );
    }
    if (kind !== "image") return part;

    imageCount += 1;
    if (imageCount > MAX_IMAGES_PER_MESSAGE) {
      throw new LlmChatSessionError(
        400,
        `message at index ${index}: 一条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图`
      );
    }

    const src = isRecord(p.source) ? (p.source as MediaSource) : null;
    if (!src) return part;

    // url 源:只认我们自己的 blob 出口。外部 URL 直接拒绝,**且绝不去取** ——
    // 本机应用能看见内网,替调用方发出站请求就是 SSRF。
    if (src.type === "url") {
      const value = typeof src.value === "string" ? src.value : "";
      if (!value.startsWith(BLOB_URL_PREFIX)) {
        throw new LlmChatSessionError(
          400,
          `message at index ${index}: 图片只能引用本机附件仓，不接受外部地址`
        );
      }
      return part;
    }

    if (src.type !== "data") return part;
    const b64 = typeof src.value === "string" ? src.value : "";
    if (!b64) return part;

    let bytes: Buffer;
    try {
      bytes = Buffer.from(b64, "base64");
    } catch {
      throw new LlmChatSessionError(400, `message at index ${index}: 图片数据无法解码`);
    }
    if (bytes.length === 0) {
      throw new LlmChatSessionError(400, `message at index ${index}: 图片数据无法解码`);
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new LlmChatSessionError(
        413,
        `message at index ${index}: 单张图片超过 ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MB`
      );
    }

    // 真实魔术字节必须与声明的 mime 对得上。对不上就是坏数据或伪装,
    // 白花一次钱换一个看不懂的报错不如当场拒。
    const sniffed = sniffImageMime(bytes);
    if (!sniffed) {
      throw new LlmChatSessionError(
        400,
        `message at index ${index}: 只支持 PNG / JPEG / WebP / GIF`
      );
    }
    const declared = typeof src.mimeType === "string" ? src.mimeType : "";
    if (declared && declared !== sniffed) {
      throw new LlmChatSessionError(
        400,
        `message at index ${index}: 图片实际类型是 ${sniffed}，与声明的 ${declared} 不符`
      );
    }

    const ref = putBlob(bytes, sniffed);
    if (!ref) return part; // 写不成就不剥 —— 绝不两头落空
    changed = true;
    return {
      ...part,
      source: { type: "url", value: `${BLOB_URL_PREFIX}${ref.sha256}`, mimeType: sniffed },
      metadata: {
        ...(isRecord(p.metadata) ? p.metadata : {}),
        sha256: ref.sha256,
        bytes: ref.bytes,
      },
    };
  });

  return changed ? ({ ...msg, content: out } as Message) : msg;
}

/**
 * 给**存库**用的文本:图片折成「[图片]」占位。
 *
 * 与 `textFromAgUiMessage` 分家,因为两个调用方要的东西相反 —— 存库要一个占位
 * 字符串好让预览、标题、`message_count` 都成立;发给模型要真正的 image part,
 * 收到字符串「[图片]」等于把占位符当正文发出去。
 * 合成一个函数正是「纯图消息被整条丢弃」那个 bug 的成因。
 */
export function previewTextFromAgUiMessage(message: Message): string {
  const content = "content" in message ? message.content : "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (part.type === "text") return typeof part.text === "string" ? part.text : "";
      if (part.type === "image") return "[图片]";
      return "";
    })
    .join("");
}

export function textFromAgUiMessage(message: Message): string {
  const content = "content" in message ? message.content : "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && part.type === "text") {
          return part.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function cleanSessionTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim().replace(/\s+/g, " ");
  if (!t) return null;
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
}

function autoTitle(messages: Array<{ role: string; plain_text: string }>): string | null {
  const user = messages.find((m) => m.role === "user" && m.plain_text.trim());
  return cleanSessionTitle(user?.plain_text ?? null);
}

function isHumanVisibleMessage(message: { role: string; plain_text: string }): boolean {
  return ["user", "assistant"].includes(message.role) && Boolean(message.plain_text.trim());
}

function previewForAgUiMessage(message: Message & { role: string }, plainText: string): string {
  if (message.role === "assistant" && "toolCalls" in message && message.toolCalls?.length) {
    const names = message.toolCalls
      .map((call) => call.function?.name)
      .filter((name): name is string => Boolean(name))
      .slice(0, 3);
    return names.length > 0 ? `[tool call] ${names.join(", ")}` : "[tool call]";
  }

  if (message.role === "tool") {
    return previewToolContent("content" in message ? message.content : "");
  }

  if (message.role === "activity") return "[activity]";
  if (message.role === "reasoning") return "[reasoning]";
  return previewText(plainText);
}

function previewToolContent(content: unknown): string {
  if (typeof content !== "string" || !content.trim()) return "[tool result]";
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object") {
      const rec = parsed as Record<string, unknown>;
      const kind = typeof rec.kind === "string" ? rec.kind : "tool result";
      const source = typeof rec.source === "string" ? rec.source : null;
      const evidence = Array.isArray(rec.evidence) ? rec.evidence : [];
      if (kind === "evidence") {
        return `[evidence] ${source ? `${source} · ` : ""}${evidence.length} result${evidence.length === 1 ? "" : "s"}`;
      }
      if (kind === "evidence_error") {
        const code = typeof rec.code === "string" ? rec.code : "error";
        return `[evidence error] ${source ? `${source} · ` : ""}${code}`;
      }
    }
  } catch {
    // Plain text tool results still get a compact preview.
  }
  return previewText(content) || "[tool result]";
}

function previewText(value: string): string {
  const t = value.trim().replace(/\s+/g, " ");
  return t.length > PREVIEW_LEN ? `${t.slice(0, PREVIEW_LEN - 3)}...` : t;
}

function extractStatus(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const status = (raw as Record<string, unknown>).status;
  if (typeof status === "string") return status;
  if (status && typeof status === "object") {
    const type = (status as Record<string, unknown>).type;
    return typeof type === "string" ? type : null;
  }
  return null;
}

// ---------- 消息树:重新生成 / 编辑重发 / 分支切换(V61)----------

/**
 * 消息从线性变成树之后,「这场会话有哪些消息」这个问题有了两个答案:
 * 库里的**全部**节点,和当前**激活路径**上的那些。
 *
 * 发给模型的上下文、界面上看到的对话、压缩的作用域,**三者都只认激活路径** ——
 * 模型看不见你切走的那条分支,界面也不该显示它。
 *
 * `activity` 行(index >= 1e6:run / 账目 / 工具执行 / 压缩)不在树上,
 * 它们旁挂在会话上,`parent_id` 恒为 null。
 */

/** 普通消息与 activity 行的分界。与 sessions.ts 顶部那几个保留段常量同源。 */
const TREE_INDEX_CEILING = RUN_ROW_INDEX_BASE;

export type ChatTreeNode = {
  messageId: string;
  parentId: string | null;
  branchIndex: number;
  messageIndex: number;
};

function treeNodes(db: Database.Database, sessionId: string): ChatTreeNode[] {
  return db
    .prepare(
      `SELECT message_id AS messageId, parent_id AS parentId,
              branch_index AS branchIndex, message_index AS messageIndex
       FROM llm_chat_messages
       WHERE session_id = ? AND message_index < ?
       ORDER BY message_index ASC`
    )
    .all(sessionId, TREE_INDEX_CEILING) as ChatTreeNode[];
}

export function getActiveLeafId(db: Database.Database, sessionId: string): string | null {
  const row = db
    .prepare("SELECT active_leaf_message_id AS leaf FROM llm_chat_sessions WHERE id = ?")
    .get(sessionId) as { leaf: string | null } | undefined;
  return row?.leaf ?? null;
}

/**
 * 从激活叶子回溯到根,返回**时序**的 message_id。
 *
 * 防环:同一个仓库的 cherryStudioHistory/db.ts 里有同样一条 —— 树是我们自己写的,
 * 不该产生环,但一个坏 parent 指针就能让这里挂住整个请求。见过的节点直接停。
 *
 * 没有 active_leaf(老会话刚迁移完、或一条消息都没有)时回退到**按 message_index 平铺**:
 * 那正是 V61 之前的行为,也是「只有一条路径」时的正确答案。
 */
export function activePathIds(db: Database.Database, sessionId: string): string[] {
  const nodes = treeNodes(db, sessionId);
  if (nodes.length === 0) return [];
  const leaf = getActiveLeafId(db, sessionId);
  if (!leaf) {
    // 回退到平铺**只对没有树的老会话**成立(V61 之前的库,或迁移时一条消息都没有)。
    // 一旦有任何一条行挂了 parent,这棵树就是成立的,而「叶子为空」就真的是空路径 ——
    // 编辑首问时会短暂处于这个状态。此时平铺会把**所有分支**一起返回,那是错的。
    return nodes.some((n) => n.parentId !== null) ? [] : nodes.map((n) => n.messageId);
  }
  const byId = new Map(nodes.map((n) => [n.messageId, n]));
  const path: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = leaf;
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    path.push(node.messageId);
    cursor = node.parentId;
  }
  return path.reverse();
}

/**
 * 某条消息在它那一组兄弟里的位置。
 *
 * 界面上的 `‹ 1/2 ›` 挂在 **user** 消息上(CopilotKit 的分支导航只有 UserMessage 有),
 * 但它要数的是「这个问题有几个回答」——所以调用方传的是那条 user 的**孩子**里
 * 当前激活的那个。语义掰这一下是有意的,见设计讨论 Q4。
 */
export function branchPosition(
  db: Database.Database,
  sessionId: string,
  messageId: string
): { branchIndex: number; numberOfBranches: number } {
  const nodes = treeNodes(db, sessionId);
  const self = nodes.find((n) => n.messageId === messageId);
  if (!self) return { branchIndex: 0, numberOfBranches: 1 };
  const siblings = nodes
    .filter((n) => n.parentId === self.parentId)
    .sort((a, b) => a.branchIndex - b.branchIndex || a.messageIndex - b.messageIndex);
  const idx = siblings.findIndex((n) => n.messageId === messageId);
  return { branchIndex: idx < 0 ? 0 : idx, numberOfBranches: siblings.length };
}

/** 同一 parent 下的兄弟,按 branch_index 排序。切换分支时按序号取。 */
export function siblingIds(
  db: Database.Database,
  sessionId: string,
  parentId: string | null
): string[] {
  return treeNodes(db, sessionId)
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => a.branchIndex - b.branchIndex || a.messageIndex - b.messageIndex)
    .map((n) => n.messageId);
}

/** 某个节点往下、沿每组兄弟里**当前激活**那条走到底;没有激活标记时取第一个。 */
export function deepestLeafFrom(
  db: Database.Database,
  sessionId: string,
  messageId: string
): string {
  const nodes = treeNodes(db, sessionId);
  const byParent = new Map<string | null, ChatTreeNode[]>();
  for (const n of nodes) {
    const list = byParent.get(n.parentId) ?? [];
    list.push(n);
    byParent.set(n.parentId, list);
  }
  const seen = new Set<string>();
  let cursor = messageId;
  for (;;) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const kids = (byParent.get(cursor) ?? []).sort(
      (a, b) => a.branchIndex - b.branchIndex || a.messageIndex - b.messageIndex
    );
    if (kids.length === 0) break;
    cursor = kids[kids.length - 1]!.messageId; // 最新的那条兄弟
  }
  return cursor;
}

/** 切换激活路径。只改会话上的一个指针,不动任何消息行。 */
export function setActiveLeaf(db: Database.Database, sessionId: string, messageId: string): void {
  const info = db
    .prepare("UPDATE llm_chat_sessions SET active_leaf_message_id = ? WHERE id = ?")
    .run(messageId, sessionId);
  if (info.changes === 0) throw new LlmChatSessionError(404, "session not found");
}

/** 事务内用的轻量版,与 nextBranchIndex 同义。 */
function nextBranchIndexIn(
  db: Database.Database,
  sessionId: string,
  parentId: string | null
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(branch_index), -1) + 1 AS next FROM llm_chat_messages
       WHERE session_id = ? AND message_index < ?
         AND (parent_id IS ? OR parent_id = ?)`
    )
    .get(sessionId, TREE_INDEX_CEILING, parentId, parentId) as { next: number };
  return row.next;
}

/** 下一个兄弟序号。新分支永远排在最后。 */
export function nextBranchIndex(
  db: Database.Database,
  sessionId: string,
  parentId: string | null
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(branch_index), -1) + 1 AS next FROM llm_chat_messages
       WHERE session_id = ? AND message_index < ?
         AND (parent_id IS ? OR parent_id = ?)`
    )
    .get(sessionId, TREE_INDEX_CEILING, parentId, parentId) as { next: number };
  return row.next;
}

/** 一次分支操作的三种意图。三者的区别只有一个:把激活叶子移到哪。 */
export type BranchAction = "switch" | "regenerate" | "edit";

export type BranchResult = {
  activeLeafMessageId: string;
  activePathIds: string[];
  /** 移动之后是否需要客户端重新发起一轮(重新生成 / 编辑重发都要)。 */
  needsRun: boolean;
};

function parentOf(db: Database.Database, sessionId: string, messageId: string): string | null {
  const row = db
    .prepare(
      `SELECT parent_id AS parentId FROM llm_chat_messages
       WHERE session_id = ? AND message_id = ?`
    )
    .get(sessionId, messageId) as { parentId: string | null } | undefined;
  if (!row) throw new LlmChatSessionError(404, "message not found");
  return row.parentId;
}

/**
 * 分支操作。**服务端拥有树的语义,客户端只说意图。**
 *
 *   switch     切到某条兄弟 → 沿它往下走到底,那条路径成为激活路径
 *   regenerate 重新生成某条回答 → 叶子退回它的**父亲**(那条提问),再跑一轮就长出兄弟
 *   edit       编辑某条提问 → 叶子退回它的父亲,新提问就成了同一层的兄弟
 *
 * 后两者都不在这里发起模型调用 —— 移动叶子之后由客户端正常发一轮,
 * 新消息自然挂在新叶子下面(persistGenerated 就是这么接的)。
 * 这样重新生成与编辑重发**复用了完全相同的那条发送路径**,没有第二套运行时。
 */
export function applyBranchAction(
  db: Database.Database,
  sessionId: string,
  action: BranchAction,
  messageId: string
): BranchResult {
  const exists = db
    .prepare("SELECT 1 FROM llm_chat_sessions WHERE id = ?")
    .get(sessionId);
  if (!exists) throw new LlmChatSessionError(404, "session not found");

  let leaf: string | null;
  if (action === "switch") {
    leaf = deepestLeafFrom(db, sessionId, messageId);
  } else {
    // 退到父亲。父亲是 null 表示它本身就是首问 —— 那么新分支挂在根下,
    // 激活叶子暂时清空,下一轮的第一条消息会成为新的根级兄弟。
    leaf = parentOf(db, sessionId, messageId);
  }

  if (leaf) setActiveLeaf(db, sessionId, leaf);
  else db.prepare("UPDATE llm_chat_sessions SET active_leaf_message_id = NULL WHERE id = ?").run(sessionId);

  return {
    activeLeafMessageId: leaf ?? "",
    activePathIds: activePathIds(db, sessionId),
    needsRun: action !== "switch",
  };
}
