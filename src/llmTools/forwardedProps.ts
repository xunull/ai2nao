export type ForwardedToolProps = {
  /**
   * 这一轮用哪个模型。**前端传来的值不可信** —— 合法性、可用性一律由后端
   * `selectModelForTurn` 判定;这里只做形状归一,不认识的一律成 null。
   * null 表示「没指定」,由后端用默认模型,而不是「随便挑一个」。
   */
  modelId: string | null;
  useRag: boolean;
  ragTopK: number;
  webSearchEnabled: boolean;
  sessionMemoryEnabled: boolean;
  sessionMemoryTopK: number;
  codeExecutionEnabled: boolean;
  codeExecutionRuntime: "pyodide" | "docker";
  codeExecutionTimeoutMs: number;
  shellExecutionEnabled: boolean;
  shellExecutionTimeoutMs: number;
  shellPermissionMode: "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";
};

export function parseForwardedToolProps(input: unknown): ForwardedToolProps {
  const props = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const rawRagTopK = parseInt(String(props.ragTopK ?? 8), 10);
  const rawSessionMemoryTopK = parseInt(String(props.sessionMemoryTopK ?? 8), 10);
  const rawCodeExecutionTimeoutMs = parseInt(String(props.codeExecutionTimeoutMs ?? 10_000), 10);
  const rawShellExecutionTimeoutMs = parseInt(String(props.shellExecutionTimeoutMs ?? 10_000), 10);
  const rawModelId = typeof props.modelId === "string" ? props.modelId.trim() : "";
  return {
    modelId: rawModelId || null,
    useRag: props.useRag === true,
    ragTopK: Math.min(20, Math.max(1, rawRagTopK || 8)),
    webSearchEnabled: props.webSearchEnabled === true,
    sessionMemoryEnabled: props.sessionMemoryEnabled === true,
    sessionMemoryTopK: Math.min(12, Math.max(1, rawSessionMemoryTopK || 8)),
    codeExecutionEnabled: props.codeExecutionEnabled === true,
    codeExecutionRuntime: props.codeExecutionRuntime === "docker" ? "docker" : "pyodide",
    codeExecutionTimeoutMs: Math.min(30_000, Math.max(1_000, rawCodeExecutionTimeoutMs || 10_000)),
    shellExecutionEnabled: props.shellExecutionEnabled === true,
    shellExecutionTimeoutMs: Math.min(30_000, Math.max(1_000, rawShellExecutionTimeoutMs || 10_000)),
    shellPermissionMode: parseShellPermissionMode(props.shellPermissionMode),
  };
}

function parseShellPermissionMode(
  value: unknown
): ForwardedToolProps["shellPermissionMode"] {
  if (
    value === "plan" ||
    value === "acceptEdits" ||
    value === "bypassPermissions" ||
    value === "dontAsk"
  ) {
    return value;
  }
  return "default";
}
