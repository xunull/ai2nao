import { readFileSync, statSync } from "node:fs";

/**
 * 从一个 `wire.jsonl` 里抽 `usage.record` 事件。
 *
 * kimi 的事件长这样(实测 5269 条,全部同形):
 *
 *   {"type":"usage.record","model":"kimi-code/k3","usageScope":"turn",
 *    "time":1786169845493,
 *    "usage":{"inputOther":9626,"output":176,"inputCacheRead":13824,"inputCacheCreation":0}}
 *
 * 四个桶与 claude 的 input / output / cache_read / cache_creation 一一对应,
 * 而且 **`inputOther` 就是「不含缓存的输入」** —— 也就是本仓库归一后的
 * `fresh_input`,零转换。
 *
 * ⚠️ 不要把它映射成融合后的 `input_tokens`:趋势页算「真实新增」是
 * `input - cacheRead - cacheCreation`,照字面映射会得到
 * `29.9M - 1448.7M = -1418M`,图表静默变负。存原子分量就没有这个自由度。
 */

/** 单个 `usage.record` 的原子分量。`ordinal` 是它在文件内的出现序号(0 起)。 */
export type KimiUsageEvent = {
  ordinal: number;
  /** 事件时间(ms)。**只作数据,不作键** —— 见 migrations 里 V55 的说明。 */
  timeMs: number;
  freshInput: number;
  cacheReadInput: number;
  cacheCreationInput: number;
  output: number;
};

export type KimiUsageParse = {
  events: KimiUsageEvent[];
  /** 见到的 model(取最后一个非空值)。实测全库只有 `kimi-code/k3`。 */
  model: string | null;
  /** `usageScope` 的取值集合。实测只有 `turn`;出现别的值要当心重复计数。 */
  scopes: string[];
  /** 解析不了的行数(坏 JSON)。不致命,但要露出来。 */
  badLines: number;
};

/** 单个 wire.jsonl 的大小上限。超过就当解析失败,不硬啃。 */
export const MAX_KIMI_WIRE_BYTES = 64 * 1024 * 1024;

export class KimiWireTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`wire.jsonl 超过 ${MAX_KIMI_WIRE_BYTES} 字节上限(实际 ${bytes})`);
    this.name = "KimiWireTooLargeError";
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * 解析一个 wire.jsonl。
 *
 * 抛异常的情况:文件读不了(权限/不存在)、超过大小上限。
 * 调用方把异常转成该 agent 的 `token_status='error'`,**不影响同会话的其他 agent**
 * —— 那正是 X2 的要求。
 */
export function parseKimiUsage(filePath: string): KimiUsageParse {
  const size = statSync(filePath).size;
  if (size > MAX_KIMI_WIRE_BYTES) throw new KimiWireTooLargeError(size);

  const raw = readFileSync(filePath, "utf-8");
  const events: KimiUsageEvent[] = [];
  const scopes = new Set<string>();
  let model: string | null = null;
  let badLines = 0;
  let ordinal = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      badLines++;
      continue;
    }
    if (o.type !== "usage.record") continue;
    const u = (o.usage ?? {}) as Record<string, unknown>;
    if (typeof o.model === "string" && o.model.trim()) model = o.model;
    if (typeof o.usageScope === "string" && o.usageScope.trim()) scopes.add(o.usageScope);
    events.push({
      ordinal: ordinal++,
      timeMs: num(o.time),
      // inputOther 就是 fresh —— 零转换,见文件头的说明
      freshInput: num(u.inputOther),
      cacheReadInput: num(u.inputCacheRead),
      cacheCreationInput: num(u.inputCacheCreation),
      output: num(u.output),
    });
  }

  return { events, model, scopes: [...scopes].sort(), badLines };
}
