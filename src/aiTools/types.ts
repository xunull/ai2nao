/**
 * AI 工具清单(ai_tools)类型。
 * 设计:~/.gstack/projects/xunull-ai2nao/20260720-design-ai-tools-inventory.md
 */

export type AiToolKind =
  | "desktop-app"
  | "cli"
  | "local-runtime"
  | "ide-extension";

/** 检测来源(v1:三种;lmstudio「在用」佐证是 v2,见设计 F5)。 */
export type AiToolDetectSource = "mac_apps" | "brew" | "path";

/**
 * 一条 curated 指纹:如何从各来源认出某个 AI 工具。扁平结构,一条可同时命中多源
 * (如 Claude 既是桌面 app 又有 CLI),扫描时每命中一源产出一条证据行。
 */
export type AiToolFingerprint = {
  toolKey: string;
  name: string;
  kind: AiToolKind;
  vendor?: string;
  /** mac_apps:bundle_id 前缀匹配(稳定)。 */
  macBundleIdPrefix?: string;
  /** mac_apps:bundle_id 精确匹配。 */
  macBundleId?: string;
  /** mac_apps:name 精确匹配(未核实 bundle_id 时用,次稳)。 */
  macNameExact?: string;
  /** brew formula 名。 */
  brewFormula?: string;
  /** brew cask 名。 */
  brewCask?: string;
  /** PATH 上的二进制名(可多个)。 */
  binaries?: string[];
};

/** 一个被检测到的工具实例 = 一条证据行。 */
export type DetectedAiTool = {
  toolKey: string;
  name: string;
  kind: AiToolKind;
  vendor: string | null;
  detectSource: AiToolDetectSource;
  /** 稳定证据键:bundle_id / formula|cask 名 / binary 名 —— **绝不含安装路径**(设计 F3)。 */
  evidence: string;
  version: string | null;
  /** 可变列,仅信息展示,不进唯一键。 */
  installPath: string | null;
};

/** ai_tools 表原始行。 */
export type AiToolRow = {
  id: number;
  tool_key: string;
  name: string;
  kind: string;
  vendor: string | null;
  detect_source: string;
  evidence: string;
  version: string | null;
  install_path: string | null;
  first_seen_at: string;
  last_seen_at: string;
  missing_since: string | null;
};

/** 视图行:按 tool_key 折叠后(设计 F2),多条证据合成一个工具。 */
export type AiToolView = {
  toolKey: string;
  name: string;
  kind: AiToolKind;
  vendor: string | null;
  /** 折叠后的检测来源列表,如 ["mac_apps", "brew"]。 */
  detectSources: AiToolDetectSource[];
  version: string | null;
  installPath: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  missingSince: string | null;
};
