/**
 * 那天回放（桥 T2）—— 纯切分函数：把按时间排的合并事件流（commit + 人类对话）
 * 按 gap 阈值切成「工作会话段」。跨仓库按时间连续切（P5）。
 *
 * **纯函数 + 只认 epoch ms（时区无关，codex#9）**：不碰 db、不做日期展示。日期归属
 * （本地日期）是 formatter 的事，另测。相邻事件间隔 > gapThresholdMs → 断新段；
 * 单段有硬上限（最多 maxEvents / 最长 maxSpanMs）防超长连续活扫爆，超限截断并标 truncated。
 * firstEventKey = 首事件 `source:id`，**确定性、活算下稳定**（当详情页定位 key）。
 */

export type ReplayEventType = "commit" | "message";

/** 一个待切分事件：只带 epoch ms + 归属，payload 透传给详情不参与切分。 */
export type ReplayEvent<P = unknown> = {
  atMs: number;
  type: ReplayEventType;
  source: string; // message: claude/codex/opencode；commit: "git"
  id: string; // 该源内唯一（commit_hash 或 message id）
  repoKey: string; // project_key（slug）
  payload?: P;
};

export type ReplaySession<P = unknown> = {
  startedAtMs: number;
  endedAtMs: number;
  /** `${source}:${id}` of first event —— 确定性、活算下稳定。 */
  firstEventKey: string;
  /** distinct repoKey，按出现顺序。 */
  repoKeys: string[];
  events: ReplayEvent<P>[];
  commitCount: number;
  messageCount: number;
  /** true = 撞了硬上限被截断（超长连续活），非自然 gap 边界。 */
  truncated: boolean;
};

export const DEFAULT_GAP_THRESHOLD_MS = 120 * 60 * 1000; // 2h
export const DEFAULT_MAX_EVENTS = 500; // 单段事件硬上限
export const DEFAULT_MAX_SPAN_MS = 24 * 60 * 60 * 1000; // 单段时长硬上限 24h

export type SessionizeOptions = {
  gapThresholdMs?: number;
  maxEvents?: number;
  maxSpanMs?: number;
};

function eventKey(e: ReplayEvent): string {
  return `${e.source}:${e.id}`;
}

function buildSession<P>(evs: ReplayEvent<P>[], truncated: boolean): ReplaySession<P> {
  const repoKeys: string[] = [];
  let commitCount = 0;
  let messageCount = 0;
  for (const e of evs) {
    if (!repoKeys.includes(e.repoKey)) repoKeys.push(e.repoKey);
    if (e.type === "commit") commitCount++;
    else messageCount++;
  }
  return {
    startedAtMs: evs[0].atMs,
    endedAtMs: evs[evs.length - 1].atMs,
    firstEventKey: eventKey(evs[0]),
    repoKeys,
    events: evs,
    commitCount,
    messageCount,
    truncated,
  };
}

/**
 * 切分。输入不必预排序：内部按 atMs 升序（平手用 source:id 破，保证确定性）。
 */
export function sessionize<P = unknown>(
  events: ReplayEvent<P>[],
  opts: SessionizeOptions = {}
): ReplaySession<P>[] {
  const gap = opts.gapThresholdMs ?? DEFAULT_GAP_THRESHOLD_MS;
  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
  const maxSpan = opts.maxSpanMs ?? DEFAULT_MAX_SPAN_MS;

  const sorted = [...events].sort(
    (a, b) => a.atMs - b.atMs || eventKey(a).localeCompare(eventKey(b))
  );

  const out: ReplaySession<P>[] = [];
  let cur: ReplayEvent<P>[] = [];

  for (const ev of sorted) {
    if (cur.length === 0) {
      cur = [ev];
      continue;
    }
    const prev = cur[cur.length - 1];
    if (ev.atMs - prev.atMs > gap) {
      // 自然 gap 边界 → 收本段（非截断），起新段。
      out.push(buildSession(cur, false));
      cur = [ev];
    } else if (cur.length >= maxEvents || ev.atMs - cur[0].atMs > maxSpan) {
      // 撞硬上限 → 收本段并标 truncated，起新段（超长连续活防扫爆）。
      out.push(buildSession(cur, true));
      cur = [ev];
    } else {
      cur.push(ev);
    }
  }
  if (cur.length > 0) out.push(buildSession(cur, false));
  return out;
}
