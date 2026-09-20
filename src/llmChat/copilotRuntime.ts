import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { z } from "zod";
import { readCachedCatalog } from "../cost/modelCatalog.js";
import {
  chunkTurnsForSummary,
  type SummaryTurn,
} from "./compactionChunker.js";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  AbstractAgent,
  EventType,
  type AgentCapabilities,
  type BaseEvent,
  type Context,
  type Message,
} from "@ag-ui/client";
import {
  stepCountIs,
  streamText,
  wrapLanguageModel,
  type LanguageModelMiddleware,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { Observable } from "rxjs";
import type {
  AgentRunner,
  AgentRunnerConnectRequest,
  AgentRunnerIsRunningRequest,
  AgentRunnerRunRequest,
  AgentRunnerStopRequest,
  CopilotRuntimeFetchHandler,
} from "@copilotkit/runtime/v2";
import {
  llmChatStatus,
  readLlmChatDocument,
  selectModelForTurn,
  type LlmChatConfig,
  type ModelSelection,
} from "./config.js";
import { loadPriceMap } from "../cost/priceStore.js";
import { PROVIDER_ADAPTER_CAPABILITIES, type LlmChatProvider } from "./document.js";
import { stampModelSnapshot } from "./modelStamp.js";
import { splitThinkBlocks, ThinkStreamFilter } from "./normalizeResponse.js";
import { createChatLanguageModel, type ChatLanguageModel } from "./model.js";
import { llmChatLog } from "./log.js";
import { getBlob, imageDimensions } from "../blobStore.js";
import {
  defaultBashApprovalStore,
  type BashApprovalStore,
  type BashPermissionRuleStore,
  type BashToolService,
} from "../bashTool/index.js";
import type { CodeRunnerService } from "../codeRunner/index.js";
import type { SessionMemoryService } from "../sessionMemory/index.js";
import type { WebSearchService } from "../webSearch/service.js";
import {
  buildAi2NaoServerTools,
  parseForwardedToolProps,
  type BashExecRecorder,
} from "../llmTools/index.js";
import {
  activeCompaction,
  agUiMessagesFromSession,
  claimChatRun,
  completeChatRun,
  ensureLlmChatSession,
  finishChatCall,
  finishChatToolExec,
  findEstimateBaseline,
  insertPendingChatCall,
  getLlmChatSession,
  isChatRunCurrent,
  isServerOnlyMessageId,
  readSessionCompactionSettings,
  activateChatCompaction,
  compactionDividerMessageId,
  readChatCompactionEvents,
  replayCompactionStack,
  revertChatCompaction,
  estimateChatCallCostUsd,
  settlePendingChatCalls,
  listChatCalls,
  listChatToolExecs,
  markStaleToolExecsUnknown,
  persistGenerated,
  renewChatRunLease,
  startChatToolExec,
  textFromAgUiMessage,
  RUN_LEASE_RENEW_MS,
  type ChatCall,
  type ChatCallPurpose,
  type SessionContextView,
  type ChatCallUsage,
  type ChatRun,
  type ChatCompaction,
  type SendView,
} from "./sessions.js";

export type LlmChatCopilotRuntimeDeps = {
  db: Database.Database;
  ragDb?: Database.Database;
  webSearch?: WebSearchService;
  sessionMemory?: SessionMemoryService;
  codeRunner?: CodeRunnerService;
  bashTool?: BashToolService;
  bashApprovalStore?: BashApprovalStore;
  bashPermissionRules?: BashPermissionRuleStore;
  /**
   * 模型工厂注入口。**只给测试用**,生产不传就走真实适配器。
   *
   * 为什么需要它:现有测试把整个 `streamText` 换成假函数,于是记账中间件
   * (`wrapStream`)与步骤闸门(`prepareStep`)一次都不会执行 —— 那两处写再多
   * 测试也是假绿。换成注入最底层的假模型,真实 `streamText` 就会跑起来,
   * 中间件和闸门才真正被走到。
   *
   * **注入点在 `wrapLanguageModel` 的内层**:换掉的是被包装的模型本身,
   * 记账中间件仍然包在外面。插到外层就会把中间件一起绕过去,而测试照样绿。
   */
  createModel?: (cfg: LlmChatConfig) => ChatLanguageModel;
};

type AgentInput = {
  threadId: string;
  runId?: string;
  messages: Message[];
  tools: unknown[];
  context: Context[];
  state: unknown;
  forwardedProps: unknown;
};

type ToolCallState = {
  id: string;
  name: string;
  args: string;
  started: boolean;
  hasArgsDelta: boolean;
  ended: boolean;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type ToolResultOutputForPrompt =
  | { type: "text"; value: string }
  | { type: "json"; value: JsonValue };

type DsmlTextToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type AiSdkStreamToAgUiOptions = {
  executeTextToolCall?: (call: DsmlTextToolCall) => Promise<unknown>;
  /**
   * 每个模型步骤结束时调用 —— 落库挂在这里。
   *
   * 放在生成器内部而不是消费循环里,是因为消费循环看不到 `finish-step`:
   * 它此前被整个吞掉(`case "finish-step": break;`)。到达这一句时,本步骤先前
   * yield 出去的事件都已经被消费方 apply 过了,所以此刻的累积集合是完整的。
   */
  onStepFinish?: () => void | Promise<void>;
  /**
   * 本步的稳定键 `${runId}:${purpose}:${stepIndex}`。
   *
   * 有它时消息 id 按步派生(assistant = `a:${stepKey}`,思考 = `r:${stepKey}`),
   * 只有思考或只有工具调用的步骤也因此有稳定 id。**做成回调而不是值**:
   * 一次 `streamText` 会跑多步,而这个生成器从头到尾只被调用一次 ——
   * 传值的话第二步之后全是第一步的号。与记账中间件的 `stepIndex: () => number`
   * 同一套路。不传时回落随机 id,补答那条路(不传 options)因此照旧能跑。
   */
  stepKey?: () => string | null;
  /**
   * 本步**未经过滤**的正文原文(含 `<think>` 与原始空白),在 text-end 回报一次。
   *
   * 回传给 MiniMax 要的是这一份,不是剥离后的展示文本 —— 官方 M3 工具调用指南
   * 写明 OpenAI 格式下不得修改 content,历史里的 `<think>…</think>` 必须完整保留。
   * 从展示文本重新拼一份是做不到逐字节一致的(trim、标签、空白都已经没了)。
   */
  onProtocolText?: (messageId: string, raw: string) => void;
  /**
   * 一条思考消息收尾时,回报生成器这一侧知道的三样。
   *
   * **只报生成器知道的,不报 callId。** callId 由 provider 的 `finish` 分片触发中间件
   * 结算才产生,而这个回调发生在 text-end —— SDK 层的 text-end 远早于 provider 的
   * finish。实测顺序是 `settle(completed)` → `finish-step`,所以补 callId 要等到
   * `onStepFinish`,不能在这里就地填。
   */
  onReasoning?: (reasoningMessageId: string, meta: ReasoningStreamMeta) => void;
};

/** 生成器能观测到的思考元数据。其余字段(runId / provider / callId)由轮补齐。 */
export type ReasoningStreamMeta = {
  assistantMessageId: string;
  source: "reasoning-stream" | "think-tag";
  /** 服务端观测到的思考流时长,不是厂商字段。 */
  durationMs: number;
};

const runningThreadIds = new Set<string>();
const runningThreadStops = new Map<string, () => void>();
const MAX_TOOL_LOOP_STEPS = 6;
/** 见 `/api/copilotkit` 注册处的注释:按 base64 膨胀后的体积算,不是二进制图大小。 */
const COPILOTKIT_MAX_BODY_BYTES = 48 * 1024 * 1024;

/**
 * 输出预留的兜底与上限(token)。models.dev 没给 `limit.output` 时用兜底值。
 * 全仓库此前没有同类常量,所以在这里新建 —— 与 `MAX_TOOL_LOOP_STEPS` 同处安放。
 */
/** 省略旧工具结果时替代正文的占位。**不是合法 JSON**,否则会被当成结构化输出。 */
const TOOL_RESULT_OMITTED = "[这一步的工具结果较早,为控制上下文长度未重复发送]";

/**
 * 字符 → token 的估算:**按字符类别**各用一个系数(每 token 的字符数)。
 *
 * 2026-09-19 用真实请求校准:DeepSeek V4 flash 与 MiniMax-M3 各一遍,中文 / 英文 / 代码 /
 * JSON / 中英混排各 3000 字符,扣掉「一个字」的基线开销。实测 字符/token(两家):
 * 中文 1.66 / 1.68、英文 5.04 / 5.24、代码 3.72 / 3.78、JSON 2.61 / 2.68、混排 2.41 / 2.67。
 * 原先的单一系数 2 在中文上**少估 17%**(该拦的没拦,请求打到厂商才被拒),在英文上多估 2.5 倍。
 *
 * 下面这组在 5 类样本上**一类都不少估**,最坏多估 25%(在网格里取「不少估」约束下最坏
 * 多估最小的那组)。**宁可高估**的理由不变:少估的后果是超窗请求被厂商拒掉。
 * 空白不计:BPE 通常把空格并进相邻的词。数字与标点按 1 字符 1 token,拿不准的字符同此。
 */
const CHARS_PER_TOKEN_BY_CLASS = { cjk: 1.4, alpha: 3.7, digit: 1, other: 1 } as const;

/**
 * 把 token 预算换算成字符预算时用的系数(分块等只认字符的地方)。取各类里**最密的常见
 * 正文**(中文)—— 按它换算出来的字符数,无论实际是什么内容都不会超出 token 预算太多。
 */
const CONSERVATIVE_CHARS_PER_TOKEN = CHARS_PER_TOKEN_BY_CLASS.cjk;

/** 估算一段文本的 token 数(浮点,调用方在汇总后再取整)。导出供校准回归测试用。 */
export function estimateTextTokens(text: string): number {
  let cjk = 0;
  let alpha = 0;
  let digit = 0;
  let other = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 10 || c === 13 || c === 9) continue;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) alpha += 1;
    else if (c >= 48 && c <= 57) digit += 1;
    else if (
      (c >= 0x3000 && c <= 0x30ff) || // CJK 标点、平假名、片假名
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0xac00 && c <= 0xd7af) || // 韩文
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xff00 && c <= 0xffef) // 全角
    ) cjk += 1;
    else other += 1;
  }
  const k = CHARS_PER_TOKEN_BY_CLASS;
  return cjk / k.cjk + alpha / k.alpha + digit / k.digit + other / k.other;
}

/**
 * 一张图的 token:**按像素计**,每 750 像素 1 个。2026-09-19 实测 512×512 / 1600×1000:
 * DeepSeek V4 flash 184 / 962、MiniMax-M3 326 / 2054(约 780 像素 1 个)—— 随面积线性增长,
 * 固定估值在大图上会少估数倍。750 取两家里更贵的那家再留一点余量。
 * 读不出尺寸(不在四种格式白名单里)时退回固定估值。
 */
const IMAGE_PIXELS_PER_TOKEN = 750;
const IMAGE_TOKEN_FALLBACK = 1_500;

export function estimateImageTokens(image: unknown): number {
  const bytes = Buffer.isBuffer(image) ? image : image instanceof Uint8Array ? Buffer.from(image) : null;
  const dims = bytes ? imageDimensions(bytes) : null;
  return dims ? Math.ceil((dims.width * dims.height) / IMAGE_PIXELS_PER_TOKEN) : IMAGE_TOKEN_FALLBACK;
}

const DEFAULT_OUTPUT_RESERVE = 8192;
const MAX_OUTPUT_RESERVE = 32768;

/**
 * 输出预留 = `min(limit.output ?? 8K, 32K)`,**同时**作为 `maxOutputTokens`
 * 传给 `streamText`。
 *
 * 两处必须是同一个数。各取各的会造出「预算按 8K 扣、模型却获准吐 32K」这种
 * 超窗 —— 而它不报错,只是某天请求被厂商拒掉。
 *
 * 窗口挂在目录缓存的 `pricing` 里(与分段价同一个对象,见 `ModelTieredPrice.limit`),
 * 所以**没有价格条目的模型也就没有窗口**,那时退回兜底值。取用路径与
 * `sessions.ts` 读分段价那处逐字一致。
 */
function outputReserveFor(model: { provider: string; model: string } | null): number {
  const out = model
    ? readCachedCatalog()?.pricing?.[model.provider]?.[model.model]?.limit?.output
    : undefined;
  const base = typeof out === "number" && out > 0 ? out : DEFAULT_OUTPUT_RESERVE;
  return Math.min(base, MAX_OUTPUT_RESERVE);
}

/**
 * 模型的上下文窗口。取不到时返回 null —— 调用方据此退回保守默认并标「估算」,
 * **不要当成 0 或无穷**。窗口与分段价同挂在 `ModelTieredPrice` 上,所以没有价格
 * 条目的模型也就没有窗口。
 */
function contextWindowFor(model: { provider: string; model: string } | null): number | null {
  const ctx = model
    ? readCachedCatalog()?.pricing?.[model.provider]?.[model.model]?.limit?.context
    : undefined;
  return typeof ctx === "number" && ctx > 0 ? ctx : null;
}

/**
 * 估算这次请求的输入 token。
 *
 * **字符来源直接取 `ModelMessage[]`** —— 那本来就是要发出去的内容。从 AG-UI 消息
 * 再推一遍等于把同一个概念编码两处,而两处迟早漂移。
 *
 * 工具定义按**名字 + description** 近似,不做 JSON Schema 序列化:
 * `Schema.jsonSchema` 的类型是 `JSONSchema7 | PromiseLike<JSONSchema7>`(可能是
 * Promise),为一个本来就乘着未校准系数的数字引入异步不划算;而工具集在一轮内恒定。
 * 这是**有意的近似**,与系数一起待校准。
 */
function estimateBreakdown(args: {
  messages: ModelMessage[];
  /** 系统提示本体,**不含摘要** —— 摘要要单独成项,拼在一起就拆不开了。 */
  basePrompt: string;
  compactionBlock: string | null;
  tools: Record<string, { description?: string }>;
}): SessionContextView["breakdown"] & { total: number } {
  let systemTok = estimateTextTokens(args.basePrompt);
  for (const [name, t] of Object.entries(args.tools)) {
    systemTok += estimateTextTokens(name) + (typeof t?.description === "string" ? estimateTextTokens(t.description) : 0);
  }
  let recentTok = 0;
  let toolTok = 0;
  let imageTokens = 0;
  for (const m of args.messages) {
    const isTool = (m as { role?: unknown }).role === "tool";
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") {
      if (isTool) toolTok += estimateTextTokens(content);
      else recentTok += estimateTextTokens(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as { type?: unknown; text?: unknown; input?: unknown; output?: unknown; image?: unknown };
      if (p.type === "image") {
        imageTokens += estimateImageTokens(p.image);
        continue;
      }
      if (typeof p.text === "string") {
        if (isTool) toolTok += estimateTextTokens(p.text);
        else recentTok += estimateTextTokens(p.text);
      }
      // 工具调用的入参与结果也要计入 —— 它们常常比正文还长,所以单列一项。
      if (p.input !== undefined) toolTok += estimateTextTokens(JSON.stringify(p.input) ?? "");
      if (p.output !== undefined) toolTok += estimateTextTokens(JSON.stringify(p.output) ?? "");
    }
  }
  const system = Math.ceil(systemTok);
  const summary = Math.ceil(estimateTextTokens(args.compactionBlock ?? ""));
  const recent = Math.ceil(recentTok);
  const toolResults = Math.ceil(toolTok);
  return {
    system,
    summary,
    recent,
    toolResults,
    images: imageTokens,
    // **总数就是分项之和。** 另算一遍总数的话,它与分项会差几个 token ——
    // 界面上「四项加起来对不上」,而且不报错。
    total: system + summary + recent + toolResults + imageTokens,
  };
}

/**
 * 估算这次请求的输入 token。**委托给分项统计**,两处各算一遍迟早漂移。
 *
 * **字符来源直接取 `ModelMessage[]`** —— 那本来就是要发出去的内容。从 AG-UI 消息
 * 再推一遍等于把同一个概念编码两处。
 *
 * 工具定义按**名字 + description** 近似,不做 JSON Schema 序列化:
 * `Schema.jsonSchema` 可能是 Promise,为一个本来就乘着未校准系数的数字引入异步
 * 不划算;而工具集在一轮内恒定。这是**有意的近似**,与系数一起待校准。
 */
function estimatedInputTokens(
  messages: ModelMessage[],
  systemPrompt: string,
  tools: Record<string, { description?: string }>
): number {
  return estimateBreakdown({ messages, basePrompt: systemPrompt, compactionBlock: null, tools }).total;
}

/**
 * 估算本次请求的输入 token。
 *
 * **优先用基准账目**:同模型、同 system/tools、且本次前 `count` 条的前缀哈希与它
 * 相同的最近一笔 `answer`。估算 = 基准 `usage.input` + 其后新增内容的字符估算。
 * 这比全量估算准得多 —— 前缀那部分用的是厂商**实际报回**的数字。
 *
 * 没有可比基准(新会话、换了模型、改了工具开关、历史被改动)就退回全量估算。
 */
function estimateInputForRequest(
  db: Database.Database,
  sessionId: string,
  args: {
    modelMessages: ModelMessage[];
    viewEntries: SendViewEntry[];
    systemPrompt: string;
    tools: Record<string, { description?: string }>;
    model: { provider: string; model: string; label: string } | null;
  }
): { tokens: number; basedOn: "baseline" | "full" } {
  const view = sendViewOf(args.viewEntries, args.systemPrompt, args.tools);
  const baseline = findEstimateBaseline(db, sessionId, {
    model: args.model,
    systemHash: view.systemHash,
    toolsHash: view.toolsHash,
    prefixHashOfFirst: (count) =>
      count >= 0 && count <= args.viewEntries.length
        ? prefixHashOf(args.viewEntries.slice(0, count))
        : null,
  });
  const basedOnCount = baseline?.sendView?.count;
  if (baseline && typeof baseline.usage?.input === "number" && typeof basedOnCount === "number") {
    // 只估「新增的那几条」。system 与 tools 已经含在基准的 input 里,
    // 这里再加一遍就是重复计。
    const added = args.modelMessages.slice(basedOnCount);
    return {
      tokens: baseline.usage.input + estimatedInputTokens(added, "", {}),
      basedOn: "baseline",
    };
  }
  return {
    tokens: estimatedInputTokens(args.modelMessages, args.systemPrompt, args.tools),
    basedOn: "full",
  };
}

/** 摘要输出的结构。**校验失败即压缩失败** —— 结构不对的摘要还不如不压。 */
const summarySchema = z.object({
  decisions: z.array(z.string()),
  constraints: z.array(z.string()),
  state: z.array(z.string()),
  nextSteps: z.array(z.string()),
});

/**
 * 摘要**本身**的篇幅上限(规格:2K token),写进提示词里约束模型。
 *
 * **不能直接当 `maxOutputTokens` 用。** 推理模型的思考也算在输出额度里:2026-09-19 真实
 * DeepSeek V4 flash 实测,2048 的额度被约 6900 字符的思考全部用完,`finish_reason=length`,
 * 正文一个字都没有 —— 摘要失败,压缩永远做不成。请求的额度见 `summaryRequestMaxTokens`。
 */
const SUMMARY_MAX_OUTPUT_TOKENS = 2_048;

/**
 * 「约 $X」预估里每块摘要按多少输出 token 算(**含思考**)。2026-09-19 实测两家、两段对话:
 * MiniMax-M3 441–690,DeepSeek V4 flash 802–3949(思考占大头)。取 4096,站在高估一侧。
 * 它只用于预估,不限制请求 —— 请求额度见下面。
 */
const SUMMARY_EXPECTED_OUTPUT_TOKENS = 4_096;

/** 摘要请求的输出额度:给思考留足空间,与正常回答同一个口径(输出预留)。 */
function summaryRequestMaxTokens(model: { provider: string; model: string } | null): number {
  return Math.max(SUMMARY_MAX_OUTPUT_TOKENS, outputReserveFor(model));
}
/** 每个分块不超过摘要模型窗口的 60%(规格)。 */
const SUMMARY_CHUNK_WINDOW_RATIO = 0.6;

/** 自动压缩的触发阈值(规格:估算超过 窗口 × 0.9)。**与阶梯第 1 步的判据不同**。 */
const AUTO_COMPACT_RATIO = 0.9;
/** 自动压缩保留最近几个用户轮不折叠。与阶梯第 1 步省略工具结果的边界取同一个数。 */
const AUTO_COMPACT_KEEP_TURNS = 3;

/**
 * 从**持久化行**里取「倒数第 N 个用户轮」的 `message_index`,作为折叠上界。
 *
 * **必须用 `message_index`,不能用 `mergedMessages` 的数组下标。** 两者顺序一致但
 * 数值不等:`persistGenerated` 是「取现有最大值 + 1」追加分配,已有行的下标不变,
 * 于是值有偏移、也可能有空洞。混用会折叠到错误的位置,而且不报错。
 *
 * 不足 N 个用户轮时返回 null —— 没什么可折叠的。
 */
function userTurnCutoffFromRows(
  rows: Array<{ message_id: string; message_index: number; role: string }>,
  keepTurns: number
): number | null {
  const userIdx: number[] = [];
  for (const r of rows) {
    if (isServerOnlyMessageId(r.message_id)) continue;
    if (r.role === "user") userIdx.push(r.message_index);
  }
  if (userIdx.length <= keepTurns) return null;
  return userIdx[userIdx.length - keepTurns]!;
}

/**
 * 从库里取出被折叠区间的轮次。思考与协议原文**不进摘要**(规格明写)。
 */
function summaryTurnsBefore(
  db: Database.Database,
  sessionId: string,
  folded: ReadonlySet<string>
): SummaryTurn[] {
  const detail = getLlmChatSession(db, sessionId);
  if (!detail) return [];
  const turns: SummaryTurn[] = [];
  let turnNo = 0;
  for (const row of detail.messages) {
    if (isServerOnlyMessageId(row.message_id)) continue;
    if (row.role === "reasoning") continue; // 思考不进摘要
    if (row.role === "user") turnNo += 1;
    if (!folded.has(row.message_id)) continue;
    if (row.role !== "user" && row.role !== "assistant" && row.role !== "tool") continue;
    let text = "";
    try {
      text = textFromAgUiMessage(JSON.parse(row.raw_json) as Message).trim();
    } catch {
      continue;
    }
    if (!text) continue;
    if (row.role === "user" || turns.length === 0) {
      turns.push({ turn: turnNo, messages: [{ role: row.role, text }] });
    } else {
      turns[turns.length - 1]!.messages.push({ role: row.role, text });
    }
  }
  return turns;
}

/**
 * **恢复这个会话实际在用的模型。**
 *
 * 规格说「摘要默认用当前会话模型」。但模型是每轮从 `forwardedProps.modelId` 选的,
 * 不存在会话行上 —— 手动压缩这条路由没有 forwardedProps,直接调
 * `selectModelForTurn(doc, null)` 会落到**文档默认模型**:用户整场在用 A,压缩却发给 B,
 * 费用记在 B、数据也去了 B,而且不报错。这与运行路径上「不可用就报错,绝不静默换家」
 * 是同一条规矩,必须一样守。
 *
 * 做法:取最后一笔 `answer` 账目里的模型快照,按它的 `modelId` 重新选,**再核对
 * provider + model 与快照一致**。快照注释明写实例 id 可被复用,所以只按 id 解析不够。
 */
function selectSessionModel(db: Database.Database, sessionId: string): ModelSelection {
  const calls = listChatCalls(db, sessionId);
  let last: { modelId: string; provider: string; model: string } | null = null;
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const c = calls[i]!;
    if (c.purpose === "answer" && c.model) {
      last = c.model;
      break;
    }
  }
  if (!last) {
    return { ok: false, reason: "not-configured", message: "这个会话还没有任何一次模型调用，无法判断该用哪个模型压缩。" };
  }
  const selection = selectModelForTurn(readLlmChatDocument(), last.modelId);
  if (!selection.ok) return selection;
  if (selection.snapshot.provider !== last.provider || selection.snapshot.model !== last.model) {
    return {
      ok: false,
      reason: "unknown-model",
      message:
        `这个会话用的是 ${last.provider} / ${last.model}，但该配置已变更或被替换` +
        `（现在解析到 ${selection.snapshot.provider} / ${selection.snapshot.model}）。` +
        `压缩没有执行 —— 请重新确认模型配置，避免把内容发给另一家。`,
    };
  }
  return selection;
}

/** 摘要请求的退化指纹。压缩**永不作为估算基准**,这里只需稳定且一眼看得出不是真实消息。 */
const COMPACT_VIEW_ENTRIES: SendViewEntry[] = [{ messageId: "__compact__", tag: "raw" }];

function summaryPrompt(base: SummaryShape | null, chunk: SummaryTurn[]): string {
  const prior = base
    ? `已有摘要(请在它基础上合并,不要丢失其中的决定与约束):\n${JSON.stringify(base)}\n\n`
    : "";
  const body = chunk
    .map(
      (t) =>
        `【第 ${t.turn} 轮】\n` +
        t.messages.map((m) => `${m.role}: ${m.text}`).join("\n")
    )
    .join("\n\n");
  return (
    `${prior}下面是需要压缩的对话片段。请只输出 JSON,结构为 ` +
    `{"decisions":["…"],"constraints":["…"],"state":["…"],"nextSteps":["…"]},` +
    // **元素类型必须写明。** 只给空数组时,MiniMax-M3 实测把每一项写成
    // `{"topic":…,"choice":…}` 对象 —— 内容没错,结构校验却不过,压缩失败(2026-09-19)。
    `四个数组里每一项都是一句字符串(不是对象)。文件路径、命令、数字、专有名词原样保留。` +
    `不要任何解释文字。` +
    // 规格的 2K 上限写在这里:它不再是请求的输出额度(那份额度要给思考留空间)。
    `整份 JSON 控制在 ${SUMMARY_MAX_OUTPUT_TOKENS} token 以内。\n\n${body}`
  );
}

export type SummaryShape = z.infer<typeof summarySchema>;

/**
 * 下一轮的上下文占用快照,供 `/usage` 用(粗 T4 第 3 片)。
 *
 * **住在这一层,不住 `sessions.ts`。** 它要用 `selectSessionModel` / 发送视图 /
 * 估算器,而 sessions.ts 是这棵子树的最底层(引同目录模块数为 0),反向 import
 * 会造出第一个环。类型在 sessions.ts、实现在这里、由 `routes.ts` 注入。
 *
 * ⚠️ **工具定义不计入,是有声明的近似。** `/usage` 没有 `forwardedProps`,拿不到
 * 这一轮会开哪些工具 —— 与撤销闸同一处已知边界。真实一轮还要再加上工具 JSON,
 * 所以这个数**偏低**。宁可写明,也不假装精确。
 */
export function sessionContextSnapshot(
  deps: LlmChatCopilotRuntimeDeps,
  sessionId: string
): SessionContextView {
  const { selection, detail, messages, viewEntries, modelMessages, basePrompt, compactionBlock, breakdown } =
    sendViewFor(deps, sessionId, activeCompaction(deps.db, sessionId));
  const snapshot = selection.ok ? selection.snapshot : null;
  const contextWindow = contextWindowFor(snapshot);
  const outputReserve = outputReserveFor(snapshot);
  // 能对上基准就用真实账目,对不上才全量估算 —— 界面据此决定要不要加 `≈`。
  const estimate = estimateInputForRequest(deps.db, sessionId, {
    modelMessages,
    viewEntries,
    systemPrompt: compactionBlock ? `${basePrompt}\n\n${compactionBlock}` : basePrompt,
    tools: {},
    model: snapshot,
  });
  const turnStarts = userTurnIndices(messages);
  const { total: breakdownTotal, ...parts } = breakdown;
  // 与自动压缩同一个函数、同一个 keepTurns —— 界面点「现在压缩」和系统自动压缩
  // 折到同一个位置,不另算一份(两份迟早对不上,而且不会报错)。
  const suggestedCompactUpTo = userTurnCutoffFromRows(detail?.messages ?? [], AUTO_COMPACT_KEEP_TURNS);
  return {
    model: snapshot
      ? { provider: snapshot.provider, model: snapshot.model, label: snapshot.label }
      : null,
    contextWindow,
    outputReserve,
    estimatedInput: estimate.tokens,
    estimateOnly: estimate.basedOn === "full",
    breakdown: parts,
    breakdownTotal,
    // 与阶梯第 1 步同一个判据,不另写一份 —— 两份迟早对不上。
    toolResultsOmitted:
      contextWindow !== null &&
      estimate.tokens > contextWindow - outputReserve &&
      turnStarts.length > 3,
    autoCompaction: readSessionCompactionSettings(deps.db, sessionId).auto,
    suggestedCompactUpTo,
    compactCostEstimateUsd:
      suggestedCompactUpTo !== null && snapshot
        ? compactCostEstimate(deps.db, sessionId, suggestedCompactUpTo, snapshot, contextWindow)
        : null,
  };
}

/**
 * 在给定压缩状态下,下一轮要发给模型的内容及其全量估算。
 *
 * **压缩状态是参数,不在里面读。** 占用快照传当前生效的那条;摘要器在激活**之前**
 * 用它量「压缩前 / 压缩后」各一次,差就是释放量 —— 激活之后「压缩前」就量不到了。
 */
function sendViewFor(
  deps: LlmChatCopilotRuntimeDeps,
  sessionId: string,
  compaction: ChatCompaction | null
) {
  const selection = selectSessionModel(deps.db, sessionId);
  const excluded = excludedIdsOf(compaction);
  const detail = getLlmChatSession(deps.db, sessionId);

  // 与运行路径同一套裁剪:服务端专有行不发,被压缩的不发。
  const messages: Message[] = [];
  for (const row of detail?.messages ?? []) {
    if (isServerOnlyMessageId(row.message_id)) continue;
    if (excluded.has(row.message_id)) continue;
    try {
      messages.push(JSON.parse(row.raw_json) as Message);
    } catch {
      /* 坏行跳过:一条读不出来不该让整个用量接口失败。 */
    }
  }

  const viewEntries: SendViewEntry[] = [];
  const modelMessages = agUiMessagesToModelMessages(
    messages,
    selection.ok ? selection.config.provider : undefined,
    viewEntries
  );
  const basePrompt = ai2NaoSystemPrompt(undefined);
  const compactionBlock = compactionContextBlock(deps.db, sessionId, compaction);
  const breakdown = estimateBreakdown({
    messages: modelMessages,
    basePrompt,
    compactionBlock,
    tools: {},
  });
  return { selection, detail, messages, viewEntries, modelMessages, basePrompt, compactionBlock, breakdown };
}

/**
 * 「折叠到 `upToMessageIndex`」要摘要的内容与分块。
 *
 * **摘要器与「约 $X」预估共用这一份。** 各算一遍的话,预估的与真发出去的迟早对不上,
 * 而且不报错。
 */
function compactionPlan(
  db: Database.Database,
  sessionId: string,
  upToMessageIndex: number,
  window: number | null
) {
  // 本次**新**折叠的那批 —— 不含 base 已排除的。摘要输入是「base 摘要 + 新折叠的
  // 轮次」(规格原文);把累计集合喂进去会让第二次压缩重摘全部历史:既多花钱,
  // 又把前一份摘要稀释成「摘要的摘要的摘要」。
  const detail = getLlmChatSession(db, sessionId);
  const base = activeCompaction(db, sessionId);
  const baseExcluded = new Set(base?.excludedMessageIds ?? []);
  const newlyFolded = messageIdsBefore(detail?.messages ?? [], upToMessageIndex).filter(
    (id) => !baseExcluded.has(id)
  );
  const turns = summaryTurnsBefore(db, sessionId, new Set(newlyFolded));
  const budgetChars = Math.floor(
    (window ?? DEFAULT_OUTPUT_RESERVE * 4) * SUMMARY_CHUNK_WINDOW_RATIO * CONSERVATIVE_CHARS_PER_TOKEN
  );
  return { base, baseExcluded, newlyFolded, turns, chunks: chunkTurnsForSummary(turns, budgetChars) };
}

/**
 * 「立即压缩(约 $X)」的 X。
 *
 * 输入按摘要器**同一份**分块与提示词逐块估;输出按实测取整的 `SUMMARY_EXPECTED_OUTPUT_TOKENS`
 * (含思考)计 —— 偏高,与本文件「宁可高估」的估算口径一致(低估了花费,用户会在不知情时多花钱)。
 * 前一块的摘要会成为后一块的 base,这里一律用当前 base 近似,只影响「约」字的精度。
 * 任一块估不出价就整体给 null:界面不写「约 $X」,比写一个偏低的数诚实。
 */
function compactCostEstimate(
  db: Database.Database,
  sessionId: string,
  upToMessageIndex: number,
  model: NonNullable<ChatCall["model"]>,
  window: number | null
): number | null {
  const { base, chunks } = compactionPlan(db, sessionId, upToMessageIndex, window);
  if (chunks.length === 0) return null;
  const priceMap = loadPriceMap(db);
  let usd = 0;
  for (const chunk of chunks) {
    const input = Math.ceil(estimateTextTokens(summaryPrompt(base?.summary ?? null, chunk.turns)));
    const cost = estimateChatCallCostUsd(
      model,
      { input, noCache: input, cacheRead: 0, cacheWrite: 0, output: SUMMARY_EXPECTED_OUTPUT_TOKENS, reasoning: null },
      priceMap
    );
    if (cost === null) return null;
    usd += cost;
  }
  return usd;
}

/** 当前生效压缩排除掉的消息 id。没有生效压缩时是空集(整段历史照发)。 */
function excludedIdsOf(compaction: { excludedMessageIds: string[] } | null): Set<string> {
  return new Set(compaction?.excludedMessageIds ?? []);
}

/**
 * 把「折叠到某个下标」这条策略翻译成消息 id 列表。
 *
 * **事件里存 id 而不是下标。** `replaceLlmChatSessionMessages` 会重排普通消息的
 * `message_index`,存下标的话一次重排就让排除区间指向别的消息 —— 而且不报错。
 */
function messageIdsBefore(
  rows: Array<{ message_id: string; message_index: number }>,
  upToMessageIndex: number
): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (isServerOnlyMessageId(row.message_id)) continue;
    if (row.message_index >= upToMessageIndex) continue;
    out.push(row.message_id);
  }
  return out;
}

/**
 * 压缩后发给模型的那一段,拼进 `system` 参数(规格原文:**不放进 messages 数组**)。
 *
 * = 摘要(模型写)+ 已执行动作清单 + 图片轮次占位(分歧 8)。后两段**发送时现算**、
 * 不存进事件 —— 它们是对库里行的纯读取,不额外花钱,而且撤销之后会自动跟着变。
 *
 * **在此之前压缩是完全无效的。** 分隔线是 `activity` 行,而
 * `agUiMessagesToModelMessages` 一条 activity 分支都没有,于是摘要一个字都没进过
 * 模型输入 —— 只有历史被砍掉了,等于「删了上文还不给上文的梗概」。
 */
function compactionContextBlock(
  db: Database.Database,
  sessionId: string,
  compaction: ChatCompaction | null
): string | null {
  if (!compaction) return null;
  const excluded = new Set(compaction.excludedMessageIds);
  const sections: string[] = [
    "以下是本次对话更早部分的压缩摘要。原文已不在消息列表里，但这些内容依然成立。",
  ];
  const put = (title: string, items: string[]) => {
    if (items.length === 0) return;
    sections.push(`${title}\n${items.map((x) => `- ${x}`).join("\n")}`);
  };
  put("已确定的决定", compaction.summary.decisions);
  put("必须遵守的约束", compaction.summary.constraints);
  put("当前状态", compaction.summary.state);
  put("待办", compaction.summary.nextSteps);
  put("已经执行过的动作（不要重复执行）", executedActionsBefore(db, sessionId, excluded));
  put("被折叠的图片轮次", imagePlaceholdersBefore(db, sessionId, excluded));
  return sections.join("\n\n");
}

/**
 * 把被折叠区间压成一条压缩事件。**全部成功才写事件**;任一步失败就抛,
 * 已发生的账目照常保留,原上下文继续有效(规格:原子激活)。
 */
export async function summarizeForCompaction(
  deps: LlmChatCopilotRuntimeDeps,
  sessionId: string,
  upToMessageIndex: number,
  abortSignal: AbortSignal,
  /**
   * **复用调用方已持有的占位。**
   *
   * 自动压缩的触发点在 run 循环的预算块里,而 `claimChatRun` 在更早的 1378 行 ——
   * 那时**这一轮已经占着位**。若这里再占一次,必然撞上 `reason: "running"` 被拒,
   * 表现是「自动压缩看着实现了,却永远不触发」。
   *
   * 传了就跳过占位、续租、收尾三件事:生命周期归调用方。不传则与手动路由完全一致。
   */
  existing?: { runId: string; fence: number },
  /** 事件里如实记下是谁触发的。**不从 `existing` 反推** —— 那是隐式耦合,改一处就悄悄错。 */
  trigger: "manual" | "auto" = "manual"
): Promise<ChatCompaction> {
  // **压缩也是一次「运行」。** 仓库自己的注释里就预设了「一次只做了压缩的运行」;
  // 占位还顺带带来正确的拒绝:对话进行中 claim 会返回 running,而压缩不该与正在
  // 写入的那一轮抢消息。`userMessageId` 传 null —— 它不是用户轮,不参与重复提交判定。
  let owned: { runId: string; fence: number };
  if (existing) {
    owned = existing;
  } else {
    const claim = claimChatRun(deps.db, sessionId, null);
    if (!claim.ok) {
      throw new Error(
        claim.reason === "running"
          ? "这个会话正在生成回答，请等它结束后再压缩。"
          : "这个会话已有一次相同的运行，压缩没有执行。"
      );
    }
    owned = { runId: claim.run.runId, fence: claim.run.fence };
  }
  // 租约 60 秒,而压缩要按分块连发多次请求 —— 不续期的话中途会被别的进程合法接管,
  // 而本进程反而写不回终态,留下一行永远卡住的 running。
  // 复用别人的占位时**不续租也不收尾** —— 那是占位持有者的事,两边都做会打架。
  const leaseTimer = existing
    ? null
    : setInterval(() => {
        renewChatRunLease(deps.db, sessionId, owned.runId);
      }, RUN_LEASE_RENEW_MS);
  leaseTimer?.unref?.();

  try {
    const selection = selectSessionModel(deps.db, sessionId);
    if (!selection.ok) throw new Error(selection.message);

    const { base, baseExcluded, newlyFolded, turns, chunks } = compactionPlan(
      deps.db,
      sessionId,
      upToMessageIndex,
      contextWindowFor(selection.snapshot)
    );
    if (turns.length === 0) throw new Error("这个区间里没有可压缩的内容。");

    // **折叠**,不是各自独立:前一块的摘要作为后一块的 base 传下去(规格原文「分块折叠」)。
    // base 的摘要是本次摘要的输入之一(规格:`baseId` 那一行)。从 null 起步的话,
    // 上一次压缩记住的决定会在这一次之后无声消失。
    let summary: SummaryShape | null = base?.summary ?? null;
    for (let i = 0; i < chunks.length; i += 1) {
      const result = streamText({
        model: wrapLanguageModel({
          model: (deps.createModel ?? createChatLanguageModel)(selection.config),
          middleware: createAccountingMiddleware({
            db: deps.db,
            sessionId,
            runId: owned.runId,
            fence: owned.fence,
            purpose: "compact",
            model: selection.snapshot,
            stepIndex: () => i,
            sendView: () => sendViewOf(COMPACT_VIEW_ENTRIES, "", {}),
            maxOutputTokens: summaryRequestMaxTokens(selection.snapshot),
            abortSignal,
          }),
        }),
        messages: [{ role: "user", content: summaryPrompt(summary, chunks[i]!.turns) }],
        maxOutputTokens: summaryRequestMaxTokens(selection.snapshot),
        abortSignal,
      });
      const text = await result.text;
      // **先剥 `<think>`。** MiniMax 这类模型把思考直接写在正文里,不剥的话 JSON 前面
      // 挂着一整段思考,解析必然失败。然后剥 ```json 围栏 —— 但**不做任何修补**:
      // 结构不对就是失败,补出来的摘要比没有更危险。
      const body = splitThinkBlocks(text)
        .visible.replace(/^```(?:json)?\s*/i, "")
        .replace(/```$/, "")
        .trim();
      if (!body && (await result.finishReason) === "length") {
        throw new Error(`第 ${i + 1} 块:模型把输出额度用在了思考上,没来得及写摘要,压缩没有执行。`);
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(body) as unknown;
      } catch {
        throw new Error(`第 ${i + 1} 块的摘要不是合法 JSON，压缩没有执行。`);
      }
      const parsed = summarySchema.safeParse(parsedJson);
      if (!parsed.success) {
        throw new Error(
          `第 ${i + 1} 块的摘要结构不符合要求（需要 decisions/constraints/state/nextSteps），压缩没有执行。`
        );
      }
      summary = parsed.data;
    }
    if (!summary) throw new Error("摘要为空，压缩没有执行。");

    // **摘要账目的 id 从账本回读,不拼。** `attempt` 是中间件闭包里的计数器,SDK 重试过
    // 的话成功那笔的 attempt 不是 0,按 `c:${runId}:compact:${i}:0` 拼出来的 id 会指向一条
    // 不存在的账目 —— 而且不报错,只是这条事件的账从此对不上。
    const summaryCallIds = listChatCalls(deps.db, sessionId)
      .filter((call) => call.runId === owned.runId && call.purpose === "compact")
      .map((call) => call.callId);
    // 释放量:同一套全量估算,压缩前(当前生效的 base)与压缩后(候选事件)各量一次。
    // 必须在激活**之前**量 —— 激活后「压缩前」的发送视图就没了。两次都用全量口径,
    // 不混用基准账目:压缩改了前缀,压缩后那次必然对不上基准,混用会让差值失真。
    const excludedMessageIds = [...baseExcluded, ...newlyFolded];
    const candidate: ChatCompaction = {
      v: 1,
      kind: "compaction",
      id: randomUUID(),
      baseId: base?.id ?? null,
      trigger,
      excludedMessageIds,
      summary,
      summaryCallIds,
      createdAt: new Date().toISOString(),
    };
    const freedTokens = Math.max(
      0,
      sendViewFor(deps, sessionId, base).breakdown.total -
        sendViewFor(deps, sessionId, candidate).breakdown.total
    );
    // 已执行动作清单与图片轮次占位**不存进事件**:规格把它们描述为后端「纯读取、不额外
    // 花钱」地生成,也就是发送时再算(见 `compactionContextBlock`)。
    const compaction = activateChatCompaction(deps.db, sessionId, {
      id: candidate.id,
      trigger,
      excludedMessageIds,
      summary,
      summaryCallIds,
      freedTokens,
    });
    if (!existing) completeChatRun(deps.db, sessionId, owned.runId, "completed");
    return compaction;
  } catch (e) {
    if (!existing) completeChatRun(deps.db, sessionId, owned.runId, "failed");
    throw e;
  } finally {
    if (leaseTimer) clearInterval(leaseTimer);
  }
}

/** 动作清单里单条「关键参数」的长度上限。压缩是为了省上下文,清单本身不能又撑爆。 */
const EXECUTED_ACTION_DETAIL_MAX = 200;

function oneLine(value: string, max = EXECUTED_ACTION_DETAIL_MAX): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * 被压缩区间里**已经执行过的动作**,后端确定性生成,一行一条。
 *
 * **不交给摘要模型(分歧 8)。** 只校验摘要结构合法的话,「已经做过的事」可以被模型的
 * 取舍整段省掉 —— 那正是压缩后重复执行、重复提问的来源。这一段是纯读取,不额外花钱,
 * 也不会被省。
 *
 * **位置权威是 assistant 行的 `toolCalls`,不是 `ai2nao.tool-exec` 行。** 两个原因:
 * 1. tool-exec 行落在 3e6 保留区,它的 `message_index` 与对话位置无关,**判不出**
 *    某次执行是否落在被压缩区间;
 * 2. **tool-exec 只为 bash 而写** —— `startChatToolExec` 全仓库只有一个调用方
 *    (`createBashExecRecorder`),RAG / 网页搜索 / 会话记忆 / 代码执行都没有 recorder。
 *    只读它的话,清单里永远只有 bash,其余四类工具整段消失。
 *
 * 所以:按 assistant 的 toolCalls 取位置与工具名,tool-exec 仅用来**补充** bash 的
 * 命令与退出码。每个 toolCallId 只出一条,不会重复。
 */
export function executedActionsBefore(
  db: Database.Database,
  sessionId: string,
  excluded: ReadonlySet<string>
): string[] {
  const detail = getLlmChatSession(db, sessionId);
  if (!detail) return [];
  const execByCallId = new Map(listChatToolExecs(db, sessionId).map((e) => [e.toolCallId, e]));

  /** toolCallId → 结果状态。没有结果行的调用是「不知道」,不是「成功」。 */
  const resultOk = new Map<string, boolean>();
  for (const row of detail.messages) {
    if (row.role !== "tool" || !excluded.has(row.message_id)) continue;
    try {
      const m = JSON.parse(row.raw_json) as { toolCallId?: unknown; content?: unknown };
      const id = typeof m.toolCallId === "string" ? m.toolCallId : "";
      if (!id) continue;
      // 工具结果多是 `{ok: boolean, ...}` 的 JSON;不是就按「有结果即成功」算。
      const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      let ok = true;
      try {
        const parsed = JSON.parse(body) as { ok?: unknown };
        if (typeof parsed?.ok === "boolean") ok = parsed.ok;
      } catch {
        /* 不是 JSON 就按成功算 —— 有结果总比没有强。 */
      }
      resultOk.set(id, ok);
    } catch {
      /* 坏行跳过,不能因为一条读不出来就整段丢失。 */
    }
  }

  const lines: string[] = [];
  for (const row of detail.messages) {
    if (row.role !== "assistant" || !excluded.has(row.message_id)) continue;
    let calls: Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }> = [];
    try {
      const m = JSON.parse(row.raw_json) as { toolCalls?: unknown };
      if (Array.isArray(m.toolCalls)) calls = m.toolCalls as typeof calls;
    } catch {
      continue;
    }
    for (const call of calls) {
      const id = typeof call?.id === "string" ? call.id : "";
      const name = typeof call?.function?.name === "string" ? call.function.name : "unknown_tool";
      if (!id) continue;
      const exec = execByCallId.get(id);
      // bash 有 exec 行:用命令与退出码,比入参 JSON 可读得多。
      const args = typeof call?.function?.arguments === "string" ? call.function.arguments : "";
      const what = exec ? exec.command : args;
      const status = exec
        ? exec.status === "completed"
          ? exec.exitCode === 0
            ? "成功"
            : `退出码 ${exec.exitCode ?? "?"}`
          : exec.status === "failed"
            ? "失败"
            : "结果未知"
        : resultOk.has(id)
          ? resultOk.get(id)
            ? "成功"
            : "失败"
          : "结果未知";
      lines.push(`${name}: ${oneLine(what)} — ${status}`);
    }
  }
  return lines;
}

/**
 * 被压缩区间里**贴过图的轮次**占位。
 *
 * 与动作清单同理:只有文字进了摘要的话,「那一轮用户贴了图」会整段消失,模型于是
 * 重新问「你说的图呢」。轮号从会话开头数起(1 起),这样撤销/叠加压缩时编号不漂。
 */
export function imagePlaceholdersBefore(
  db: Database.Database,
  sessionId: string,
  excluded: ReadonlySet<string>
): string[] {
  const detail = getLlmChatSession(db, sessionId);
  if (!detail) return [];
  const out: string[] = [];
  let turn = 0;
  for (const row of detail.messages) {
    if (isServerOnlyMessageId(row.message_id) || row.role !== "user") continue;
    turn += 1;
    if (!excluded.has(row.message_id)) continue;
    let count = 0;
    try {
      const m = JSON.parse(row.raw_json) as { content?: unknown };
      if (Array.isArray(m.content)) {
        for (const part of m.content) if (imageSourceOf(part)) count += 1;
      }
    } catch {
      continue;
    }
    if (count > 0) out.push(`第 ${turn} 轮:用户贴了 ${count} 张图,已不在上下文`);
  }
  return out;
}

/**
 * 每条 user 消息的下标,按出现顺序 —— 一个「用户轮」从一条 user 消息起,到下一条之前。
 * 仓库里此前只有 `latestUserIndex`(只找最后一条),没有轮次切分。
 */
/**
 * 预算闸:算出来会超窗就**不调模型**,抛一条用户能照着做的错误。
 *
 * 照 `assertCanSendImages` 的先例 —— 纯函数 + `throw`,外层 catch 转成 `RUN_ERROR`
 * 且 `message` 原样透出。导出同样是为了单测能直接打它,不必跑完整回合。
 *
 * **窗口取不到时不拦。** 文档只要求「窗口缺失时用保守默认值并标估算」,没要求拒绝
 * 请求;不知道窗口就拦掉,会把「目录里没有这个模型」变成「这个模型不能用」。
 *
 * 两条错误文案是**不同处置**,不能合成一条:
 * - 不可压缩部分(最新一个用户轮及其之后)本身就超 → 压缩也救不了,只能开新会话;
 * - 否则 → 压缩或开新会话都行。
 */
export function assertWithinContextBudget(input: {
  estimatedInput: number;
  /** 最新一个用户轮及其之后的估算。这部分压缩不掉。 */
  irreducibleInput: number;
  contextWindow: number | null;
  outputReserve: number;
  modelLabel: string;
}): void {
  const { estimatedInput, irreducibleInput, contextWindow, outputReserve, modelLabel } = input;
  if (contextWindow === null) return;
  const budget = contextWindow - outputReserve;
  if (estimatedInput <= budget) return;
  if (irreducibleInput > budget) {
    throw new Error(
      `最近一轮本身就超出 ${modelLabel} 的上下文窗口` +
        `（约需 ${irreducibleInput} token，可用 ${budget}）。` +
        `压缩历史也救不了这一轮 —— 请缩短这条消息，或换一个窗口更大的模型。`
    );
  }
  throw new Error(
    `上下文将超出 ${modelLabel} 的窗口（约需 ${estimatedInput} token，可用 ${budget}）。` +
      `请先压缩这个会话，或开一个新会话再继续 —— 直接发出去会被服务商拒绝，而请求照样计费。`
  );
}

function userTurnIndices(messages: Message[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === "user") out.push(i);
  }
  return out;
}

/**
 * 规范串 → 12 位十六进制。沿用仓库既有写法(`topicStream` 的 rule_version):
 * **先投影再序列化**,只把真正相关的字段拼进规范串 —— 整个对象照单序列化会因
 * 无关字段而抖动,哈希一抖,基准就永远配不上。
 */
function hash12(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/**
 * 一条消息在本次发送里实际经历的变换。取值见设计文档《1. 数据形状》。
 * `tool-result-omitted` 与 `tool-flattened` 由后续切片产出,此处先不发。
 */
type SendViewTag =
  | "raw"
  | "tool-result-omitted"
  | "image-placeholder"
  | "reasoning-replayed"
  | "protocol-content-replayed"
  | "tool-flattened";

export type SendViewEntry = { messageId: string; tag: SendViewTag };

/**
 * 工具定义的哈希取**排序后的工具名**。
 *
 * 不哈希整个 `ToolSet`:它的值里有 `execute` 函数与 zod schema,`JSON.stringify`
 * 会把函数**静默丢掉**,得到的哈希名不副实。排序还顺带消掉 `buildAi2NaoServerTools`
 * 里 if 顺序造成的键序差异。
 *
 * 取舍已知:工具 description 变了而名字没变时哈希不动。可接受 —— 描述随代码走,
 * 不随会话变;而名字集合恰好是「这一轮开了哪些工具」的真身。
 */
function toolsHashOf(tools: Record<string, unknown>): string {
  return hash12(JSON.stringify(Object.keys(tools).sort()));
}

/**
 * 前缀哈希。**只有这一处定义** —— 落账时算一次、日后比对基准时再算一次,
 * 两处各写一遍的话,任何一次改动(比如标签取值变了)都会让新旧算法悄悄分叉,
 * 而分叉的表现只是「基准永远配不上」,不报错。
 */
function prefixHashOf(entries: SendViewEntry[]): string {
  return hash12(JSON.stringify(entries.map((e) => [e.messageId, e.tag])));
}

/** 发送视图指纹。`entries` 已经是**实际发出去**的那些消息,跳过的不在其中。 */
function sendViewOf(
  entries: SendViewEntry[],
  systemPrompt: string,
  tools: Record<string, unknown>
): SendView {
  return {
    count: entries.length,
    prefixHash: prefixHashOf(entries),
    systemHash: hash12(systemPrompt),
    toolsHash: toolsHashOf(tools),
  };
}
const sseTextEncoder = new TextEncoder();

type CopilotRuntimeHandlers = {
  single: CopilotRuntimeFetchHandler;
  multi: CopilotRuntimeFetchHandler;
};

export function registerCopilotKitRoutes(
  app: Hono,
  deps: LlmChatCopilotRuntimeDeps
): void {
  let handlers: Promise<CopilotRuntimeHandlers> | undefined;
  const getHandlers = () => {
    handlers ??= createCopilotRuntimeTransportHandlers(deps);
    return handlers;
  };

  app.get("/api/copilotkit/info", async (c) => runCopilotHandler((await getHandlers()).multi, c.req.raw));

  // **请求体上限必须在 handler 之前。** 图的字节现在走这条路由(不再有独立上传
  // 路由),而全仓此前没有任何 body 上限 —— serve() 没传 options,Node 的 http
  // server 本身也不限。没有它的话,一个 100 MB 的 base64 body 会被完整缓冲、
  // JSON 解析、再做抽取(瞬时约 300 MB),然后才轮到 sessions.ts 的 1.5 MB 闸说话;
  // 打包版桌面应用可能直接 OOM。
  //
  // 上限按「base64 膨胀 + JSON 包装」算,不是按二进制图大小:
  // 6 张 × 5 MB(单张上限)× 4/3 ≈ 40 MB,再留一点给历史消息。
  app.post(
    "/api/copilotkit",
    bodyLimit({
      maxSize: COPILOTKIT_MAX_BODY_BYTES,
      onError: (c) =>
        c.json({ error: "请求体过大。图片太多或太大，请减少张数后重试。" }, 413),
    }),
    async (c) => runCopilotHandler((await getHandlers()).single, c.req.raw)
  );

  app.post("/api/copilotkit/agent/default/connect", async (c) => {
    return runCopilotHandler((await getHandlers()).multi, c.req.raw);
  });

  app.post("/api/copilotkit/agent/default/run", async (c) => {
    return runCopilotHandler((await getHandlers()).multi, c.req.raw);
  });

  app.post("/api/copilotkit/agent/default/stop/:threadId", async (c) => {
    return runCopilotHandler((await getHandlers()).multi, c.req.raw);
  });

  /**
   * 手动「立即压缩」。
   *
   * **`upToMessageIndex` 必传,不给默认值。** 「折叠到哪」是策略(例如「保留最近三个
   * 用户轮」),该由调用方定;在后端编一个默认值等于把一条没人审过的规则固化下来。
   *
   * 错误一律用本文件既有的 `c.json({error}, status)` 形状 —— 这里没有 `jsonErr`
   * (那是 sessionRoutes 的写法),不跨文件借用。
   */
  app.post("/api/copilotkit/agent/default/compact/:threadId", async (c) => {
    const threadId = c.req.param("threadId");
    let upTo: unknown;
    try {
      upTo = ((await c.req.json()) as { upToMessageIndex?: unknown })?.upToMessageIndex;
    } catch {
      return c.json({ error: "请求体必须是 JSON。" }, 400);
    }
    if (typeof upTo !== "number" || !Number.isInteger(upTo) || upTo < 0) {
      return c.json({ error: "缺少 upToMessageIndex(非负整数):要折叠到哪一条由调用方决定。" }, 400);
    }
    try {
      const compaction = await summarizeForCompaction(deps, threadId, upTo, c.req.raw.signal);
      return c.json({ compaction });
    } catch (e) {
      // 摘要器对「进行中」「模型配置漂移」「结构校验失败」都抛可操作文案,原样透出。
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
    }
  });

  /**
   * 撤销某一条压缩。
   *
   * **撤销闸(规格):撤销前先按撤销后的发送视图做预算,超窗就拒绝** —— 否则撤销完
   * 下一轮直接超窗,用户会以为是「压缩坏了」。
   *
   * ⚠️ **这里的估算偏低,是有声明的近似。** 路由层没有 `forwardedProps`,拿不到这一轮
   * 会开哪些工具,所以估算不含工具定义;真实一轮还要再加上工具 JSON。宁可写明,
   * 也不假装精确。
   */
  app.post("/api/copilotkit/agent/default/compaction/:threadId/undo", async (c) => {
    const threadId = c.req.param("threadId");
    let compactionId: unknown;
    try {
      compactionId = ((await c.req.json()) as { compactionId?: unknown })?.compactionId;
    } catch {
      return c.json({ error: "请求体必须是 JSON。" }, 400);
    }
    if (typeof compactionId !== "string" || !compactionId) {
      return c.json({ error: "缺少 compactionId。" }, 400);
    }
    try {
      const stack = replayCompactionStack(readChatCompactionEvents(deps.db, threadId));
      const top = stack.length > 0 ? stack[stack.length - 1]! : null;
      if (!top) return c.json({ error: "这条压缩不存在或已撤销。" }, 404);
      // **只能撤销栈顶**(规格原文)。允许跳层的话,「发给模型的内容」就不再是事件序列
      // 的函数 —— 同一串事件回放出的结果会含糊。
      if (top.id !== compactionId) {
        return c.json({ error: "只能撤销最近一次压缩。" }, 409);
      }

      // 撤销之后生效的是它下面那一层;没有就是整段历史都回来。
      const nextTop = stack.length > 1 ? stack[stack.length - 2]! : null;
      const excludedAfter = excludedIdsOf(nextTop);

      // **认不出模型 ≠ 不许撤销。** 这里取模型只为拿到窗口去做预算闸;取不到就等于
      // 「窗口未知」,而 `assertWithinContextBudget` 对 null 窗口的既定策略就是放行
      // (「目录里没有这个模型」不等于「这个模型不能用」)。在这一步直接 409 会让
      // **删过厂商配置的用户永远恢复不了自己的历史** —— 撤销是纯数据操作,不该被
      // 模型配置绑架。
      const selection = selectSessionModel(deps.db, threadId);
      const detail = getLlmChatSession(deps.db, threadId);
      const restored: Message[] = [];
      for (const row of detail?.messages ?? []) {
        if (isServerOnlyMessageId(row.message_id)) continue;
        if (excludedAfter.has(row.message_id)) continue;
        try {
          restored.push(JSON.parse(row.raw_json) as Message);
        } catch {
          /* 坏行跳过 */
        }
      }
      // 只有认得出模型时才谈得上「超没超窗」;认不出就跳过闸,直接撤销。
      if (selection.ok) {
        const estimated = estimatedInputTokens(
          agUiMessagesToModelMessages(restored, selection.config.provider),
          // 撤销后生效的是下面那一层,它的摘要仍要计入 —— 传 undefined 的话这道闸会按
          // 「没有摘要」估算,比真实值低,于是放行本该拒绝的撤销。
          ai2NaoSystemPrompt(undefined, compactionContextBlock(deps.db, threadId, nextTop)),
          {}
        );
        try {
          assertWithinContextBudget({
            estimatedInput: estimated,
            irreducibleInput: estimated,
            contextWindow: contextWindowFor(selection.snapshot),
            outputReserve: outputReserveFor(selection.snapshot),
            modelLabel: selection.snapshot.label,
          });
        } catch {
          return c.json(
            { error: "撤销后上下文会超出模型窗口，已拒绝撤销 —— 否则下一轮会直接失败。" },
            409
          );
        }
      }

      const result = revertChatCompaction(deps.db, threadId, compactionId);
      // 闸过了之后栈顶仍应是它。不是的话说明并发改了栈 —— 如实回 409,不假装成功。
      if (!result.ok) return c.json({ error: "只能撤销最近一次压缩。" }, 409);
      return c.json({ reverted: result.event, active: activeCompaction(deps.db, threadId) });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
}

async function runCopilotHandler(
  handler: CopilotRuntimeFetchHandler,
  request: Request
): Promise<Response> {
  return normalizeCopilotRuntimeResponse(await handler(request));
}

function normalizeCopilotRuntimeResponse(response: Response): Response {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    return response;
  }
  const body = response.body.pipeThrough(
    new TransformStream<unknown, Uint8Array>({
      transform(chunk, controller) {
        if (typeof chunk === "string") {
          controller.enqueue(sseTextEncoder.encode(chunk));
        } else if (chunk instanceof Uint8Array) {
          controller.enqueue(chunk);
        } else {
          controller.enqueue(sseTextEncoder.encode(String(chunk)));
        }
      },
    })
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function createCopilotRuntimeTransportHandlers(
  deps: LlmChatCopilotRuntimeDeps
): Promise<CopilotRuntimeHandlers> {
  process.env.COPILOTKIT_TELEMETRY_DISABLED ??= "1";
  const { CopilotRuntime, createCopilotRuntimeHandler } = await import("@copilotkit/runtime/v2");
  const runtime = new CopilotRuntime({
    agents: { default: new Ai2NaoTransportAgent() },
    runner: createAi2NaoAgentRunner(deps),
  });

  return {
    single: createCopilotRuntimeHandler({
      runtime,
      basePath: "/api/copilotkit",
      mode: "single-route",
    }),
    multi: createCopilotRuntimeHandler({
      runtime,
      basePath: "/api/copilotkit",
      mode: "multi-route",
    }),
  };
}

class Ai2NaoTransportAgent extends AbstractAgent {
  constructor() {
    super({ agentId: "default", description: "ai2nao transport-only CopilotKit adapter" });
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return {
      tools: { supported: false, clientProvided: false },
      transport: { streaming: true },
    };
  }

  setState(): void {
    super.setState({});
  }

  run(): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      subscriber.error(new Error("ai2nao owns agent execution; CopilotKit is transport only."));
    });
  }
}

function createAi2NaoAgentRunner(deps: LlmChatCopilotRuntimeDeps): AgentRunner {
  return {
    run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
      return observableFromAi2NaoTurn(deps, parseAgentInput(request.input));
    },
    connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
      return observableFromEvents(connectToThreadEvents(deps, request.threadId));
    },
    isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
      return Promise.resolve(runningThreadIds.has(request.threadId));
    },
    stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
      const stop = runningThreadStops.get(request.threadId);
      stop?.();
      const wasRunning = runningThreadIds.delete(request.threadId) || Boolean(stop);
      runningThreadStops.delete(request.threadId);
      return Promise.resolve(wasRunning);
    },
  };
}

function observableFromAi2NaoTurn(
  deps: LlmChatCopilotRuntimeDeps,
  input: AgentInput
): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    const abortController = new AbortController();
    runningThreadStops.set(input.threadId, () => abortController.abort());
    (async () => {
      try {
        for await (const event of runAi2NaoTurnEvents(deps, input, abortController.signal)) {
          if (subscriber.closed) break;
          subscriber.next(event);
        }
        subscriber.complete();
      } catch (error) {
        subscriber.error(error);
      }
    })();

    return () => {
      abortController.abort();
    };
  });
}

function observableFromEvents(events: Iterable<BaseEvent>): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    for (const event of events) {
      if (subscriber.closed) break;
      subscriber.next(event);
    }
    subscriber.complete();
  });
}

/**
 * provider 层的 usage 形状 → 我们的分桶。
 *
 * 这一层拿到的是**未扁平化**的原始形状(`inputTokens.total` 而不是 `inputTokens`)
 * —— SDK 的 `asLanguageModelUsage` 是在更上层才做转换的,中间件截到的在它之前。
 */
function usageFromProviderChunk(raw: unknown): ChatCallUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as {
    inputTokens?: { total?: unknown; noCache?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
    outputTokens?: { total?: unknown; text?: unknown; reasoning?: unknown };
  };
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    input: num(usage.inputTokens?.total),
    noCache: num(usage.inputTokens?.noCache),
    cacheRead: num(usage.inputTokens?.cacheRead),
    cacheWrite: num(usage.inputTokens?.cacheWrite),
    output: num(usage.outputTokens?.total),
    reasoning: num(usage.outputTokens?.reasoning),
  };
}

type AccountingContext = {
  db: Database.Database;
  sessionId: string;
  runId: string;
  fence: number;
  purpose: ChatCallPurpose;
  model: { modelId: string; provider: string; model: string; label: string };
  /** 当前步号。由 prepareStep 写入 —— 不自己维护计数器。 */
  stepIndex: () => number;
  /**
   * 本次发送内容的指纹。**必填**(而 `ChatCall` 上是可选) —— 两处故意不同:
   * 类型要对库里的老行说实话(它们没有这个键),但对新写入必须寸步不让。
   * 做成 thunk 与 `stepIndex` 同理:值要在**发请求那一刻**取,不是构造中间件时。
   */
  sendView: () => SendView;
  /** 输出预留。与传给 `streamText` 的 `maxOutputTokens` 是同一个数。 */
  maxOutputTokens: number;
  /**
   * 某次尝试**成功**结算时回报它的账目 id。
   *
   * 思考行要带「该步最终成功那次尝试的 callId」,而 `attempt` 只活在中间件的
   * 工厂闭包里,轮循环推不出来。**不走「落库时回查账本挑 completed」那条路** ——
   * 那要押「中间件已经结算完」这个顺序,而顺序是要实测的,不该假定。
   */
  onCallCompleted?: (callId: string, stepIndex: number) => void;
  abortSignal: AbortSignal;
};

/**
 * 记账中间件:**一次模型 HTTP 请求一笔账**。
 *
 * 请求发出**之前**先落一笔 `pending`,所以首包前的 HTTP 错误、中止、进程崩溃
 * 都留得下痕迹 —— 等响应回来再记账,漏掉的恰恰是这几种最该被记录的情况。
 *
 * **每个 `streamText` 调用点必须现场构造一个新实例。** `attempt` 是这个闭包里的
 * 计数器,而 SDK 不告诉中间件「这是第几次重试」(`wrapStream` 的四个参数固定不变)。
 * 实例一旦复用,主回答与补答会串号,甚至跨轮累加,账目行 id 就会互相覆盖。
 *
 * 另外 `maxRetries` 本仓没显式传,SDK 默认是 **2** —— 一次彻底失败的请求会落
 * **3 行账**(1 次 + 2 次重试)。这不是 bug,是「每次尝试各算一笔」的应有之义。
 */
function createAccountingMiddleware(ctx: AccountingContext): LanguageModelMiddleware {
  let attempt = 0;
  return {
    specificationVersion: "v3",
    wrapStream: async ({ doStream }) => {
      const stepIndex = ctx.stepIndex();
      const call = insertPendingChatCall(ctx.db, ctx.sessionId, {
        callId: `c:${ctx.runId}:${ctx.purpose}:${stepIndex}:${attempt}`,
        runId: ctx.runId,
        fence: ctx.fence,
        purpose: ctx.purpose,
        stepIndex,
        attempt,
        model: ctx.model,
        sendView: ctx.sendView(),
        maxOutputTokens: ctx.maxOutputTokens,
      });
      attempt += 1;

      let settled = false;
      // **中止要单独监听。** 客户端断开时,下游取消的是这条 TransformStream 的读端 ——
      // `flush` 只在写端正常关闭时才调,取消与上游半路报错都不会走到它。只靠 flush 的话,
      // 用户点了停止,这笔账就永远停在 pending(2026-09-19 端到端实测)。
      const onAbort = () => settle("aborted", null);
      const settle = (status: "completed" | "failed" | "aborted", usage: ChatCallUsage | null) => {
        if (settled) return;
        settled = true;
        ctx.abortSignal.removeEventListener("abort", onAbort);
        try {
          // 价格表在结算那一刻读一次:用的是「这笔账发生时」的价,
          // 而快照会写进账目行 —— 日后价格变了也不回头重算。
          finishChatCall(ctx.db, ctx.sessionId, call.callId, status, usage, loadPriceMap(ctx.db));
        } catch (error) {
          // 记账失败不能反过来打断这一轮对话。
          llmChatLog.error("ai2nao finishChatCall failed", error);
        }
        // 落在 finishChatCall 之后:回报的这笔账必须已经写进库,
        // 否则思考行会指向一个查不到的 callId。`settled` 闸保证只回报一次。
        if (status === "completed") ctx.onCallCompleted?.(call.callId, stepIndex);
      };

      if (ctx.abortSignal.aborted) onAbort();
      else ctx.abortSignal.addEventListener("abort", onAbort, { once: true });

      try {
        const { stream, ...rest } = await doStream();
        return {
          ...rest,
          stream: stream.pipeThrough(
            new TransformStream({
              transform(chunk, controller) {
                const part = chunk as { type?: unknown; usage?: unknown };
                if (part.type === "finish") {
                  settle("completed", usageFromProviderChunk(part.usage));
                }
                controller.enqueue(chunk);
              },
              flush() {
                // 流没走到 finish 就结束了:取消,或者中途断了。
                settle(ctx.abortSignal.aborted ? "aborted" : "failed", null);
              },
            })
          ),
        };
      } catch (error) {
        // 首包之前就失败 —— 这正是「请求前先落账」要覆盖的场景。
        settle(ctx.abortSignal.aborted ? "aborted" : "failed", null);
        throw error;
      }
    },
  };
}

/**
 * 用户停了就改走中止路径。
 *
 * **AI SDK 收到中止信号时不抛错**:`fullStream` 吐一个 `abort` 分片后正常结束。于是停止
 * 会一路走成「正常完成」—— 运行记成 completed(重复提交判定会把这条用户消息当成已答完)、
 * 落库走完整版 `persistStep()`(没有结果的工具调用会进库,下一轮发给厂商就是 400)、
 * 还会接着补答与兜底回答。抛出去才能进 catch:终态 aborted、落半步、不再追加。
 */
function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("已停止生成。");
}

/**
 * 一个在中止时 resolve 的 Promise。
 *
 * 给 `prepareStep` 的闸门做竞速用:消费侧一旦停了(报错、被取消),闸就永远不会
 * 开,单纯 await 会把这一轮吊死在那儿。已经 aborted 就立即 resolve。
 */
function abortedPromise(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * 落库失败重试一次,仍失败就中止这一轮。
 *
 * **「看得见的回答必须存得下」是这次设计的承诺。** 存不下还让模型继续往下跑,
 * 结果是用户看到了回答、钱也照花,刷新却什么都没有。所以第二次仍失败就直接抛,
 * 由外层 catch 变成 RUN_ERROR 停掉这一轮。
 *
 * 只重试一次,是给「桌面版正占着库」这类瞬时写冲突留的 —— `open.ts` 已经设了
 * 5 秒 busy_timeout,真等不到就不是抢锁能解决的问题了。
 */
function persistWithRetry(
  db: Database.Database,
  sessionId: string,
  build: () => Message[]
): void {
  try {
    persistGenerated(db, sessionId, build());
    return;
  } catch (first) {
    llmChatLog.error("ai2nao persist failed, retrying once", first);
  }
  try {
    persistGenerated(db, sessionId, build());
  } catch (second) {
    const message = second instanceof Error ? second.message : String(second);
    throw new Error(`保存失败，已停止生成：${message}`);
  }
}

/**
 * 发往 CopilotKit 的会话快照。
 *
 * **导出是为了单测能直接打它,不必跑完整回合**(与 `assertCanSendImages` 同例)。
 * 分隔线在前端没有渲染器,界面上本来就看不见 —— 它有没有被放行,只有测试看得见。
 *
 * **服务端专有行(轮级占位行,以后还有账目行)永不出现在这里。** 它们是后端自己
 * 的记账与互斥用的,前端拿到只会渲染成莫名其妙的 activity 消息,而且会被客户端
 * 原样回传。
 */
export function threadSnapshot(
  deps: LlmChatCopilotRuntimeDeps,
  threadId: string
): Message[] {
  const detail = getLlmChatSession(deps.db, threadId);
  if (!detail) return [];
  const compaction = activeCompaction(deps.db, threadId);
  // 被折叠的消息不再进快照。按 **id 集合**裁而不是下标:下标会被重排,id 不会。
  const excluded = excludedIdsOf(compaction);
  const dividerId = compaction ? compactionDividerMessageId(compaction.id) : null;

  // **不能走 `agUiMessagesFromSession`** —— 它返回 `Message[]`,`message_index` 在那一步
  // 就丢了,而「只保留生效压缩之后的消息」恰恰要按下标裁。所以直接走 `detail.messages`。
  const kept: Message[] = [];
  let divider: Message | null = null;
  for (const row of detail.messages) {
    let parsed: Message;
    try {
      parsed = JSON.parse(row.raw_json) as Message;
    } catch {
      continue; // 坏行跳过:一条读不出来不该让整个快照失败。
    }
    if (isServerOnlyMessageId(row.message_id)) {
      // 服务端专有行一律不给前端,**唯一例外是当前生效的那条压缩分隔线**。
      // 例外只开在这里:`isServerOnlyMessageId` 这个不变量还被用量、重排等三处用着,
      // 为一种行去改前缀语义,等于把同一个概念拆成两套判据。
      if (dividerId && row.message_id === dividerId) divider = parsed;
      continue;
    }
    if (excluded.has(row.message_id)) continue;
    kept.push(parsed);
  }

  // **分隔线显式前置。** 它的行落在 4e6 保留区,按 `message_index` 自然排序会排到所有
  // 普通消息**之后** —— 那与语义相反:它之前的内容才是被折叠掉的那些。
  return divider ? [divider, ...kept] : kept;
}

function* connectToThreadEvents(deps: LlmChatCopilotRuntimeDeps, threadId: string): Generator<BaseEvent> {
  const messages = threadSnapshot(deps, threadId);
  const runId = randomUUID();
  yield { type: EventType.RUN_STARTED, threadId, runId } as BaseEvent;
  yield { type: EventType.MESSAGES_SNAPSHOT, messages } as BaseEvent;
  yield { type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent;
}

/**
 * 把账本原语包成工具层认识的回调。
 *
 * 放在这里而不是 `sessions.ts`:`BashExecRecorder` 是 `src/llmTools/` 的类型,
 * 让 sessions.ts 反过来认识它,依赖方向就拧反了。这一层只是转调,没有逻辑。
 */
export function createBashExecRecorder(
  db: Database.Database,
  sessionId: string,
  runId: string,
  fence: number
): BashExecRecorder {
  return {
    start({ toolCallId, command, cwd }) {
      return startChatToolExec(db, sessionId, {
        toolCallId,
        runId,
        fence,
        toolName: "ai2nao_run_shell",
        command,
        cwd,
      }).ok;
    },
    finish({ toolCallId, status, exitCode }) {
      finishChatToolExec(db, sessionId, toolCallId, status, exitCode);
    },
  };
}

async function* runAi2NaoTurnEvents(
  deps: LlmChatCopilotRuntimeDeps,
  input: AgentInput,
  abortSignal: AbortSignal
): AsyncGenerator<BaseEvent> {
  const runId = input.runId || randomUUID();
  const generated = new GeneratedMessages();
  // 占位行:claim 成功后才有值。finally 靠它落终态 —— 不落的话,这一轮结束后
  // 库里仍是一条「running 且租约未过期」的记录,下一轮会被自己拒掉。
  let claimed: ChatRun | null = null;
  let terminal: Exclude<ChatRun["status"], "running"> = "completed";
  let leaseTimer: ReturnType<typeof setInterval> | null = null;
  // 中止时落半步用。**必须声明在 try 之外** —— catch 是另一个作用域,
  // 声明在 try 里的话 catch 根本看不见它(tsc 已经就这点报过错)。
  // 真正的实现要等 selection 就位才能赋值,所以先留空。
  let persistAbortHalfStep: (() => void) | null = null;
  runningThreadIds.add(input.threadId);
  yield { type: EventType.RUN_STARTED, threadId: input.threadId, runId } as BaseEvent;
  try {
    validateAi2NaoCopilotInput(input.messages, input.tools, input.context, input.state);
    // 前端每轮通过 properties → forwardedProps 送来 modelId。合法性与可用性一律
    // 在这里判 —— 前端的值不可信,而且 picker 可能与库里的配置有一瞬间的不同步。
    const selection = selectModelForTurn(
      readLlmChatDocument(),
      parseForwardedToolProps(input.forwardedProps).modelId
    );
    // **不可用就报错,不静默换家。** 用户明确点了某一家,却把内容发给另一家,
    // 费用、数据去向、以及「我以为在用 A」的误判全都错。抛出去由下面的 catch
    // 变成 RUN_ERROR,文案里带模型名,用户看得出该去哪修。
    if (!selection.ok) throw new Error(selection.message);
    const cfg = selection.config;
    ensureLlmChatSession(deps.db, input.threadId);

    // **跨进程互斥 + 重复提交判定。** 进程内的 runningThreadIds 只挡得住同一个
    // 进程;桌面版(:8787)与开发版 serve 同时跑同一个会话时,靠的是这一行占位行。
    const newUserMessageId =
      [...input.messages].reverse().find((m) => m.role === "user")?.id ?? null;
    const claim = claimChatRun(deps.db, input.threadId, newUserMessageId);
    if (!claim.ok && claim.reason === "running") {
      throw new Error("这个会话正在生成，请等这一轮结束再发。");
    }
    if (!claim.ok) {
      // 同一条用户消息重复提交:不调模型、不花钱,只回放当前快照。
      yield {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: threadSnapshot(deps, input.threadId),
      } as BaseEvent;
      yield { type: EventType.RUN_FINISHED, threadId: input.threadId, runId } as BaseEvent;
      return;
    }
    claimed = claim.run;
    // 上一轮若是崩在命令执行到一半,库里会留下 `started` 的 tool-exec 行。
    // **不自动重跑** —— 标成「结果未知」交给用户判断:那条命令可能已经改了磁盘,
    // 也可能一个字节都没写,而重跑一条已经生效过的命令是不可逆的。
    markStaleToolExecsUnknown(deps.db, input.threadId, claim.run.fence);
    // **心跳必须有。** 租约 60 秒,而带工具的一轮很容易跑更久;不续期的话,
    // 这一轮跑到一半租约就过期了 —— 那时别的进程可以合法接管,而我们自己反而
    // 因为「状态已不是自己的」写不回终态,留下一行永远卡住这个会话的 running。
    leaseTimer = setInterval(() => {
      renewChatRunLease(deps.db, input.threadId, claim.run.runId);
    }, RUN_LEASE_RENEW_MS);
    // 不能让心跳把进程吊住 —— 测试里尤其明显。
    leaseTimer.unref?.();

    const detail = getLlmChatSession(deps.db, input.threadId);
    const persistedMessages = detail ? agUiMessagesFromSession(detail) : [];
    // **净化只做一次,结果存成变量给所有消费者用。**
    //
    // 起初只在下面的 merge 里净化,而落库那一处(`persistWithRetry(... () => input.messages)`)
    // 仍然拿的是原件 —— 结果伪造的思考行照样进库,单测全绿、只有端到端照得出来。
    // 病根不是漏了一处,是**同一份数据在两个地方各自决定「客户端消息」是什么**:
    // 再来第三个消费者,同样的洞会再开一次。所以在这里定型,下面一律读这个变量。
    //
    // (更彻底的做法是在 `parseAgentInput` 里就净化好,让 `input.messages` 从源头就是干净的;
    // 但 `input.messages` 还被 runId / 重复提交判定读着,那些消费者我没有逐个走查过,
    // 在这一片里改它的语义,波及面超出本片该承担的范围。记为后续更好的形状。)
    const clientMessages = newClientUserMessages(
      sanitizeClientMessages(input.messages),
      new Set(persistedMessages.map((m) => String(m.id)))
    );
    // 下面两处 mergeAgUiMessages 的第二个参数是服务端自己生成的消息,
    // **那两处不能净化** —— 里面正有思考行,净化等于自删。
    // **排除必须施加在合并之后。** 客户端每轮会把它持有的全部非 activity 消息回传
    // (`prepareRunAgentInput`),只裁持久化侧的话,被折叠的消息会从客户端那一侧原样
    // 回来 —— 压缩等于白做,而且不报错。
    const turnCompaction = activeCompaction(deps.db, input.threadId);
    let excludedForTurn = excludedIdsOf(turnCompaction);
    let mergedMessages = mergeAgUiMessages(persistedMessages, clientMessages).filter(
      (m) => !excludedForTurn.has(String(m.id))
    );
    const serverTools = buildAi2NaoServerTools(
      { ...deps, bashApprovalStore: deps.bashApprovalStore ?? defaultBashApprovalStore },
      input.forwardedProps,
      {
        sessionId: input.threadId,
        bashExecRecorder: createBashExecRecorder(
          deps.db,
          input.threadId,
          claim.run.runId,
          claim.run.fence
        ),
      }
    );
    // 逐条变换由转换函数自己上报 —— 在外面照 `provider` 再推一遍就是把同一个
    // 概念编码到两处,而 `protocol ?? text` 决定了它是**逐条**的,推不出来。
    const viewEntries: SendViewEntry[] = [];
    let modelMessages = agUiMessagesToModelMessages(mergedMessages, cfg.provider, viewEntries);
    const outputReserve = outputReserveFor(selection.snapshot);
    // **带图但发不出去的,一个字节都不发。** 前端的置灰是第一道,这是第二道 ——
    // 前端的值不可信(与 modelId 同一条铁律),而 picker 与库里的配置有一瞬不同步时,
    // 图会被真的发出去、真的计费,模型却静默丢图编一个答案。
    assertCanSendImages(modelMessages, cfg.provider);
    // 摘要拼进 `system`,不放进 messages 数组(规格原文)。`let` 是因为自动压缩之后
    // 必须重建 —— 不重建的话刚花钱摘出来的内容当场丢失,模型只看到「历史突然少了一半」。
    let systemPrompt = ai2NaoSystemPrompt(
      input.forwardedProps,
      compactionContextBlock(deps.db, input.threadId, turnCompaction)
    );
    // **下一步请求必须等上一步落库。** SDK 的步骤循环不等我们消费 `fullStream`:
    // 它处理完一步就能发下一笔请求,而我们可能还在读上一步的事件。所以「保存失败
    // 就别再花钱」不能只挂在消费侧 —— `prepareStep` 是 SDK 发下一笔请求前一定会
    // await 的钩子,闸设在这里才真的拦得住。
    let stepGate: Promise<void> = Promise.resolve();
    let openGate: () => void = () => {};
    let persistFailure: Error | null = null;
    // 当前步号。T3 里刻意没引入(那时没有消费方,引入就是 speculative code);
    // T4 的账目行 id 需要它,在这里闭环 —— 值来自 SDK 的 prepareStep,
    // 不自己维护计数器:自己数的话,上一步还没落库就可能被下一步改掉。
    let currentStepIndex = 0;
    const armGate = () => {
      stepGate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
    };
    // 写成闭包是为了不把 selection 的类型再导入一遍;声明在 try 外、这里才赋值。
    persistAbortHalfStep = () => {
      persistGenerated(
        deps.db,
        input.threadId,
        stampModelSnapshot(generated.messagesForAbort(), selection.snapshot)
      );
    };

    // ── 预算闸(粗 T6 第 2 片)────────────────────────────────────────────
    // 放在 streamText 之前:`systemPrompt` / `serverTools` / `modelMessages` /
    // `viewEntries` / `outputReserve` 都是它要用的,到这一行必然全部就位。
    const contextWindow = contextWindowFor(selection.snapshot);
    const turnStarts = userTurnIndices(mergedMessages);
    const estimateNow = () =>
      estimateInputForRequest(deps.db, input.threadId, {
        modelMessages,
        viewEntries,
        systemPrompt,
        tools: serverTools,
        model: selection.snapshot,
      });
    let estimate = estimateNow();

    // **阶梯第 1 步**:超预算就省略「最近 3 个用户轮之前」的工具结果正文。
    // 只影响本次发送,不写记录、完全可逆;调用与结果的配对保持不变。
    // 重建时先清空 `viewEntries` —— 不清的话旧条目会留在里面,指纹与 count 全错,
    // 而且不会报错。
    if (
      contextWindow !== null &&
      estimate.tokens > contextWindow - outputReserve &&
      turnStarts.length > 3
    ) {
      const omitBefore = turnStarts[turnStarts.length - 3]!;
      viewEntries.length = 0;
      modelMessages = agUiMessagesToModelMessages(
        mergedMessages,
        cfg.provider,
        viewEntries,
        omitBefore
      );
      estimate = estimateNow();
    }

    // ── 阶梯第 2 步:自动压缩(粗 T7 收尾)──────────────────────────────
    // 会话级开关,**默认关闭**;阈值是「估算 > 窗口 × 0.9」—— 与第 1 步的
    // 「> 窗口 − 输出预留」是两个不同判据,规格分别写明,不可混用。
    let effectiveMessages = mergedMessages;
    if (
      contextWindow !== null &&
      estimate.tokens > contextWindow * AUTO_COMPACT_RATIO &&
      readSessionCompactionSettings(deps.db, input.threadId).auto
    ) {
      const cutoff = userTurnCutoffFromRows(detail?.messages ?? [], AUTO_COMPACT_KEEP_TURNS);
      if (cutoff !== null) {
        try {
          // **复用这一轮的占位。** 自己再 claim 一次必然撞上 running 而被拒 ——
          // 那会让自动压缩「看着实现了却永远不触发」。
          await summarizeForCompaction(
            deps,
            input.threadId,
            cutoff,
            abortSignal,
            { runId: claim.run.runId, fence: claim.run.fence },
            "auto"
          );
          // 规格:**压缩后强制重算**。重新取数、按新生效的折叠点裁,再与客户端消息合并。
          const after = getLlmChatSession(deps.db, input.threadId);
          const active = activeCompaction(deps.db, input.threadId);
          excludedForTurn = excludedIdsOf(active);
          // **摘要换了,system 必须跟着换。** 漏了的话这一笔压缩的钱白花。
          systemPrompt = ai2NaoSystemPrompt(
            input.forwardedProps,
            compactionContextBlock(deps.db, input.threadId, active)
          );
          const restored: Message[] = [];
          for (const row of after?.messages ?? []) {
            if (isServerOnlyMessageId(row.message_id)) continue;
            if (excludedForTurn.has(row.message_id)) continue;
            try {
              restored.push(JSON.parse(row.raw_json) as Message);
            } catch {
              /* 坏行跳过 */
            }
          }
          effectiveMessages = mergeAgUiMessages(restored, clientMessages).filter(
            (m) => !excludedForTurn.has(String(m.id))
          );
          // 补答与兜底回答读的是 `mergedMessages` —— 不同步的话,刚压缩掉的内容会在
          // 补答那一笔里原样发回去,等于为同一段上下文付两次钱。
          mergedMessages = effectiveMessages;
          viewEntries.length = 0;
          modelMessages = agUiMessagesToModelMessages(
            effectiveMessages,
            cfg.provider,
            viewEntries
          );
          estimate = estimateNow();
        } catch (e) {
          // **压缩失败不让这一轮直接死。** 原上下文仍然有效,继续走第 4 步的判定 ——
          // 那里该拒还是会拒,但错误文案是「上下文超窗」而不是「压缩挂了」。
          llmChatLog.warn("ai2nao auto compaction failed", e);
        }
      }
    }

    // 第 4 步:仍超则不调模型,给可操作的错误。
    assertWithinContextBudget({
      estimatedInput: estimate.tokens,
      // 不可压缩部分 = system + tools + 最新一个用户轮及其之后。
      // 省略旧工具结果也动不了它,所以它超了就是另一种处置(见文案)。
      // **用压缩后的那份**。漏切的话,不可压缩部分会按压缩前的内容算,
      // 于是刚压缩完却仍被判成「最近一轮本身超窗」。
      irreducibleInput: (() => {
        const starts = userTurnIndices(effectiveMessages);
        return estimatedInputTokens(
          agUiMessagesToModelMessages(
            effectiveMessages.slice(starts[starts.length - 1] ?? 0),
            cfg.provider
          ),
          systemPrompt,
          serverTools
        );
      })(),
      contextWindow,
      outputReserve,
      modelLabel: selection.snapshot.label,
    });

    const result = streamText({
      // 记账入口:中间件包在模型上,所以 SDK 的每次重试都会重新进入它 ——
      // 「每次尝试各算一笔」靠的就是这一点,不需要我们自己识别重试。
      model: wrapLanguageModel({
        model: (deps.createModel ?? createChatLanguageModel)(cfg),
        middleware: createAccountingMiddleware({
          db: deps.db,
          sessionId: input.threadId,
          runId: claim.run.runId,
          fence: claim.run.fence,
          purpose: "answer",
          model: selection.snapshot,
          stepIndex: () => currentStepIndex,
          sendView: () => sendViewOf(viewEntries, systemPrompt, serverTools),
          maxOutputTokens: outputReserve,
          onCallCompleted: (callId, stepIndex) => completedCallIds.set(stepIndex, callId),
          abortSignal,
        }),
      }),
      system: systemPrompt,
      messages: modelMessages,
      tools: serverTools,
      // 与账目里记的 `maxOutputTokens` 取自同一个变量。分别算两次的话,
      // 预算扣的和模型获准生成的可能不是一个数,而且不会报错。
      maxOutputTokens: outputReserve,
      stopWhen: stepCountIs(MAX_TOOL_LOOP_STEPS),
      abortSignal,
      prepareStep: async ({ stepNumber, messages: stepMessages }) => {
        // 第 0 步没有「上一步」可等。
        if (stepNumber > 0) {
          // 与中止竞速:消费侧若已经停了,闸永远不会开,不能把这一轮吊死。
          await Promise.race([stepGate, abortedPromise(abortSignal)]);
          if (persistFailure) throw persistFailure;
        }
        currentStepIndex = stepNumber;
        armGate();

        // **每一步都重算预算。** 第 0 步之后消息会变长(工具调用与结果都进了上下文),
        // 只在请求前算一次的话,多步轮次会在中途悄悄超窗。
        //
        // 两条边界写明,不粉饰:
        // 1) 这里只拿得到 `ModelMessage[]`,**没有对应的 `viewEntries`** ——
        //    这些消息是 SDK 自己装配的(含它执行工具产生的结果),不在
        //    `mergedMessages` 里。所以轮内**用不了基准路径**,只能全量估算。
        // 2) 阶梯第 1 步(省略旧工具结果)留在请求前:按 AG-UI 下标做省略,
        //    对不上 SDK 装配出来的这一份。轮内只做第 4 步的拦截。
        if (stepNumber > 0) {
          assertWithinContextBudget({
            estimatedInput: estimatedInputTokens(stepMessages, systemPrompt, serverTools),
            // 轮内已经无从区分「可压缩/不可压缩」—— 传同一个值,
            // 于是走的一定是「先压缩或开新会话」那条文案,不会误报成
            // 「最近一轮本身超窗」。
            irreducibleInput: 0,
            contextWindow,
            outputReserve,
            modelLabel: selection.snapshot.label,
          });
        }
        // 其余字段可选 —— 不覆盖 messages,只把预留对齐。
        return { maxOutputTokens: outputReserve };
      },
      onFinish: (ev) => {
        llmChatLog.info("ai2nao streamText onFinish", {
          threadId: input.threadId,
          finishReason: ev.finishReason,
          usage: ev.totalUsage,
        });
      },
      onError: ({ error }) => {
        llmChatLog.error("ai2nao streamText onError", error);
      },
    });

    // 用户这一条先落库 —— 模型调用之前。历史消息一并 upsert 是幂等的,
    // 已存在的行原地覆盖、索引不动。
    // **落的是净化后的那份**:客户端伪造的 `reasoning` / `activity` 行以及
    // `ai2nao*` 字段绝不能从这条路进库。
    persistWithRetry(deps.db, input.threadId, () => clientMessages);

    // 每步落库:把到目前为止生成的消息整体 upsert 一遍。
    // `GeneratedMessages` 是**整轮形状**,没有步边界,所以这里不做切片 ——
    // 重复 upsert 同一行本来就是幂等的,反而比自己维护步边界更难出错。
    // 本步成功那笔账的 id,按步号存。中间件在 provider 的 `finish` 分片结算,
    // 实测顺序是 settle → finish-step,所以 persistStep 跑到时它已经在这里了。
    // 主回答与补答共用这一张表:两者 stepIndex 不冲突(补答固定 0,而它自己的
    // 思考行 id 里带 `finalize`),而共用省得为「同一件事」维护两份状态。
    const completedCallIds = new Map<number, string>();
    // 生成器在 text-end 交出来的三样,等 persistStep 补齐另外三样。
    const pendingReasoning = new Map<string, ReasoningStreamMeta & { stepIndex: number }>();

    const persistStep = () => {
      // **先补思考元数据,再落库。** 反过来的话这一步落的思考行还没有元数据,
      // 要等下一步的 upsert 才补上 —— 而最后一步之后没有下一步。
      for (const [reasoningMessageId, meta] of pendingReasoning) {
        generated.setReasoningMeta(reasoningMessageId, {
          v: 1,
          runId: claim.run.runId,
          assistantMessageId: meta.assistantMessageId,
          // 取不到就写 null,不崩也不等 —— 正确性不押在事件顺序上。
          callId: completedCallIds.get(meta.stepIndex) ?? null,
          provider: cfg.provider,
          source: meta.source,
          durationMs: meta.durationMs,
        });
      }
      pendingReasoning.clear();
      try {
        persistWithRetry(deps.db, input.threadId, () =>
          stampModelSnapshot(generated.messages(), selection.snapshot)
        );
      } catch (error) {
        // 记下来给 prepareStep 用:抛出去只能中止当前这一轮的消费,
        // 拦住「下一笔请求」要靠闸那一侧。
        persistFailure = error instanceof Error ? error : new Error(String(error));
        throw error;
      } finally {
        openGate();
      }
    };

    for await (const event of aiSdkStreamToAgUiEvents(result.fullStream, {
      executeTextToolCall: createTextToolCallExecutor(serverTools, modelMessages, abortSignal),
      onStepFinish: persistStep,
      // 回调而不是值:这个生成器整轮只被调用一次,而 currentStepIndex 每步都变。
      // 传值的话第二步之后全是第一步的号,思考与正文会被并进同一条消息。
      stepKey: () => `${claim.run.runId}:answer:${currentStepIndex}`,
      onProtocolText: (id, raw) => generated.setProtocol(id, raw),
      // 只暂存,不就地盖 —— callId 这时还没产生(见 onReasoning 的注释)。
      onReasoning: (id, meta) =>
        pendingReasoning.set(id, { ...meta, stepIndex: currentStepIndex }),
    })) {
      generated.apply(event);
      yield event;
    }
    throwIfStopped(abortSignal);

    if (generated.needsFinalAnswer()) {
      const finalMessages = finalAnswerModelMessages(
        mergeAgUiMessages(mergedMessages, generated.messages())
      );
      // 补答把整轮揉成**一条新合成的 user 消息**,不携带任何原始 messageId,
      // 所以指纹只能是退化值。用一个一眼看得出不是真实 id 的常量 ——
      // 反正设计里 finalize 永不作为估算基准。
      const finalViewEntries: SendViewEntry[] = [{ messageId: "__finalize__", tag: "raw" }];
      const finalResult = streamText({
        // **必须是新的中间件实例。** attempt 是工厂闭包里的计数器,
        // 与主回答共用一个实例会串号,账目行 id 就会互相覆盖。
        // 补答没有传 prepareStep,currentStepIndex 不会被它更新,所以固定用 0 ——
        // purpose 已经是 finalize,callId 里两者组合不会与 answer 撞号。
        model: wrapLanguageModel({
          model: (deps.createModel ?? createChatLanguageModel)(cfg),
          middleware: createAccountingMiddleware({
            db: deps.db,
            sessionId: input.threadId,
            runId: claim.run.runId,
            fence: claim.run.fence,
            purpose: "finalize",
            model: selection.snapshot,
            stepIndex: () => 0,
            // **工具集是空的** —— 下面那个 streamText 根本不传 `tools`。
            // 照抄主回答的 `serverTools` 会让这笔账的指纹谎称带了工具。
            sendView: () =>
              sendViewOf(finalViewEntries, finalAnswerSystemPrompt(systemPrompt), {}),
            maxOutputTokens: outputReserve,
            // 补答的思考同样要带 callId。**别因为它「只有一步」就省掉** ——
            // 省掉的话补答产生的思考行 callId 恒为 null,而这类静默缺失
            // tsc 与测试都照不出来(可选字段不传合法、null 不影响别的断言)。
            onCallCompleted: (callId, stepIndex) => completedCallIds.set(stepIndex, callId),
            abortSignal,
          }),
        }),
        system: finalAnswerSystemPrompt(systemPrompt),
        messages: finalMessages,
        abortSignal,
        maxOutputTokens: outputReserve,
        stopWhen: stepCountIs(1),
      });
      // 补答固定 stepIndex 0,与上面记账里 `stepIndex: () => 0` 的口径一致;
      // purpose 不同,所以 id 不会与主回答撞号。
      for await (const event of aiSdkStreamToAgUiEvents(finalResult.fullStream, {
        stepKey: () => `${claim.run.runId}:finalize:0`,
      })) {
        generated.apply(event);
        yield event;
      }
      throwIfStopped(abortSignal);
    }

    if (generated.needsFinalAnswer()) {
      const fallback = deterministicEvidenceAnswer(
        mergeAgUiMessages(mergedMessages, generated.messages())
      );
      const fallbackEvent = textChunkEvent(randomUUID(), fallback);
      generated.apply(fallbackEvent);
      yield fallbackEvent;
    }

    // **写库之前先验执行权。** 租约只是心跳,不等于执行权:如果这一轮中途被
    // 别的进程接管(比如本机休眠过),那边已经在推进同一个会话,两边都写会交错。
    if (!isChatRunCurrent(deps.db, input.threadId, claimed.fence)) {
      throw new Error("这一轮已被另一个进程接管，本次生成没有写入。");
    }
    // 收尾再落一次:补答与兜底回答是在步骤循环之外产生的,没有 finish-step。
    // 快照盖在这一轮新产生的消息上;历史消息已经带着它们当时那一家,不覆盖。
    persistStep();
    yield { type: EventType.RUN_FINISHED, threadId: input.threadId, runId } as BaseEvent;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 取消与失败要分开记:取消是日常操作,失败才需要排查。
    terminal = abortSignal.aborted ? "aborted" : "failed";
    // **中止时把这一步已经产生的内容落库。** 用户眼看着它流出来了,刷新就没了
    // 是说不过去的;钱也已经花了。落库前剔掉没有结果的工具调用。
    // 判空不是兜底,是语义:为 null 说明 selection 还没就位就被取消了 ——
    // 那种情况下本来就没有半步可落。
    if (claimed && terminal === "aborted" && persistAbortHalfStep) {
      try {
        persistAbortHalfStep();
      } catch (persistError) {
        // 中止路径上的落库失败只记日志:这一轮已经在收尾,再抛只会盖掉原始错误。
        llmChatLog.error("ai2nao abort persist failed", persistError);
      }
    }
    if (terminal === "aborted") {
      // **停止是日常操作,不是错误。** CopilotKit 点停止会调 runner 的 `stop`,响应流此时
      // 还开着 —— 发 RUN_ERROR 的话,用户每次点停止都会看见一条错误横幅(2026-09-19 实测)。
      // 正常收尾,与这道闸加上之前「中止后流照常结束」时前端看到的事件序列一致。
      llmChatLog.info("ai2nao run stopped by user");
      yield { type: EventType.RUN_FINISHED, threadId: input.threadId, runId } as BaseEvent;
    } else {
      llmChatLog.error("ai2nao run failed", message);
      yield {
        type: EventType.RUN_ERROR,
        threadId: input.threadId,
        runId,
        message,
        code: "ai2nao_run_failed",
      } as BaseEvent;
    }
  } finally {
    if (leaseTimer) clearInterval(leaseTimer);
    if (claimed) {
      completeChatRun(deps.db, input.threadId, claimed.runId, terminal);
      // 兜底:中间件没结算到的账(上游半路断开、流被取消)不能永远挂在 pending。
      // 这一轮是正常结束的话,剩下的 pending 只可能是失败;否则跟随本轮终态。
      settlePendingChatCalls(
        deps.db,
        input.threadId,
        claimed.runId,
        terminal === "aborted" ? "aborted" : "failed"
      );
    }
    runningThreadIds.delete(input.threadId);
    runningThreadStops.delete(input.threadId);
  }
}

export async function* aiSdkStreamToAgUiEvents(
  fullStream: AsyncIterable<unknown>,
  options: AiSdkStreamToAgUiOptions = {}
): AsyncGenerator<BaseEvent> {
  const toolCalls = new Map<string, ToolCallState>();
  const dsml = new DsmlToolCallBuffer();
  // 每条消息一个:text-start 时重建,避免上一条的未闭合状态串到下一条。
  let think = new ThinkStreamFilter();
  // 显式标 string:`randomUUID()` 的返回类型是模板字面量 `${string}-${string}-…`,
  // 不标的话这个变量就被窄化成 UUID 形状,而按 stepKey 派生出来的 `a:run:answer:0`
  // 不符合那个形状,赋值处直接 TS2322。
  let messageId: string = randomUUID();
  // 本条消息的未过滤原文。**与 think 分流是两件事**:那边产出的是剥离后的
  // 可见文本与思考两路,这里留的是「厂商原样发过来的样子」,一个字节都不动。
  let protocolRaw = "";
  // 思考消息 id。**与正文分开一条** —— AG-UI 的 transformChunks 在文本与思考之间
  // 切换时会自动冲掉上一条,不必手动闭合,但两者的 id 不能共用。
  let reasoningId: string | null = null;
  // 思考来源与起始时刻。**首次有思考时才记**,所以没有思考的步骤不会留下元数据。
  let reasoningSource: "reasoning-stream" | "think-tag" | null = null;
  let reasoningStartedAt = 0;

  function stepScopedId(prefix: "a" | "r"): string | null {
    const key = options.stepKey?.();
    return key ? `${prefix}:${key}` : null;
  }

  /**
   * 思考增量转 AG-UI 事件。
   *
   * **空串一律不发。** 四条既有用例断言的是完整事件类型序列,每步都配一对空事件
   * 会让它们全红;前端也会多出空的思考块。惰性开号还有个好处:没有思考的步骤
   * 不白占一个 id。
   *
   * 每条都带 `messageId`:`transformChunks` 只要求**第一条**带
   * (`First REASONING_MESSAGE_CHUNK must have a messageId`),但同一个 id 重复带
   * 不会出问题,而「只在第一条带」要额外维护一个布尔量 —— 多一处可错的状态。
   */
  function* emitThinking(
    text: string,
    source: "reasoning-stream" | "think-tag"
  ): Generator<BaseEvent> {
    if (!text) return;
    if (reasoningId === null) {
      reasoningId = stepScopedId("r") ?? randomUUID();
      reasoningSource = source;
      reasoningStartedAt = Date.now();
    }
    yield {
      type: EventType.REASONING_MESSAGE_CHUNK,
      messageId: reasoningId,
      delta: text,
    } as BaseEvent;
  }

  /** 思考消息收尾:把生成器这一侧知道的三样交出去,然后清空本步状态。 */
  function reportReasoning(): void {
    if (reasoningId === null || reasoningSource === null) return;
    options.onReasoning?.(reasoningId, {
      // **按 stepKey 派生,不读当前的 `messageId`。**
      //
      // 这个回调可能在 `reasoning-end` 就触发,而那时本步的 `text-start` 往往还没来
      // (DeepSeek 的形状就是先思考后正文),`messageId` 还停在生成器初始化时的
      // 那个随机 uuid —— 实测拿到的就是裸 uuid,不是 `a:…:answer:0`。
      // stepKey 只依赖 runId / purpose / stepIndex,与事件到达顺序无关;
      // `reasoningId` 用的也是同一条路子,所以它一直是对的。
      assistantMessageId: stepScopedId("a") ?? messageId,
      source: reasoningSource,
      durationMs: Math.max(0, Date.now() - reasoningStartedAt),
    });
    reasoningSource = null;
  }
  for await (const raw of fullStream) {
    const part = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    if (!part) continue;
    switch (part.type) {
      case "text-start": {
        messageId = stepScopedId("a") ?? randomUUID();
        think = new ThinkStreamFilter();
        // 新的一步:思考另起一条消息,不要把上一步的思考续到这一条上。
        reasoningId = null;
        reasoningSource = null;
        protocolRaw = "";
        break;
      }
      case "text-delta": {
        const delta = stringValue(part.text) || stringValue(part.delta);
        if (!delta) break;
        // **先剥 <think> 再交给 DSML。** 顺序不能反:think 块里的内容不该被
        // 当成工具调用去解析,而且它压根不该到达前端 —— T0 实测 MiniMax 的
        // 第一条 delta 就是 "<think>\n用户问",不挡就直接流进气泡。
        // **累积必须在剥离之前。** `delta` 此刻还是厂商原样的那一段;
        // 交给 think.push() 之后拿到的已经是剥过的,再拼就不是原文了。
        protocolRaw += delta;
        const visible = think.push(delta);
        // **思考先发。** MiniMax 的形状就是先 `<think>` 后正文;顺序反了,
        // 前端会先看到答案、思考随后才冒出来。
        yield* emitThinking(think.takeThinking(), "think-tag");
        if (visible) yield* dsml.consume(visible, messageId, options.executeTextToolCall);
        break;
      }
      case "text-end": {
        // 扣住的尾巴若不在 think 块里,它其实是普通文本,收尾时补吐。
        const tail = think.finish();
        // 未闭合的 think 在 finish() 里归进思考旁路,这里一并发出去。
        yield* emitThinking(think.takeThinking(), "think-tag");
        if (tail) yield* dsml.consume(tail, messageId, options.executeTextToolCall);
        // 一条消息只回报一次,在它收尾时 —— 中途回报的话,消费方要么反复覆盖,
        // 要么得自己拼增量,两种都比这里多一处可错的状态。
        if (protocolRaw) options.onProtocolText?.(messageId, protocolRaw);
        // 思考元数据同理:这一步的思考到此为止,交出生成器知道的那三样。
        reportReasoning();
        break;
      }
      case "tool-input-start": {
        const toolCallId = stringValue(part.id) || stringValue(part.toolCallId) || randomUUID();
        const toolName = stringValue(part.toolName) || "unknown_tool";
        const state = ensureToolState(toolCalls, toolCallId, toolName);
        state.name = toolName;
        if (!state.started) {
          state.started = true;
          yield toolCallStartEvent(toolCallId, state.name, messageId);
        }
        break;
      }
      case "tool-input-delta": {
        const toolCallId = stringValue(part.id) || stringValue(part.toolCallId);
        const delta = stringValue(part.delta) || stringValue(part.inputTextDelta);
        if (!toolCallId || !delta) break;
        const state = ensureToolState(toolCalls, toolCallId, stringValue(part.toolName));
        if (!state.started) {
          state.started = true;
          yield toolCallStartEvent(toolCallId, state.name, messageId);
        }
        state.args += delta;
        state.hasArgsDelta = true;
        yield { type: EventType.TOOL_CALL_ARGS, toolCallId, delta } as BaseEvent;
        break;
      }
      case "tool-input-available":
      case "tool-call": {
        const toolCallId = stringValue(part.toolCallId) || stringValue(part.id) || randomUUID();
        const toolName = stringValue(part.toolName) || "unknown_tool";
        const state = ensureToolState(toolCalls, toolCallId, toolName);
        state.name = toolName || state.name;
        if (!state.started) {
          state.started = true;
          yield toolCallStartEvent(toolCallId, state.name, messageId);
        }
        if (!state.hasArgsDelta && (part.type === "tool-input-available" || !state.args)) {
          const input = "input" in part ? stringifyJson(part.input) : "";
          if (input) {
            state.args = input;
            state.hasArgsDelta = true;
            yield { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: input } as BaseEvent;
          }
        }
        if (!state.ended) {
          state.ended = true;
          yield { type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent;
        }
        break;
      }
      case "tool-input-end": {
        break;
      }
      case "tool-result":
      case "tool-output-available": {
        const toolCallId = stringValue(part.toolCallId) || stringValue(part.id) || randomUUID();
        const state = ensureToolState(toolCalls, toolCallId, stringValue(part.toolName));
        if (!state.started) {
          state.started = true;
          yield toolCallStartEvent(toolCallId, state.name, messageId);
        }
        if (!state.ended) {
          state.ended = true;
          yield { type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent;
        }
        yield {
          type: EventType.TOOL_CALL_RESULT,
          role: "tool",
          messageId: randomUUID(),
          toolCallId,
          content: stringifyJson(part.output ?? part.result),
        } as BaseEvent;
        break;
      }
      case "tool-error":
      case "tool-output-error": {
        const toolCallId = stringValue(part.toolCallId) || stringValue(part.id) || randomUUID();
        const state = ensureToolState(toolCalls, toolCallId, stringValue(part.toolName));
        if (!state.started) {
          state.started = true;
          yield toolCallStartEvent(toolCallId, state.name, messageId);
        }
        if (!state.ended) {
          state.ended = true;
          yield { type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent;
        }
        yield {
          type: EventType.TOOL_CALL_RESULT,
          role: "tool",
          messageId: randomUUID(),
          toolCallId,
          content: stringifyJson({ ok: false, error: stringValue(part.errorText) || stringifyJson(part.error) }),
        } as BaseEvent;
        break;
      }
      case "error": {
        const error = part.error ?? part.errorText ?? part.message;
        throw new Error(error instanceof Error ? error.message : String(error));
      }
      case "finish":
        yield* closeActiveToolCalls(toolCalls);
        break;
      case "finish-step":
        await options.onStepFinish?.();
        break;
      case "reasoning-delta": {
        // **这里是 SDK 层(`TextStreamPart`),字段叫 `text`。**
        //
        // 两层各自内部一致、层与层之间不同:provider 层
        // (`LanguageModelV3StreamPart`)正文与思考都用 `delta`;SDK 层
        // (`streamText().fullStream`)正文与思考都用 `text`。按 provider 层的形状
        // 只读 `delta`,取到的恒是空串 —— 思考静默为空,而单测因为直接往生成器里
        // 喂 `delta` 形状的分片,照样全绿。这个 bug 就是这么来的,由一次
        // `fullStream` 实跑打印确认(`{"type":"reasoning-delta","id":"r-1","text":"…"}`)。
        //
        // 两个都读,与上面正文那一支的写法保持一致,换层也不会再哑。
        yield* emitThinking(stringValue(part.text) || stringValue(part.delta), "reasoning-stream");
        break;
      }
      // reasoning-start / reasoning-end 不用管:transformChunks 在文本与思考之间
      // 切换时自行冲洗上一条消息,收尾也由它负责。
      case "reasoning-end": {
        // **思考结束就回报,不等 text-end。** 一步里很可能只有思考加工具调用、
        // 根本没有正文(`text-end` 永远不来),那时元数据会整个丢掉。
        // `reportReasoning` 自带一次性闸(回报后把 source 清空),所以
        // 「思考 + 正文」的步骤在这里报过之后,text-end 再调也不会重复。
        reportReasoning();
        break;
      }
      case "start-step": {
        // **每步一开始就换成这一步的 id,不等 text-start。** 一步里很可能只有思考加工具
        // 调用、一个字正文都没有(DeepSeek V4 带工具时常见),只在 text-start 换的话:
        // ① 工具调用挂在上一步 / 初始化时的随机 id 下,assistant 行的 id 不是
        //    `a:…:answer:N`,而思考行配对写的是 `a:…:answer:N` —— 指向一条不存在的消息;
        // ② `reasoningId` 不重置,下一步的思考续进这一步的思考行(两步思考并成一行)。
        // 两者都让下一轮回传拿不到这段思考。2026-09-19 真实 DeepSeek 实测照出。
        messageId = stepScopedId("a") ?? randomUUID();
        think = new ThinkStreamFilter();
        reasoningId = null;
        reasoningSource = null;
        protocolRaw = "";
        break;
      }
      case "reasoning-start":
      case "source":
      case "raw":
        break;
      default:
        break;
    }
  }
  yield* dsml.finish();
  yield* closeActiveToolCalls(toolCalls);
}

class DsmlToolCallBuffer {
  private pending = "";
  private active = false;

  async *consume(
    delta: string,
    messageId: string,
    executeTextToolCall: AiSdkStreamToAgUiOptions["executeTextToolCall"]
  ): AsyncGenerator<BaseEvent> {
    this.pending += delta;

    while (this.pending) {
      if (!this.active) {
        const start = findDsmlToolCallsStart(this.pending);
        if (start < 0) {
          const holdLength = trailingDsmlStartPrefixLength(this.pending);
          const visible = this.pending.slice(0, this.pending.length - holdLength);
          if (visible) yield textChunkEvent(messageId, visible);
          this.pending = this.pending.slice(this.pending.length - holdLength);
          return;
        }

        const visible = this.pending.slice(0, start);
        if (visible) yield textChunkEvent(messageId, visible);
        this.pending = this.pending.slice(start);
        this.active = true;
      }

      const end = findDsmlToolCallsEnd(this.pending);
      if (end < 0) return;

      const block = this.pending.slice(0, end);
      this.pending = this.pending.slice(end);
      this.active = false;

      for (const call of parseDsmlToolCalls(block)) {
        yield* runDsmlTextToolCall(call, messageId, executeTextToolCall);
      }
    }
  }

  *finish(): Generator<BaseEvent> {
    if (!this.active && this.pending) {
      yield textChunkEvent(randomUUID(), this.pending);
    }
    this.pending = "";
    this.active = false;
  }
}

async function* runDsmlTextToolCall(
  call: DsmlTextToolCall,
  messageId: string,
  executeTextToolCall: AiSdkStreamToAgUiOptions["executeTextToolCall"]
): AsyncGenerator<BaseEvent> {
  if (!executeTextToolCall) return;
  yield toolCallStartEvent(call.id, call.name, messageId);
  yield { type: EventType.TOOL_CALL_ARGS, toolCallId: call.id, delta: stringifyJson(call.input) } as BaseEvent;
  yield { type: EventType.TOOL_CALL_END, toolCallId: call.id } as BaseEvent;

  try {
    const output = await executeTextToolCall(call);
    yield {
      type: EventType.TOOL_CALL_RESULT,
      role: "tool",
      messageId: randomUUID(),
      toolCallId: call.id,
      content: stringifyJson(output),
    } as BaseEvent;
  } catch (error) {
    yield {
      type: EventType.TOOL_CALL_RESULT,
      role: "tool",
      messageId: randomUUID(),
      toolCallId: call.id,
      content: stringifyJson({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    } as BaseEvent;
  }
}

function createTextToolCallExecutor(
  tools: ToolSet,
  messages: ModelMessage[],
  abortSignal: AbortSignal
): (call: DsmlTextToolCall) => Promise<unknown> {
  return async (call) => {
    const tool = tools[call.name] as { execute?: (input: unknown, options: unknown) => unknown } | undefined;
    if (!tool?.execute) {
      throw new Error(`Unsupported server tool emitted as text: ${call.name}`);
    }
    const output = await tool.execute(call.input, {
      toolCallId: call.id,
      messages,
      abortSignal,
    });
    return collectToolExecutionOutput(output);
  };
}

async function collectToolExecutionOutput(output: unknown): Promise<unknown> {
  const awaited = await output;
  if (!isAsyncIterable(awaited)) return awaited;
  let latest: unknown = null;
  for await (const item of awaited) latest = item;
  return latest;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(value) && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";
}

function parseDsmlToolCalls(block: string): DsmlTextToolCall[] {
  const normalized = normalizeDsml(block);
  const calls: DsmlTextToolCall[] = [];
  const invokeRe = /<\|\|DSML\|\|invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|\|DSML\|\|invoke>/g;
  let invokeMatch: RegExpExecArray | null;

  while ((invokeMatch = invokeRe.exec(normalized))) {
    const [, rawName, body] = invokeMatch;
    const name = decodeDsmlText(rawName).trim();
    if (!name) continue;
    const input: Record<string, unknown> = {};
    const paramRe = /<\|\|DSML\|\|parameter\s+name="([^"]+)"(?:\s+string="([^"]+)")?\s*>([\s\S]*?)<\/\|\|DSML\|\|parameter>/g;
    let paramMatch: RegExpExecArray | null;

    while ((paramMatch = paramRe.exec(body))) {
      const [, rawParamName, stringFlag, rawValue] = paramMatch;
      const paramName = decodeDsmlText(rawParamName).trim();
      if (!paramName) continue;
      input[paramName] = parseDsmlParameterValue(rawValue, stringFlag);
    }

    calls.push({ id: `dsml-${randomUUID()}`, name, input });
  }

  return calls;
}

function parseDsmlParameterValue(rawValue: string, stringFlag: string | undefined): unknown {
  const value = decodeDsmlText(rawValue).trim();
  if (stringFlag !== "false") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null") return null;
    return value;
  }
}

function findDsmlToolCallsStart(value: string): number {
  return normalizeDsml(value).indexOf("<||DSML||tool_calls>");
}

function findDsmlToolCallsEnd(value: string): number {
  const token = "</||DSML||tool_calls>";
  const index = normalizeDsml(value).indexOf(token);
  return index < 0 ? -1 : index + token.length;
}

function trailingDsmlStartPrefixLength(value: string): number {
  const normalized = normalizeDsml(value);
  const token = "<||DSML||tool_calls>";
  const max = Math.min(token.length - 1, normalized.length);
  for (let length = max; length > 0; length--) {
    if (token.startsWith(normalized.slice(-length))) return length;
  }
  return 0;
}

function normalizeDsml(value: string): string {
  return value.replaceAll("｜", "|");
}

function decodeDsmlText(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function textChunkEvent(messageId: string, delta: string): BaseEvent {
  return {
    type: EventType.TEXT_MESSAGE_CHUNK,
    messageId,
    role: "assistant",
    delta,
  } as BaseEvent;
}

/**
 * 历史里最多重发几张图。**只约束历史,当前这条消息的图一张都不能少** ——
 * 「一次贴三张做横向对比」是贴图的主场景之一,静默丢掉一张会让模型答错而没人知道。
 *
 * 为什么要有上限:一张截图约合 1000-1600 token,而对话是累积的。贴一张追问五轮,
 * 不设窗口就是同一张图付六次钱。
 */
const HISTORY_IMAGE_WINDOW = 2;

/** AG-UI 的 image part 形状(`sessions.ts` 抽取后是 url 源,抽取前是 data 源)。 */
type AgUiImageSource = { type?: unknown; value?: unknown; mimeType?: unknown };

function imageSourceOf(part: unknown): AgUiImageSource | null {
  if (!part || typeof part !== "object") return null;
  const p = part as { type?: unknown; source?: unknown };
  if (p.type !== "image") return null;
  if (!p.source || typeof p.source !== "object") return null;
  return p.source as AgUiImageSource;
}

/**
 * 把一个 image part 解成字节。
 *
 * **两种形状都要认。** `copilotRuntime` 建 payload(:300)在
 * `replaceLlmChatSessionMessages`(:356)之前 —— 也就是模型调用先于持久化,
 * 所以本轮新消息拿到的还是前端发来的**内联 data**,只有历史消息才是 url 引用。
 *
 * 取不到返回 null,调用方降级成文字占位 —— blob 文件被手工删掉时不该静默少一张图。
 */
function imageBytesOf(source: AgUiImageSource): Buffer | null {
  const value = typeof source.value === "string" ? source.value : "";
  if (!value) return null;
  if (source.type === "url") {
    const sha = value.startsWith("/api/blobs/") ? value.slice("/api/blobs/".length) : "";
    return sha ? getBlob(sha) : null;
  }
  if (source.type === "data") {
    try {
      const b = Buffer.from(value, "base64");
      return b.length > 0 ? b : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** 窗口外的历史图换成这个 —— 让模型知道「这里曾经有张图」,而不是凭空少一段。 */
function imagePlaceholder(source: AgUiImageSource): string {
  const mime = typeof source.mimeType === "string" ? source.mimeType : "图片";
  return `[你在这里贴过一张 ${mime} 截图，为控制上下文长度未重复发送]`;
}

/**
 * 这一轮带图但当前 provider 的适配器发不出图 → 抛,由外层变成 `RUN_ERROR`。
 *
 * **这一条不设后门。** 「仍要发送」那个后门是为「models.dev 目录可能过期、
 * 模型其实能用」留的;适配器发不出去是我们自己依赖的确定事实,放行只会让用户
 * 为一张根本没送出去的图付钱 —— 那正是本设计要防的失败模式。
 *
 * **只查适配器表,不查 models.dev 目录 —— 有意为之,不是漏了。** 目录说不收图
 * (`catalog-no`)只在前端置灰并留「仍要发送」后门。后端若也按目录硬拦,后门就
 * 发不出去;而把「用户点了后门」这个标志从前端传进来再校验,控制它的仍是同一个
 * 前端,并不增加任何保护。后端只守确定事实。
 *
 * 导出是为了单测能直接打它,不必跑完整回合。
 */
export function assertCanSendImages(
  modelMessages: ModelMessage[],
  provider: LlmChatProvider
): void {
  if (PROVIDER_ADAPTER_CAPABILITIES[provider].sendsImages) return;
  const hasImage = modelMessages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((p) => typeof p === "object" && p !== null && p.type === "image")
  );
  if (!hasImage) return;
  throw new Error(
    `当前服务商（${provider}）的接入方式发不出图片，这一轮没有发送。` +
      `请换一个能读图的模型再试 —— 直接发出去的话图会被丢掉，而费用照扣。`
  );
}

/**
 * 取一条 assistant 消息上的协议原文(厂商原样的 content)。
 *
 * 两种形态:行里直接存 `{v:1,content}`,或超过单行阈值后移进 blob 的 `{v:1,blobSha256}`。
 * **取不到一律返回 null,由调用方决定退化** —— 与 `imageBytesOf` 同一种约定。
 */
function protocolContentOf(message: Message): string | null {
  const p = (message as { ai2naoProtocol?: unknown }).ai2naoProtocol;
  if (!isRecord(p)) return null;
  if (typeof p.content === "string") return p.content;
  if (typeof p.blobSha256 === "string") {
    const bytes = getBlob(p.blobSha256);
    return bytes ? bytes.toString("utf8") : null;
  }
  return null;
}

/**
 * `provider` 可选:**不传就完全不回传思考**,与加这个参数之前的行为一字不差。
 *
 * 这样 15 处测试调用点一处都不用动,而"纯重构那一步不改变行为"也由签名本身保证,
 * 不靠我记得去核对。生产路径只有一个调用点(`runAi2NaoTurnEvents` 里),在那里传。
 */
export function agUiMessagesToModelMessages(
  messages: Message[],
  provider?: LlmChatProvider,
  /**
   * 可选出参:逐条上报**实际发生**的变换,给发送视图指纹用。
   *
   * 做成出参而不是改返回类型,是因为这个函数有 28 处调用点(其中 26 处在测试里)——
   * 改返回类型会把一大片与本功能无关的改动混进来,真正的改动反而被埋掉。
   *
   * 代价是「可选参数没人传」这种静默失效,本仓库在 `onCallCompleted` 上踩过。
   * 对策不是类型,是一条专门的断言:账目行里 `sendView.count` 必须等于真实发送
   * 条数 —— 没接上时它恒为 0,那条测试就会红。
   */
  view?: SendViewEntry[],
  /**
   * 下标小于它的 `tool` 消息,正文换成占位(**只影响本次发送,不写记录**)。
   * 超预算阶梯第 1 步用它:省略「最近 3 个用户轮之前」的工具结果,
   * 而调用与结果的配对保持不变 —— 拆开配对会让厂商直接 400。
   */
  omitToolResultsBefore?: number
): ModelMessage[] {
  const toolNames = new Map<string, string>();
  const modelMessages: ModelMessage[] = [];
  // **紧跟在每个 push 之后调用。** 被 `continue` 跳过、根本没发出去的消息不进指纹,
  // 否则 `count` 会比实际发送条数多,基准比对整片失效。
  const tag = (m: Message, t: SendViewTag) => {
    view?.push({ messageId: String(m.id), tag: t });
  };
  const replay = provider ? PROVIDER_ADAPTER_CAPABILITIES[provider].reasoningReplay : "none";

  // **先建索引再遍历。** 思考行与它所属的 assistant 行是两条独立消息,靠
  // `ai2naoReasoning.assistantMessageId` 配对;而下面是单趟顺序处理,
  // 不预先建表就配不上(思考行可能排在 assistant 行之前,也可能之后)。
  // 只回传给**产生它的同一家厂商** —— 换了厂商,上一家的思考不能带过去。
  const reasoningByAssistantId = new Map<string, string>();
  if (replay === "reasoning-part") {
    for (const m of messages) {
      if (m.role !== "reasoning") continue;
      const meta = (m as { ai2naoReasoning?: unknown }).ai2naoReasoning;
      if (!isRecord(meta) || meta.provider !== provider) continue;
      const assistantId = typeof meta.assistantMessageId === "string" ? meta.assistantMessageId : "";
      const content = textFromAgUiMessage(m).trim();
      if (assistantId && content) reasoningByAssistantId.set(assistantId, content);
    }
  }

  // 先数清楚哪些图属于「当前这条消息」,哪些属于历史 —— 两者规则不同。
  // 当前 = 最后一条带内容的 user 消息;它的图全部原样发送。
  let lastUserIdx = -1;
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === "user") lastUserIdx = i;
  }
  // 历史图从后往前数,只保留最近 HISTORY_IMAGE_WINDOW 张。
  const historyImageKeys: string[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (i === lastUserIdx || messages[i]?.role !== "user") continue;
    const c = (messages[i] as { content?: unknown }).content;
    if (!Array.isArray(c)) continue;
    for (let j = c.length - 1; j >= 0; j -= 1) {
      if (imageSourceOf(c[j])) historyImageKeys.push(`${i}:${j}`);
    }
  }
  const keepHistoryImages = new Set(historyImageKeys.slice(0, HISTORY_IMAGE_WINDOW));

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx += 1) {
    const message = messages[msgIdx]!;
    const text = textFromAgUiMessage(message).trim();
    if (message.role === "system" && text) {
      modelMessages.push({ role: "system", content: text });
      tag(message, "raw");
      continue;
    }
    if (message.role === "developer" && text) {
      modelMessages.push({ role: "system", content: text });
      tag(message, "raw");
      continue;
    }
    if (message.role === "user") {
      // **守卫不能只看 text。** 原来是 `role === "user" && text`,而
      // `textFromAgUiMessage` 只取 type==="text" 的 part —— 「粘一张截图、
      // 什么都不打、回车」这条最常见的消息 text 为空,会落空所有分支被整条丢弃,
      // 模型连「用户发了东西」都不知道。
      const parts: Array<
        { type: "text"; text: string } | { type: "image"; image: Buffer }
      > = [];
      // 标签要反映**这一条**发生了什么,不能按全局配置推 —— 同一轮里有的消息
      // 换了占位、有的原样发出。
      let usedPlaceholder = false;
      const rawContent = (message as { content?: unknown }).content;
      if (Array.isArray(rawContent)) {
        for (let j = 0; j < rawContent.length; j += 1) {
          const src = imageSourceOf(rawContent[j]);
          if (!src) continue;
          const isCurrent = msgIdx === lastUserIdx;
          if (!isCurrent && !keepHistoryImages.has(`${msgIdx}:${j}`)) {
            parts.push({ type: "text", text: imagePlaceholder(src) });
            usedPlaceholder = true;
            continue;
          }
          const bytes = imageBytesOf(src);
          if (bytes) parts.push({ type: "image", image: bytes });
          // 取不到就明说,不静默少一张 —— blob 被手工删掉时用户看得出发生了什么。
          else parts.push({ type: "text", text: "[这张图已不在本机附件仓]" });
        }
      }
      if (text) parts.unshift({ type: "text", text });
      if (parts.length === 0) continue;
      // 纯文本时仍发字符串,不发单元素数组 —— 与改动前逐字节一致,
      // 免得给每一条历史文本消息都换一种线格式。
      if (parts.length === 1 && parts[0]!.type === "text") {
        modelMessages.push({ role: "user", content: parts[0]!.text });
      } else {
        modelMessages.push({ role: "user", content: parts } as ModelMessage);
      }
      tag(message, usedPlaceholder ? "image-placeholder" : "raw");
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = agUiToolCalls(message);
      for (const call of toolCalls) toolNames.set(call.id, call.function.name);

      // MiniMax 一档:content 必须是厂商原样那一份(含 `<think>` 与原始空白)。
      // **原文缺失就退回「不回传」,绝不用展示文本顶替** —— 官方要求 content
      // 不得修改,从剥离后的文本重拼是拼不回去的;而塞一段占位文字进去,
      // 等于伪造一段模型没说过的思考。宁可这一轮不带思考,也不带错的。
      const protocol = replay === "protocol-content" ? protocolContentOf(message) : null;
      const body = protocol ?? text;

      // DeepSeek 一档:思考还原成 assistant 的 reasoning part,适配器会转成
      // `reasoning_content`。**字段是 `text`** —— AG-UI 事件那层叫 `delta`、
      // provider 流那层也叫 `delta`,三层三种命名,照抄另一层必取到 undefined。
      const reasoning =
        replay === "reasoning-part" ? reasoningByAssistantId.get(String(message.id)) : undefined;
      const reasoningParts = reasoning ? [{ type: "reasoning" as const, text: reasoning }] : [];
      // **按实际结果定标签,不按 `replay` 档位。** 原文缺失时 `protocol ?? text`
      // 会退回展示文本,那一条其实没回传;照档位打标签会让指纹谎称回传过。
      const assistantTag: SendViewTag =
        reasoningParts.length > 0
          ? "reasoning-replayed"
          : protocol !== null
            ? "protocol-content-replayed"
            : "raw";

      if (toolCalls.length > 0) {
        const content = [
          ...reasoningParts,
          ...(body ? [{ type: "text" as const, text: body }] : []),
          ...toolCalls.map((call) => ({
            type: "tool-call" as const,
            toolCallId: call.id,
            toolName: call.function.name,
            input: parseToolArguments(call.function.arguments),
          })),
        ];
        modelMessages.push({ role: "assistant", content } as ModelMessage);
        tag(message, assistantTag);
      } else if (reasoningParts.length > 0 && body) {
        modelMessages.push({
          role: "assistant",
          content: [...reasoningParts, { type: "text" as const, text: body }],
        } as ModelMessage);
        tag(message, assistantTag);
      } else if (body) {
        // 没有思考要回传时仍发字符串,不发单元素数组 —— 与改动前逐字节一致。
        modelMessages.push({ role: "assistant", content: body });
        tag(message, assistantTag);
      }
      continue;
    }
    if (message.role === "tool") {
      const toolCallId = agUiToolCallId(message);
      if (!toolCallId) continue;
      const omitted = omitToolResultsBefore !== undefined && msgIdx < omitToolResultsBefore;
      modelMessages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: toolNames.get(toolCallId) ?? "unknown_tool",
            // **省略时直接构造 `{type:"text"}`,不走 `parseToolOutput`。**
            // 那个函数会先对字符串试 `JSON.parse`,占位文案万一是合法 JSON
            // (`null`、`123`、带引号的串)就会静默变成 `{type:"json"}`。
            output: omitted
              ? { type: "text" as const, value: TOOL_RESULT_OMITTED }
              : parseToolOutput("content" in message ? message.content : ""),
          },
        ],
      } as ModelMessage);
      tag(message, omitted ? "tool-result-omitted" : "raw");
    }
  }

  return modelMessages;
}

function finalAnswerModelMessages(messages: Message[]): ModelMessage[] {
  const question = latestUserText(messages) ?? "用户刚才的问题";
  const evidence = evidencePromptFromToolMessages(messages);
  return [
    {
      role: "user",
      content: [
        `用户问题：${question}`,
        "下面是已经执行完成的工具证据。请只基于这些证据回答，不要再调用任何工具。",
        "如果证据不足以确认精确答案，请明确说明不确定性，并列出最相关的标题和 URL 或本地路径。",
        evidence || "没有可用的工具证据。",
      ].join("\n\n"),
    },
  ];
}

function deterministicEvidenceAnswer(messages: Message[]): string {
  const question = latestUserText(messages);
  const results = collectToolEvidenceResults(messages).filter((result) => result.ok);
  const latest = results.at(-1);
  if (!latest || latest.evidence.length === 0) {
    return [
      "我已经尝试搜索，但没有拿到可用于回答的搜索结果。",
      question ? `问题：${question}` : "",
      "请换一个更具体的关键词，或检查 Web Search 配置后再试。",
    ].filter(Boolean).join("\n");
  }

  const items = latest.evidence.slice(0, 5);
  const sourceLabel = latest.source === "web"
    ? "Web Search"
    : latest.source === "session"
      ? "Session Memory"
      : "工具搜索";
  return [
    `我已经完成搜索，但模型没有成功生成最终总结。基于当前 ${sourceLabel} 结果，我先把可用证据直接给你：`,
    "",
    latest.query ? `搜索词：${latest.query}` : "",
    latest.reason ? `搜索原因：${latest.reason}` : "",
    "",
    "当前搜索摘要不足以让我可靠确认精确答案；最相关结果如下：",
    ...items.map((item, index) => {
      const target = item.url || item.path || "";
      const snippet = item.snippet ? `\n   摘要：${item.snippet}` : "";
      return `${index + 1}. ${item.title || "未命名结果"}${target ? `\n   ${target}` : ""}${snippet}`;
    }),
  ].filter((line) => line !== "").join("\n");
}

function evidencePromptFromToolMessages(messages: Message[]): string {
  const results = collectToolEvidenceResults(messages).slice(-4);
  if (results.length === 0) return "";
  return results.map((result, resultIndex) => {
    const header = [
      `工具结果 ${resultIndex + 1}: ${result.source || "unknown"}`,
      result.ok ? "ok=true" : "ok=false",
      result.query ? `query=${result.query}` : "",
      result.message ? `message=${result.message}` : "",
    ].filter(Boolean).join(" | ");
    const evidenceLines = result.evidence.slice(0, 5).map((item, itemIndex) => {
      const target = item.url || item.path || "";
      const snippet = item.snippet ? `\n  snippet: ${item.snippet}` : "";
      return `- #${itemIndex + 1} ${item.title || "未命名结果"}${target ? `\n  url/path: ${target}` : ""}${snippet}`;
    });
    return [header, ...evidenceLines].join("\n");
  }).join("\n\n");
}

function collectToolEvidenceResults(messages: Message[]): EvidenceResultForPrompt[] {
  const latestUser = latestUserIndex(messages);
  const scoped = latestUser >= 0 ? messages.slice(latestUser + 1) : messages;
  const results: EvidenceResultForPrompt[] = [];

  for (const message of scoped) {
    if (message.role !== "tool") continue;
    const content = "content" in message ? message.content : "";
    const parsed = parseToolOutputValue(content);
    if (!isRecord(parsed)) continue;
    const evidence = Array.isArray(parsed.evidence)
      ? parsed.evidence.filter(isRecord).map((item) => ({
          title: stringField(item.title),
          url: stringField(item.url),
          path: stringField(item.path),
          snippet: stringField(item.snippet),
        }))
      : [];
    results.push({
      ok: parsed.ok === true,
      source: stringField(parsed.source),
      query: stringField(parsed.query),
      reason: stringField(parsed.reason),
      message: stringField(parsed.message),
      evidence,
    });
  }

  return results;
}

function latestUserText(messages: Message[]): string | null {
  const index = latestUserIndex(messages);
  if (index < 0) return null;
  const text = textFromAgUiMessage(messages[index]).trim();
  return text || null;
}

function latestUserIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") return index;
  }
  return -1;
}

type EvidenceResultForPrompt = {
  ok: boolean;
  source: string;
  query: string;
  reason: string;
  message: string;
  evidence: Array<{
    title: string;
    url: string;
    path: string;
    snippet: string;
  }>;
};

function ai2NaoSystemPrompt(forwardedProps: unknown, compactionBlock?: string | null): string {
  const props = parseForwardedToolProps(forwardedProps);
  const parts = [
    "You are ai2nao's local-first AI workbench assistant.",
    "Reply in Simplified Chinese unless the user explicitly asks for another language.",
    "Use server-side tools when evidence is needed; do not claim you searched unless a tool result is present.",
    "After evidence tool calls, synthesize the evidence into a direct answer and cite the evidence paths or URLs when available.",
    "For web search evidence, include the most relevant result titles and URLs in the final answer. Do not merely say that you searched.",
    "For session memory evidence, cite the most relevant session titles and local paths when available, but do not expose whole transcripts.",
    "If web snippets are insufficient for an exact answer, state the uncertainty and still summarize the closest results with URLs.",
    "Do not stop after a tool result. Always continue with a concise final answer for the user.",
  ];
  if (props.useRag) {
    parts.push(
      "When the user asks to find, cite, inspect, or use local indexed materials, call ai2nao_search_rag_evidence before answering."
    );
  }
  if (props.webSearchEnabled) {
    parts.push(
      "When the user asks for current, external, or internet-only information, call ai2nao_web_search before answering."
    );
    parts.push(
      "Keep web search queries short and public-safe; never include private paths, emails, API keys, or tokens in web search queries."
    );
  }
  if (props.sessionMemoryEnabled) {
    parts.push(
      "When the user asks about previous ai2nao, Codex, Claude Code, Cursor, or Cherry Studio conversations or decisions, call ai2nao_search_session_memory before answering."
    );
    parts.push(
      "Session memory is local-only and read-only. Use narrow queries, summarize snippets, and avoid quoting or reconstructing whole conversations."
    );
  }
  if (props.codeExecutionEnabled) {
    parts.push(
      "When the user needs deterministic calculation, small data transformation, or Python verification, call ai2nao_run_code before answering."
    );
    parts.push(
      `ai2nao_run_code is Python-only. The enabled runtime for this turn is ${props.codeExecutionRuntime}. Do not use it for shell commands, package installation, network access, host filesystem access, or long-running services.`
    );
  }
  if (props.shellExecutionEnabled) {
    parts.push(
      "When the user asks to inspect the local project, run tests, run type checks, or verify a change with terminal output, call ai2nao_run_shell before answering."
    );
    parts.push(
      "ai2nao_run_shell is a controlled Bash tool, not a general terminal. Use concise commands only. Do not request package installation, network commands, destructive filesystem operations, sudo, nested shells, heredocs, file redirection, command substitution, or long-running services. If a command is denied, explain the denial and suggest a safer command."
    );
  }
  if (!props.useRag && !props.webSearchEnabled && !props.sessionMemoryEnabled && !props.codeExecutionEnabled && !props.shellExecutionEnabled) {
    parts.push("No evidence tools are enabled for this turn; answer from conversation context and say when evidence is unavailable.");
  }

  // 摘要放在最后:工具规则在前、压缩上下文在后,与「先规则后事实」的顺序一致。
  if (compactionBlock) parts.push(compactionBlock);
  return parts.join("\n\n");
}

function finalAnswerSystemPrompt(basePrompt: string): string {
  return [
    basePrompt,
    "## Final Answer Enforcement",
    "The previous step ended after tool results without a user-facing answer.",
    "Do not call tools again. Use the tool evidence already present in the conversation.",
    "Answer the user's latest question directly in Simplified Chinese.",
    "When evidence is present, include concrete result titles and URLs or local paths. If the evidence does not fully answer the question, say so clearly.",
  ].join("\n\n");
}

function validateAi2NaoCopilotInput(
  messages: Message[],
  tools: unknown[],
  context: Context[],
  state: unknown
): void {
  if (tools.length > 0) {
    throw new Error("Client-provided CopilotKit tools are not supported for ai2nao.");
  }
  if (context.length > 0) {
    throw new Error("CopilotKit page context is not supported for ai2nao.");
  }
  if (hasCopilotKitState(state)) {
    throw new Error("CopilotKit shared state is not supported for ai2nao.");
  }
  for (const [index, message] of messages.entries()) {
    if (!["developer", "system", "user", "assistant", "tool", "activity", "reasoning"].includes(message.role)) {
      throw new Error(`Unsupported message role at index ${index}: ${message.role}`);
    }
  }
}

function parseAgentInput(raw: unknown): AgentInput {
  const rec = objectOrEmpty(raw);
  return {
    threadId: typeof rec.threadId === "string" && rec.threadId.trim() ? rec.threadId.trim() : "default",
    runId: typeof rec.runId === "string" ? rec.runId : undefined,
    messages: Array.isArray(rec.messages) ? (rec.messages as Message[]) : [],
    tools: Array.isArray(rec.tools) ? rec.tools : [],
    context: Array.isArray(rec.context) ? (rec.context as Context[]) : [],
    state: rec.state,
    forwardedProps: rec.forwardedProps,
  };
}

function hasCopilotKitState(state: unknown): boolean {
  if (state === undefined || state === null) return false;
  if (Array.isArray(state)) return state.length > 0;
  if (typeof state === "object") return Object.keys(state).length > 0;
  return true;
}

/**
 * 净化客户端传来的消息:丢掉 `activity` / `reasoning` 两类角色,剥掉所有 `ai2nao*` 字段。
 *
 * **为什么是「丢弃」而不是「报错」:** `threadSnapshot` 会把思考行发给 CopilotKit
 * (id 是 `r:…`,不带 `ai2nao:` 前缀,不在过滤之列),客户端持有之后,下一轮
 * `prepareRunAgentInput` 又会原样发回来 —— 这是正常往返,不是攻击。报错的话正常使用当场就挂。
 *
 * **为什么必须做:** 服务端专有的行只能由服务端生成。今天不做也暂时无害,因为
 * `agUiMessagesToModelMessages` 还在静默丢弃 `reasoning`;但**思考回传一旦落地,
 * 客户端就能用一个新 id 伪造一条思考,被原样发给厂商**。所以这一步必须先于回传。
 *
 * **为什么不塞进 `mergeAgUiMessages`:** 它有四个调用点,其中两处的第二个参数是
 * `generated.messages()` —— 那是服务端自己生成的消息,里面正有思考行。
 * 在里面无差别净化,等于把自己刚生成的东西删掉。
 *
 * 字段用**前缀匹配**而不是枚举:`ai2naoProtocol` / `ai2naoReasoning` / `ai2naoRun`
 * 之外将来还会加,枚举迟早漏一个,而漏掉的那个正好就是被伪造的那个。
 */
export function sanitizeClientMessages(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === "activity" || message.role === "reasoning") continue;
    let copy: Record<string, unknown> | null = null;
    for (const key of Object.keys(message)) {
      if (!key.startsWith("ai2nao")) continue;
      // 只在真有 `ai2nao*` 字段时才复制 —— 绝大多数消息没有,不必每条都拷一份。
      copy ??= { ...(message as unknown as Record<string, unknown>) };
      delete copy[key];
    }
    out.push((copy ?? message) as Message);
  }
  return out;
}

/**
 * 客户端**只能新增 `user` 消息**(规格《2》可信边界):
 *
 * - **库里已有的 id 一律以服务端副本为准**,客户端那份丢掉。合并时服务端副本本来就排在前面,
 *   发给模型的不受影响;要堵的是**落库**那一步 —— `persistWithRetry` 是 upsert,不丢的话
 *   客户端改过的旧消息会原地覆盖库里那行,下一轮它就成了「服务端副本」。
 * - **新 id 只收 `user`。** assistant / tool / system / developer 只能由服务端生成;
 *   否则客户端能用一个新 id 塞进一句「助手说过的话」或一条假的工具结果,原样进库、发给厂商。
 *
 * 丢弃而不报错,理由同 `sanitizeClientMessages`:客户端每轮都会回传它持有的全部消息,
 * 其中绝大多数本来就在库里 —— 这是正常往返。
 *
 * **不改 `input.messages` 本身**:重复提交判定(`newUserMessageId`)还读着它。
 */
export function newClientUserMessages(
  messages: Message[],
  persistedIds: ReadonlySet<string>
): Message[] {
  return messages.filter((m) => m.role === "user" && !persistedIds.has(String(m.id)));
}

function mergeAgUiMessages(persistedMessages: Message[], inputMessages: Message[]): Message[] {
  const merged: Message[] = [];
  const seen = new Set<string>();
  for (const message of [...persistedMessages, ...inputMessages]) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  return merged;
}

function ensureToolState(
  toolCalls: Map<string, ToolCallState>,
  toolCallId: string,
  toolName = "unknown_tool"
): ToolCallState {
  let state = toolCalls.get(toolCallId);
  if (!state) {
    state = {
      id: toolCallId,
      name: toolName,
      args: "",
      started: false,
      hasArgsDelta: false,
      ended: false,
    };
    toolCalls.set(toolCallId, state);
  }
  return state;
}

function* closeActiveToolCalls(toolCalls: Map<string, ToolCallState>): Generator<BaseEvent> {
  for (const state of toolCalls.values()) {
    if (state.ended) continue;
    state.ended = true;
    yield { type: EventType.TOOL_CALL_END, toolCallId: state.id } as BaseEvent;
  }
}

function toolCallStartEvent(toolCallId: string, toolCallName: string, parentMessageId?: string): BaseEvent {
  return {
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName,
    ...(parentMessageId ? { parentMessageId } : {}),
  } as BaseEvent;
}

function agUiToolCalls(message: Message): AgUiToolCall[] {
  if (!("toolCalls" in message) || !Array.isArray(message.toolCalls)) return [];
  return message.toolCalls.filter((call): call is AgUiToolCall => {
    const fn = call && typeof call === "object" ? (call as { function?: unknown }).function : null;
    return (
      Boolean(call) &&
      typeof call === "object" &&
      typeof (call as { id?: unknown }).id === "string" &&
      Boolean(fn) &&
      typeof fn === "object" &&
      typeof (fn as { name?: unknown }).name === "string"
    );
  });
}

function agUiToolCallId(message: Message): string | null {
  if (!("toolCallId" in message)) return null;
  return typeof message.toolCallId === "string" && message.toolCallId.trim()
    ? message.toolCallId
    : null;
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function parseToolOutput(value: unknown): ToolResultOutputForPrompt {
  const parsed = parseToolOutputValue(value);
  return typeof parsed === "string"
    ? { type: "text", value: parsed }
    : { type: "json", value: toJsonValue(parsed) };
}

function parseToolOutputValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : (JSON.parse(encoded) as JsonValue);
  } catch {
    return String(value);
  }
}

/**
 * 导出是为了单测能直接打 `messagesForAbort()`,不必跑完整回合 ——
 * 与本文件里 `assertCanSendImages` 的导出理由相同。
 *
 * 中止那条路径从外部很难确定性地触发:要把 AbortSignal 穿过 HTTP 路由,
 * 还要在流跑到「有调用、无结果」的那一刻精确打断,写出来是个竞态测试,
 * 比没有测试更糟。
 */
export class GeneratedMessages {
  private textMessages = new Map<string, Message & { content: string }>();
  /**
   * 思考消息。**与正文分开一张表** —— 两者 id 不同(`r:` / `a:`),
   * 而且 `TOOL_CALL_START` 那一支会拿 `textMessages` 去找「同 id 的正文消息」
   * 并把工具调用挂上去;思考消息混进那张表会被误当成正文的挂载点。
   */
  private reasoningMessages = new Map<string, Message & { content: string }>();
  private toolCallMessages = new Map<string, Message & { toolCalls: AgUiToolCall[] }>();
  private ordered: Message[] = [];

  apply(event: BaseEvent) {
    if (event.type === EventType.TEXT_MESSAGE_START) {
      const messageId = String(event.messageId);
      const message = { id: messageId, role: "assistant", content: "" } as Message & { content: string };
      this.textMessages.set(messageId, message);
      this.ordered.push(message);
    } else if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
      const message = this.textMessages.get(String(event.messageId));
      if (message) message.content += event.delta;
    } else if (event.type === EventType.TEXT_MESSAGE_CHUNK) {
      const messageId = String(event.messageId);
      let message = this.textMessages.get(messageId);
      if (!message) {
        message = { id: messageId, role: "assistant", content: "" } as Message & { content: string };
        this.textMessages.set(messageId, message);
        this.ordered.push(message);
      }
      message.content += event.delta ?? "";
    } else if (event.type === EventType.REASONING_MESSAGE_CHUNK) {
      // `role: "reasoning"` 确实在 AG-UI 的 Message 联合里(判别联合的 7 个成员
      // 之一),所以不需要为基础字段做断言;落库那一侧 `AG_UI_ROLES` 也放行,
      // 预览给 `[reasoning]`,标题与 message_count 又天然只看 user/assistant。
      const messageId = String((event as { messageId?: unknown }).messageId ?? "");
      if (!messageId) return;
      let message = this.reasoningMessages.get(messageId);
      if (!message) {
        message = { id: messageId, role: "reasoning", content: "" } as Message & {
          content: string;
        };
        this.reasoningMessages.set(messageId, message);
        this.ordered.push(message);
      }
      message.content += String((event as { delta?: unknown }).delta ?? "");
    } else if (event.type === EventType.TOOL_CALL_START) {
      const parentId = "parentMessageId" in event && typeof event.parentMessageId === "string" ? event.parentMessageId : "";
      const toolCallId = String(event.toolCallId);
      const toolCallName = String(event.toolCallName);
      const messageId = parentId || toolCallId;
      let message = this.toolCallMessages.get(messageId);
      if (!message) {
        const textMessage = this.textMessages.get(messageId) as (Message & { content: string; toolCalls?: AgUiToolCall[] }) | undefined;
        if (textMessage) {
          textMessage.toolCalls ??= [];
          message = textMessage as Message & { toolCalls: AgUiToolCall[] };
        } else {
          message = { id: messageId, role: "assistant", toolCalls: [] } as Message & { toolCalls: AgUiToolCall[] };
          this.ordered.push(message);
        }
        this.toolCallMessages.set(messageId, message);
      }
      message.toolCalls.push({
        id: toolCallId,
        type: "function",
        function: { name: toolCallName, arguments: "" },
      });
    } else if (event.type === EventType.TOOL_CALL_ARGS) {
      const toolCall = this.findToolCall(String(event.toolCallId));
      if (toolCall) toolCall.function.arguments += event.delta;
    } else if (event.type === EventType.TOOL_CALL_RESULT) {
      this.ordered.push({
        id: event.messageId,
        role: "tool",
        toolCallId: event.toolCallId,
        content: event.content,
      } as Message);
    }
  }

  /**
   * 把本步的协议原文盖到对应的 assistant 消息上。
   *
   * 盖在这个类里而不是轮循环里:消息对象归它组装,外面事后按 id 去翻一遍
   * 再补盖,等于把同一份所有权切成两半。
   *
   * 只有正文消息才有原文可盖;纯工具调用的步骤没有 text-end,也就不会来这一趟。
   */
  setProtocol(messageId: string, raw: string): void {
    const message = this.textMessages.get(messageId);
    if (!message) return;
    (message as Message & { ai2naoProtocol?: unknown }).ai2naoProtocol = {
      v: 1,
      content: raw,
    };
  }

  /**
   * 把完整的 `ai2naoReasoning` 盖到思考行上。
   *
   * 与 `setProtocol` 同一种写法:逐字段赋值而不是对象字面量重建 —— `Message` 是
   * 判别联合,`reasoning` 那一支是 "strip" 模式、容不下额外字段,重建会撞 TS2352。
   */
  setReasoningMeta(messageId: string, meta: Record<string, unknown>): void {
    const message = this.reasoningMessages.get(messageId);
    if (!message) return;
    (message as Message & { ai2naoReasoning?: unknown }).ai2naoReasoning = meta;
  }

  messages(): Message[] {
    return this.ordered.filter(
      (message) =>
        message.role !== "assistant" ||
        textFromAgUiMessage(message).trim() ||
        ("toolCalls" in message && Boolean(message.toolCalls?.length))
    );
  }

  /**
   * 中止时该落库的消息:剔掉**没有结果**的工具调用。
   *
   * 历史里一旦出现「有调用、没有结果」的一对,下一轮发给厂商会直接报错 ——
   * 所以取消在工具执行途中时,那条半截调用不能落库。
   *
   * **只摘 `toolCalls` 里的那几项,不整条丢。** 工具调用可能挂在一条已经有正文的
   * assistant 消息上(见 `apply` 里 TOOL_CALL_START 复用 textMessage 的分支),
   * 整条丢会把用户已经看到的正文一起丢掉。
   */
  messagesForAbort(): Message[] {
    const settled = new Set<string>();
    for (const message of this.ordered) {
      if (message.role !== "tool") continue;
      const id = (message as { toolCallId?: unknown }).toolCallId;
      if (typeof id === "string") settled.add(id);
    }

    return this.ordered
      .map((message) => {
        if (message.role !== "assistant") return message;
        const calls = (message as { toolCalls?: AgUiToolCall[] }).toolCalls;
        if (!calls?.length) return message;
        const kept = calls.filter((call) => settled.has(call.id));
        if (kept.length === calls.length) return message;
        const copy = { ...message } as Message & { toolCalls?: AgUiToolCall[] };
        if (kept.length > 0) copy.toolCalls = kept;
        else delete copy.toolCalls;
        return copy as Message;
      })
      .filter(GeneratedMessages.worthKeeping);
  }

  /** 空的 assistant 消息不该落库:既没有正文,也没有工具调用。 */
  private static worthKeeping(message: Message): boolean {
    return (
      message.role !== "assistant" ||
      Boolean(textFromAgUiMessage(message).trim()) ||
      ("toolCalls" in message && Boolean(message.toolCalls?.length))
    );
  }

  needsFinalAnswer(): boolean {
    let latestToolResultIndex = -1;
    let latestAssistantTextIndex = -1;
    this.ordered.forEach((message, index) => {
      if (message.role === "tool") latestToolResultIndex = index;
      if (message.role === "assistant" && textFromAgUiMessage(message).trim()) {
        latestAssistantTextIndex = index;
      }
    });
    return latestToolResultIndex >= 0 && latestAssistantTextIndex < latestToolResultIndex;
  }

  private findToolCall(toolCallId: string): AgUiToolCall | undefined {
    for (const message of this.toolCallMessages.values()) {
      const toolCall = message.toolCalls.find((call) => call.id === toolCallId);
      if (toolCall) return toolCall;
    }
    return undefined;
  }
}

type AgUiToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function copilotKitStatusForTests() {
  return llmChatStatus();
}
