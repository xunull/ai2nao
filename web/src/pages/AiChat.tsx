import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { DefaultChatTransport } from "ai";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { apiGet } from "../api";

type LlmChatStatus = {
  configured: boolean;
  provider: string | null;
  model: string | null;
  baseHost: string | null;
  configPath: string;
};

function textFromMessage(m: UIMessage): string {
  return m.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

export function AiChat() {
  const [cfg, setCfg] = useState<LlmChatStatus | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const [input, setInput] = useState("");

  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/llm-chat" }),
    []
  );

  const { messages, sendMessage, status, error, stop } = useChat({ transport });

  useEffect(() => {
    let cancelled = false;
    apiGet<LlmChatStatus>("/api/llm-chat/status")
      .then((s) => {
        if (!cancelled) {
          setCfg(s);
          setCfgErr(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setCfg(null);
          setCfgErr(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const busy = status === "streaming" || status === "submitted";

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const t = input.trim();
    if (!t || busy) return;
    void sendMessage({ text: t });
    setInput("");
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--fg)]">AI 对话</h1>
        <p className="text-sm text-[var(--muted)] mt-1">
          通过本机 serve 转发到你在配置文件里写的 OpenAI 兼容 API（含 LM Studio、Ollama
          /v1 等）。密钥不会进前端构建产物。
        </p>
      </div>

      {cfgErr ? (
        <p className="text-sm text-red-600">无法读取状态：{cfgErr}</p>
      ) : cfg && !cfg.configured ? (
        <div className="rounded border border-amber-200 bg-amber-50 text-amber-950 text-sm p-3 space-y-1">
          <p>尚未配置 LLM：在下列路径创建 JSON（可参考仓库根目录的 llm-chat.config.example.json）。</p>
          <code className="text-xs block break-all">{cfg.configPath}</code>
          <p className="text-xs">
            也可用环境变量 <code>AI2NAO_LLM_CHAT_CONFIG</code> 指向自定义路径。
          </p>
        </div>
      ) : cfg?.configured ? (
        <p className="text-xs text-[var(--muted)]">
          已配置 · 模型 <span className="font-mono">{cfg.model}</span>
          {cfg.baseHost ? (
            <>
              {" "}
              · 主机 <span className="font-mono">{cfg.baseHost}</span>
            </>
          ) : null}
        </p>
      ) : null}

      <div className="rounded border border-[var(--border)] bg-white min-h-[240px] max-h-[55vh] overflow-y-auto p-3 space-y-3 text-sm">
        {messages.length === 0 ? (
          <p className="text-[var(--muted)]">发送第一条消息开始对话。</p>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={
                m.role === "user"
                  ? "text-[var(--fg)]"
                  : "text-[var(--fg)] border-l-2 border-[var(--accent)] pl-2"
              }
            >
              <div className="text-xs font-medium text-[var(--muted)] mb-0.5">
                {m.role === "user" ? "你" : "助手"}
              </div>
              <div className="whitespace-pre-wrap break-words">{textFromMessage(m)}</div>
            </div>
          ))
        )}
      </div>

      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error.message}
        </p>
      ) : null}

      <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <textarea
          className="flex-1 rounded border border-[var(--border)] px-2 py-2 text-sm min-h-[4.5rem] resize-y"
          placeholder="输入消息…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
          aria-label="消息内容"
        />
        <div className="flex gap-2 shrink-0">
          {busy ? (
            <button
              type="button"
              className="rounded border border-[var(--border)] px-3 py-2 text-sm"
              onClick={() => void stop()}
            >
              停止
            </button>
          ) : null}
          <button
            type="submit"
            className="rounded bg-[var(--accent)] text-white px-4 py-2 text-sm disabled:opacity-50"
            disabled={busy || !input.trim()}
          >
            发送
          </button>
        </div>
      </form>
    </div>
  );
}
