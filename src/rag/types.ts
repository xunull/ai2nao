export type RagConfigV1 = {
  version: 1;
  /** Absolute paths; directory trees are scanned for matching files. */
  corpusRoots: string[];
  includeExtensions: string[];
  maxFileBytes: number;
  /**
   * When true, skip directory segments matching DEFAULT_EXCLUDE_DIR_NAMES
   * and `.git` (name-based only).
   */
  respectDefaultExcludes: boolean;
  /** OpenAI 兼容的 `POST /v1/embeddings`；`apiKey` 可省略，此时用 `llm-chat` / 环境变量回退。 */
  embedding?: {
    enabled: boolean;
    baseURL: string;
    model: string;
    /** Bearer，例如 OpenAI；本机 LM 常可省略。 */
    apiKey?: string;
    /**
     * 单次 `POST /v1/embeddings` 最多多少条 `input`（部分云厂商上限为 10）。
     * 未设置时默认 10；OpenAI 等可设为 64–128 以减少请求次数。
     */
    maxBatchSize?: number;
  };
};
