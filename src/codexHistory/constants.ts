/**
 * 单个 rollout 的字节上限。
 *
 * 2026-08-18 从 15 MB 提到 64 MB:实测 351 个会话里有 24 个(6%)超过 15 MB,最大
 * 49.2 MB —— 它们的正文从来没进过库。以前发现不了是因为旧的 ingest 静默跳过且
 * 水位照推;补上水位钳制后才暴露出来(水位被钉在最早那个超限文件的 2026-05-04)。
 * 对照:同一个仓库里 claude 的 MAX_JSONL_BYTES 是 200 MB,15 MB 是个没被审视过的默认值。
 * 峰值内存是单文件大小,与 claude 现在实际读的 70.6 MB 同量级。
 */
export const MAX_CODEX_JSONL_BYTES = 64 * 1024 * 1024;
export const MAX_CODEX_JSONL_LINES = 80_000;
export const MAX_CODEX_FALLBACK_FILES = 1000;
export const CODEX_PREVIEW_BYTES = 96 * 1024;
export const CODEX_ROOT_ENV = "CODEX_HOME";
