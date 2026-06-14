/**
 * Cosmos refresh 的进度跟踪器（per-process 单例）。
 *
 * 首次 refresh 会跑 ~30-60s（embed 全部 session），用户从 UI 点"刷新"后必
 * 须看到具体进度（D5 决策），不然只看一个转圈就会以为卡死再点一次（虽然
 * scheduler lease 拦下来了，但 UX 烂）。
 *
 * 设计是 in-memory + non-persistent。重启 server 后 phase 回到 idle、所有
 * 历史都从 work_cosmos_state 表读取。原因：
 *   - 进度只在一次 refresh 过程中有意义
 *   - 没必要落 DB（Phase 2 用 scheduler 自动跑时，scheduled_task_runs 已经
 *     记录了 history）
 *   - 重启 server 是开发场景下唯一会发生的事，那时也不会有人在等进度
 */
import type { CosmosRefreshStatus } from "./types.js";

const INITIAL: CosmosRefreshStatus = {
  phase: "idle",
  indexedCount: 0,
  totalCount: 0,
  embeddedCount: 0,
  startedAt: null,
  finishedAt: null,
  lastError: null,
};

let current: CosmosRefreshStatus = { ...INITIAL };

export function getCosmosProgress(): CosmosRefreshStatus {
  return { ...current };
}

export function resetCosmosProgress(): void {
  current = { ...INITIAL };
}

export function startCosmosProgress(totalCount: number): void {
  current = {
    ...INITIAL,
    phase: "scanning",
    totalCount,
    startedAt: new Date().toISOString(),
  };
}

export function updateCosmosProgress(
  patch: Partial<CosmosRefreshStatus>
): void {
  current = { ...current, ...patch };
}

export function finishCosmosProgress(args: {
  ok: boolean;
  lastError?: string | null;
}): void {
  current = {
    ...current,
    phase: args.ok ? "done" : "failed",
    finishedAt: new Date().toISOString(),
    lastError: args.lastError ?? null,
  };
}
