import { existsSync, readFileSync } from "node:fs";
import { defaultAi2naoConfigPath } from "../config.js";

/**
 * `~/.ai2nao/config.json` 里的 `attention` 段。
 *
 * 解析是严格模式，照 `src/atuin/directoryActivity/config.ts` 的先例：未知字段、
 * 类型不对、非法 JSON 都返回 issues 而不是静默忽略。一个被拼错的键静默失效，
 * 意味着你以为设了白名单其实在全量采集 —— 对一个采集「你在电脑前做的一切」的
 * 功能，那是最不能接受的失败方式。
 *
 * ```json
 * {
 *   "attention": {
 *     "mode": "allowlist",
 *     "allowBundles": ["com.googlecode.iterm2", "com.microsoft.VSCode"],
 *     "excludeBundles": ["com.apple.MobileSMS"],
 *     "minDurationMs": 0
 *   }
 * }
 * ```
 */
export type AttentionCaptureMode = "all" | "allowlist";

export type AttentionConfig = {
  /**
   * `all`（默认）采所有前台应用；`allowlist` 只采 `allowBundles` 里列出的。
   *
   * 默认全量而不是白名单，是一个有代价的取舍：白名单更保守，但实测这台机器上
   * 时长第一的应用是微信（20 天 1998 分钟），把它挡在外面之后「我的时间去哪了」
   * 就答不完整了 —— 而那正是这个功能存在的理由。隐私的实质保护在别处：任务默认
   * 关闭、数据不出本机、只存 bundle id 和起止时间，不存窗口标题也不存内容。
   * 想更保守就把 mode 切成 allowlist。
   */
  mode: AttentionCaptureMode;
  /** `mode: "allowlist"` 时的白名单。空数组意味着什么都不采。 */
  allowBundles: string[];
  /** 任何模式下都排除。黑名单优先于白名单。 */
  excludeBundles: string[];
  /** 短于这个时长的前台记录不入库。0 表示只丢零时长闪切。 */
  minDurationMs: number;
};

export const DEFAULT_ATTENTION_CONFIG: AttentionConfig = {
  mode: "all",
  allowBundles: [],
  excludeBundles: [],
  minDurationMs: 0,
};

export type ConfigIssue = { path: string; message: string };

const issue = (path: string, message: string): ConfigIssue => ({ path, message });

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseBundleList(
  raw: unknown,
  path: string,
  issues: ConfigIssue[]
): string[] | null {
  if (!Array.isArray(raw)) {
    issues.push(issue(path, "must be an array of bundle id strings"));
    return null;
  }
  const out: string[] = [];
  raw.forEach((item, i) => {
    if (typeof item !== "string" || item.trim() === "") {
      issues.push(issue(`${path}[${i}]`, "must be a non-empty bundle id string"));
      return;
    }
    out.push(item.trim());
  });
  return out;
}

export function parseAttentionConfig(root: unknown): {
  config: AttentionConfig | null;
  issues: ConfigIssue[];
} {
  const issues: ConfigIssue[] = [];
  if (root == null) return { config: DEFAULT_ATTENTION_CONFIG, issues };
  if (!isObject(root)) {
    return { config: null, issues: [issue("$", "config must be an object")] };
  }
  const section = root.attention;
  if (section == null) return { config: DEFAULT_ATTENTION_CONFIG, issues };
  if (!isObject(section)) {
    return { config: null, issues: [issue("$.attention", "attention must be an object")] };
  }

  const allowed = new Set(["mode", "allowBundles", "excludeBundles", "minDurationMs"]);
  for (const key of Object.keys(section)) {
    if (!allowed.has(key)) {
      issues.push(issue(`$.attention.${key}`, "unknown config key"));
    }
  }

  let mode = DEFAULT_ATTENTION_CONFIG.mode;
  if (section.mode != null) {
    if (section.mode !== "all" && section.mode !== "allowlist") {
      issues.push(issue("$.attention.mode", 'mode must be "all" or "allowlist"'));
    } else {
      mode = section.mode;
    }
  }

  let allowBundles = DEFAULT_ATTENTION_CONFIG.allowBundles;
  if (section.allowBundles != null) {
    const parsed = parseBundleList(section.allowBundles, "$.attention.allowBundles", issues);
    if (parsed) allowBundles = parsed;
  }

  let excludeBundles = DEFAULT_ATTENTION_CONFIG.excludeBundles;
  if (section.excludeBundles != null) {
    const parsed = parseBundleList(
      section.excludeBundles,
      "$.attention.excludeBundles",
      issues
    );
    if (parsed) excludeBundles = parsed;
  }

  let minDurationMs = DEFAULT_ATTENTION_CONFIG.minDurationMs;
  if (section.minDurationMs != null) {
    if (typeof section.minDurationMs !== "number" || !Number.isFinite(section.minDurationMs) || section.minDurationMs < 0) {
      issues.push(issue("$.attention.minDurationMs", "must be a non-negative number"));
    } else {
      minDurationMs = section.minDurationMs;
    }
  }

  // 严格模式：有任何 issue 就不给配置，调用方保留上一次的行为并显示 config_error。
  // 半套生效的配置比完全不生效更难排查。
  if (issues.length > 0) return { config: null, issues };
  return { config: { mode, allowBundles, excludeBundles, minDurationMs }, issues };
}

/**
 * 把配置翻译成 `toSpans` 认识的过滤器。
 *
 * `allowlist` 模式下白名单减去黑名单；`all` 模式下只要黑名单为空就不传集合
 * （不传 = 不过滤，避免为「全采」构造一个包含全部 bundle 的集合）。
 */
export function bundleFilterOf(
  config: AttentionConfig,
  seenBundles: readonly string[]
): ReadonlySet<string> | undefined {
  const deny = new Set(config.excludeBundles);
  if (config.mode === "allowlist") {
    return new Set(config.allowBundles.filter((b) => !deny.has(b)));
  }
  if (deny.size === 0) return undefined;
  return new Set(seenBundles.filter((b) => !deny.has(b)));
}

export type AttentionConfigResult =
  | { ok: true; path: string; exists: boolean; config: AttentionConfig }
  | { ok: false; path: string; issues: ConfigIssue[] };

/**
 * 从 `~/.ai2nao/config.json` 读取。文件不存在就用默认值（全量采集）；
 * 解析失败返回 ok:false，**调用方必须保持上一次的行为并把 config_error 显示出来**，
 * 而不是悄悄回落到默认 —— 悄悄回落意味着一个拼错的键会把 allowlist 变回全量。
 */
export function readAttentionConfig(
  configPath = defaultAi2naoConfigPath()
): AttentionConfigResult {
  if (!existsSync(configPath)) {
    return { ok: true, path: configPath, exists: false, config: DEFAULT_ATTENTION_CONFIG };
  }
  let root: unknown;
  try {
    root = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    return {
      ok: false,
      path: configPath,
      issues: [issue("$", e instanceof Error ? e.message : String(e))],
    };
  }
  const parsed = parseAttentionConfig(root);
  if (!parsed.config) return { ok: false, path: configPath, issues: parsed.issues };
  return { ok: true, path: configPath, exists: true, config: parsed.config };
}
