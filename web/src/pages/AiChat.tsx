import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk";
import {
  MarkdownTextPrimitive,
  type MarkdownTextPrimitiveProps,
} from "@assistant-ui/react-markdown";
import { useEffect, useMemo, useState } from "react";
import { apiGet } from "../api";

type LlmChatStatus = {
  configured: boolean;
  provider: string | null;
  model: string | null;
  baseHost: string | null;
  configPath: string;
};

type RagStatus = {
  ok: true;
  dbPath: string;
  configPath: string;
  configPresent: boolean;
  corpusRoots: string[];
  embeddingEnabled: boolean;
  chunkCount: number;
};

const samplePrompts = [
  "总结我今天的本机工作痕迹，按项目分组。",
  "用本地 RAG 查一下最近关于 ai2nao 的设计决策。",
  "帮我解释一段错误日志，并给出下一步排查顺序。",
];

function MarkdownText(props: MarkdownTextPrimitiveProps) {
  return (
    <MarkdownTextPrimitive
      {...props}
      className="prose prose-neutral max-w-none overflow-hidden break-words text-sm leading-7 prose-p:break-words prose-li:break-words prose-pre:my-3 prose-pre:max-w-full prose-pre:overflow-x-auto prose-pre:rounded-xl prose-pre:bg-neutral-950 prose-pre:p-4 prose-pre:text-neutral-50 prose-code:whitespace-pre-wrap prose-code:break-words prose-code:rounded prose-code:bg-neutral-100 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em]"
    />
  );
}

function AiChatEmptyState() {
  const aui = useAui();

  return (
    <div className="mx-auto flex min-h-[42vh] max-w-2xl flex-col justify-center px-4 py-12">
      <p className="text-xs font-medium uppercase tracking-[0.16em] text-neutral-400">
        本机优先 AI 工作台
      </p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight text-neutral-950">
        问你的本机索引、笔记和工作痕迹。
      </h2>
      <p className="mt-2 text-sm leading-6 text-neutral-600">
        普通对话会直接发给已配置模型；开启 RAG 后，会先从本地文本索引里找证据，再把相关片段作为隐藏上下文发给模型。
      </p>
      <div className="mt-6 grid gap-2 sm:grid-cols-3">
        {samplePrompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="min-h-24 rounded-xl border border-neutral-200 bg-white px-3 py-3 text-left text-sm leading-5 text-neutral-800 shadow-sm transition hover:border-blue-200 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            onClick={() => aui.thread().append(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

function AiChatStatusBar({
  cfg,
  cfgErr,
  rag,
  ragErr,
  useRag,
  onUseRagChange,
}: {
  cfg: LlmChatStatus | null;
  cfgErr: string | null;
  rag: RagStatus | null;
  ragErr: string | null;
  useRag: boolean;
  onUseRagChange: (value: boolean) => void;
}) {
  const ragReady = Boolean(rag && rag.chunkCount > 0);

  return (
    <section className="rounded-xl border border-neutral-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-sm">
          {cfgErr ? (
            <p className="text-red-700">无法读取模型状态：{cfgErr}</p>
          ) : cfg?.configured ? (
            <p className="truncate text-neutral-700">
              <span className="font-medium text-neutral-950">已连接</span>
              {cfg.model ? (
                <>
                  {" "}
                  · <span className="font-mono text-xs">{cfg.model}</span>
                </>
              ) : null}
              {cfg.baseHost ? (
                <>
                  {" "}
                  · <span className="font-mono text-xs">{cfg.baseHost}</span>
                </>
              ) : null}
            </p>
          ) : cfg ? (
            <p className="text-amber-800">尚未配置 LLM，聊天输入已暂停。</p>
          ) : (
            <p className="text-neutral-500">正在读取模型状态...</p>
          )}
        </div>

        <label className="inline-flex min-h-11 items-center gap-2 rounded-full border border-neutral-200 bg-neutral-50 px-3 text-sm text-neutral-700">
          <input
            type="checkbox"
            className="size-4 rounded border-neutral-300"
            checked={useRag}
            disabled={!cfg?.configured}
            onChange={(e) => onUseRagChange(e.target.checked)}
          />
          <span>本地 RAG</span>
          <span className="rounded-full bg-white px-2 py-0.5 font-mono text-[11px] text-neutral-500">
            {rag ? `${rag.chunkCount} chunks` : "unknown"}
          </span>
        </label>
      </div>

      {cfg && !cfg.configured ? (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
          <p>创建 LLM 配置后再开始对话：</p>
          <code className="mt-1 block break-all font-mono">{cfg.configPath}</code>
        </div>
      ) : null}

      {cfg?.configured && ragErr ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
          RAG 状态不可用：{ragErr}。普通对话仍可继续。
        </p>
      ) : null}

      {cfg?.configured && useRag && rag && !ragReady ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
          已开启 RAG，但当前索引没有 chunk。先运行{" "}
          <code className="font-mono">ai2nao rag ingest</code>。
        </p>
      ) : null}
    </section>
  );
}

function AiChatMessage() {
  const role = useAuiState((s) => s.message.role);
  const isUser = role === "user";

  return (
    <MessagePrimitive.Root
      className={[
        "group flex w-full min-w-0 overflow-hidden",
        isUser ? "justify-end" : "justify-start",
      ].join(" ")}
    >
      <article
        className={[
          "w-fit max-w-[min(46rem,92%)] min-w-0 overflow-hidden rounded-2xl px-4 py-3 text-sm shadow-sm",
          isUser
            ? "bg-slate-100 text-neutral-950"
            : "border border-neutral-100 bg-white text-neutral-900 ring-1 ring-black/[0.03]",
        ].join(" ")}
      >
        <header className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
          <span>{isUser ? "你" : "助手"}</span>
          <MessagePrimitive.If last>
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 normal-case tracking-normal text-neutral-500">
              最新
            </span>
          </MessagePrimitive.If>
        </header>

        <div className="min-w-0 max-w-full overflow-hidden break-words">
          {isUser ? (
            <MessagePrimitive.Parts />
          ) : (
            <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
          )}
        </div>

        <MessagePrimitive.Error>
          <ErrorPrimitive.Root className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
            <ErrorPrimitive.Message />
          </ErrorPrimitive.Root>
        </MessagePrimitive.Error>

        {!isUser ? (
          <ActionBarPrimitive.Root
            hideWhenRunning
            autohide="not-last"
            className="mt-3 flex gap-2 text-xs text-neutral-500 opacity-0 transition group-hover:opacity-100"
          >
            <ActionBarPrimitive.Copy className="rounded-md border border-neutral-200 bg-white px-2 py-1 hover:bg-neutral-50">
              复制
            </ActionBarPrimitive.Copy>
            <ActionBarPrimitive.Reload className="rounded-md border border-neutral-200 bg-white px-2 py-1 hover:bg-neutral-50">
              重试
            </ActionBarPrimitive.Reload>
          </ActionBarPrimitive.Root>
        ) : null}
      </article>
    </MessagePrimitive.Root>
  );
}

function AiChatComposer({ disabled }: { disabled: boolean }) {
  const isRunning = useAuiState((s) => s.thread.isRunning);

  return (
    <ComposerPrimitive.Root className="rounded-2xl border border-neutral-200 bg-white p-2 shadow-lg shadow-neutral-200/50 focus-within:border-blue-300 focus-within:ring-2 focus-within:ring-blue-500/10">
      <ComposerPrimitive.Input
        className="max-h-40 min-h-12 w-full resize-none bg-transparent px-2 py-2 text-sm leading-6 text-neutral-950 outline-none placeholder:text-neutral-400 disabled:cursor-not-allowed disabled:opacity-60"
        placeholder={disabled ? "配置 LLM 后即可开始对话" : "输入消息，Enter 发送，Shift+Enter 换行"}
        submitMode="enter"
        disabled={disabled}
        aria-label="消息内容"
      />
      <div className="flex items-center justify-between px-1 pt-2">
        <p className="text-xs text-neutral-400">本机 serve 转发请求，密钥不会进入前端构建产物。</p>
        {isRunning ? (
          <ComposerPrimitive.Cancel className="min-h-9 rounded-full border border-neutral-200 px-4 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50">
            停止
          </ComposerPrimitive.Cancel>
        ) : (
          <ComposerPrimitive.Send className="min-h-9 rounded-full bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40">
            发送
          </ComposerPrimitive.Send>
        )}
      </div>
    </ComposerPrimitive.Root>
  );
}

function AiChatThread({ disabled }: { disabled: boolean }) {
  return (
    <ThreadPrimitive.Root className="flex min-h-[62vh] flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-50/70">
      <ThreadPrimitive.Viewport
        turnAnchor="bottom"
        autoScroll
        className="flex flex-1 flex-col overflow-x-hidden overflow-y-auto scroll-smooth"
      >
        <ThreadPrimitive.Empty>
          <AiChatEmptyState />
        </ThreadPrimitive.Empty>

        <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-1 flex-col gap-4 px-4 py-6">
          <ThreadPrimitive.Messages>
            {() => <AiChatMessage />}
          </ThreadPrimitive.Messages>
        </div>

        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mt-auto border-t border-neutral-200 bg-neutral-50/90 px-3 py-3 backdrop-blur">
          <div className="mx-auto max-w-4xl">
            <ThreadPrimitive.ScrollToBottom className="mb-2 min-h-9 rounded-full border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-600 shadow-sm hover:bg-neutral-50">
              回到底部
            </ThreadPrimitive.ScrollToBottom>
            <AiChatComposer disabled={disabled} />
          </div>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

export function AiChat() {
  const [cfg, setCfg] = useState<LlmChatStatus | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const [useRag, setUseRag] = useState(false);
  const [rag, setRag] = useState<RagStatus | null>(null);
  const [ragErr, setRagErr] = useState<string | null>(null);

  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: "/api/llm-chat",
        body: { useRag, ragTopK: 8 },
      }),
    [useRag]
  );
  const runtime = useChatRuntime({ transport });

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

  useEffect(() => {
    let cancelled = false;
    apiGet<RagStatus>("/api/rag/status")
      .then((s) => {
        if (!cancelled) {
          setRag(s);
          setRagErr(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setRag(null);
          setRagErr(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const disabled = cfg?.configured !== true;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="cursor-chat-root space-y-4">
        <header>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-950">
            AI 对话
          </h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-neutral-600">
            面向本机资料的轻量聊天工作台。普通问题直接走模型；需要查本地笔记、项目文档和索引文本时打开 RAG。
          </p>
        </header>

        <AiChatStatusBar
          cfg={cfg}
          cfgErr={cfgErr}
          rag={rag}
          ragErr={ragErr}
          useRag={useRag}
          onUseRagChange={setUseRag}
        />

        <AiChatThread disabled={disabled} />
      </div>
    </AssistantRuntimeProvider>
  );
}
