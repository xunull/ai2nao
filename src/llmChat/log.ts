/**
 * LLM chat 专用日志：走 stderr，前缀统一为 [llm-chat]，便于 `serve` 时过滤。
 *
 * - 默认：`info` / `warn` / `error` 会输出（高信号事件与异常）。
 * - 更细：`AI2NAO_LLM_CHAT_DEBUG=1`（或 `true` / `yes`）时额外输出 `debug`。
 *
 * 启动方式：推荐 `npm run dev:api:debug`（见 package.json），避免部分环境下
 * `VAR=1 npm run …` 未把变量传到 tsx 子进程。
 */

const PREFIX = "[llm-chat]";

function debugEnabled(): boolean {
  const v = (process.env.AI2NAO_LLM_CHAT_DEBUG ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

let debugBannerShown = false;

/** 在注册路由时调用一次：开启 debug 时立刻打一行，避免用户以为进程挂死。 */
export function llmChatLogDebugBannerIfEnabled(): void {
  if (!debugEnabled() || debugBannerShown) return;
  debugBannerShown = true;
  console.error(
    PREFIX,
    "AI2NAO_LLM_CHAT_DEBUG on — extra [debug] lines for config/model; chat requests still required to see most logs"
  );
}

export const llmChatLog = {
  debug(...args: unknown[]) {
    if (debugEnabled()) console.error(PREFIX, "[debug]", ...args);
  },

  info(...args: unknown[]) {
    console.error(PREFIX, ...args);
  },

  warn(...args: unknown[]) {
    console.error(PREFIX, "[warn]", ...args);
  },

  error(...args: unknown[]) {
    console.error(PREFIX, "[error]", ...args);
  },
};
