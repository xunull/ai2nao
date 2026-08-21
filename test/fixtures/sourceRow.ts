import type { SourceBucketRow } from "../../src/workTokensTrend/adapters.js";

/**
 * adapter 出的行是**原子分量**,总量/输入是派生的。这两个函数只做派生,
 * 不做形状翻译 —— 它们与 `src/workTokensTrend/types.ts` 里的
 * `inputTokens()` / `totalTokens()` 是同一套口径,只是作用在原始行上。
 *
 * (刻意**不**提供「把新行伪装成旧行」的转换:那等于把已删掉的兼容层
 *  搬进 test/,测试就又不是在断言真契约了。)
 */
export const rowInput = (r: SourceBucketRow): number =>
  r.fresh_input + r.cache_read_input + r.cache_creation_input;

export const rowTotal = (r: SourceBucketRow): number => rowInput(r) + r.output;
