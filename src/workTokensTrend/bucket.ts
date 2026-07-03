/**
 * 窗口/分桶原语已抽到中立模块 `src/timeWindow/`(2026-07-03)。本文件保留为 re-export
 * 门面,让 workTokensTrend 内部与既有 import(含 test)无需改动;新消费者
 * (gitChurn、agentUserMessages)直接 import `src/timeWindow/`。
 */
export {
  bucketExpr,
  anchorBucketStart,
  iterateBuckets,
  monthToRange,
  assertMonthInDepth,
  windowToRange,
  previousWindowRange,
  granularityFor,
  __bucketExpr,
  __fmtLocal,
} from "../timeWindow/bucket.js";
export type { IteratedBucket } from "../timeWindow/bucket.js";
