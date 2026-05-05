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

function formatHost(host: string | null) {
  if (!host) return "未设置";
  return host.replace(/^https?:\/\//, "");
}

function formatPath(path: string) {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

function MarkdownText(props: MarkdownTextPrimitiveProps) {
  return (
    <MarkdownTextPrimitive
      {...props}
      className="prose prose-neutral max-w-none overflow-hidden break-words text-sm leading-7 prose-p:break-words prose-li:break-words prose-pre:my-3 prose-pre:max-w-full prose-pre:overflow-x-auto prose-pre:rounded-xl prose-pre:bg-neutral-950 prose-pre:p-4 prose-pre:text-neutral-50 prose-code:whitespace-pre-wrap prose-code:break-words prose-code:rounded prose-code:bg-neutral-100 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em]"
    />
  );
}

function AiChatEmptyState() {
  return (
    <div className="mx-auto flex min-h-[44vh] max-w-2xl flex-col justify-center px-6 py-12">
      <p className="text-xs font-medium uppercase tracking-[0.12em] text-neutral-400">
        Ready
      </p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight text-neutral-950">
        从一个具体问题开始。
      </h2>
      <p className="mt-2 text-sm leading-6 text-neutral-600">
        右侧是对话线程，左侧固定显示模型、RAG 语料和本机信任边界。需要查本地笔记或项目文档时，先打开 RAG。
      </p>
    </div>
  );
}

function AiChatPromptQueue() {
  const aui = useAui();

  return (
    <div className="space-y-2">
      {samplePrompts.map((prompt) => (
        <button
          key={prompt}
          type="button"
          className="block min-h-16 w-full rounded-lg border border-neutral-200 bg-white px-3 py-3 text-left text-sm leading-5 text-neutral-800 transition hover:border-blue-300 hover:bg-blue-50/50 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          onClick={() => aui.thread().append(prompt)}
        >
          {prompt}
        </button>
      ))}
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
    <section className="rounded-lg border border-neutral-200 bg-white px-4 py-3">
      <div className="flex items-center justify-between gap-4">
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

        <label className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 text-sm text-neutral-700">
          <input
            type="checkbox"
            className="size-4 rounded border-neutral-300"
            checked={useRag}
            disabled={!cfg?.configured}
            onChange={(e) => onUseRagChange(e.target.checked)}
          />
          <span>本地 RAG</span>
          <span className="rounded bg-white px-2 py-0.5 font-mono text-[11px] text-neutral-500">
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

function AiChatContextPanel({
  cfg,
  cfgErr,
  rag,
  ragErr,
  useRag,
}: {
  cfg: LlmChatStatus | null;
  cfgErr: string | null;
  rag: RagStatus | null;
  ragErr: string | null;
  useRag: boolean;
}) {
  const visibleRoots = rag?.corpusRoots.slice(0, 4) ?? [];
  const hiddenRootCount = Math.max((rag?.corpusRoots.length ?? 0) - visibleRoots.length, 0);

  return (
    <aside className="flex h-[clamp(620px,calc(100vh-18rem),860px)] min-h-0 flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <div className="border-b border-neutral-200 px-4 py-3">
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-neutral-400">
          Context
        </p>
        <h2 className="mt-1 text-base font-semibold text-neutral-950">本机上下文</h2>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-neutral-500">
            模型
          </h3>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-neutral-500">状态</dt>
              <dd className={cfg?.configured ? "font-medium text-emerald-700" : "font-medium text-amber-700"}>
                {cfgErr ? "读取失败" : cfg?.configured ? "已连接" : cfg ? "未配置" : "读取中"}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-neutral-500">模型</dt>
              <dd className="max-w-48 truncate font-mono text-xs text-neutral-800">
                {cfg?.model ?? "unknown"}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-neutral-500">Host</dt>
              <dd className="max-w-48 truncate font-mono text-xs text-neutral-800">
                {formatHost(cfg?.baseHost ?? null)}
              </dd>
            </div>
          </dl>
        </section>

        <section>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-neutral-500">
              RAG 语料
            </h3>
            <span className={useRag ? "rounded bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700" : "rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-500"}>
              {useRag ? "开启" : "关闭"}
            </span>
          </div>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-neutral-500">Chunks</dt>
              <dd className="font-mono text-xs text-neutral-900">
                {rag ? rag.chunkCount.toLocaleString() : "unknown"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-neutral-500">Embedding</dt>
              <dd className={rag?.embeddingEnabled ? "font-medium text-emerald-700" : "font-medium text-neutral-500"}>
                {rag?.embeddingEnabled ? "可用" : "未启用"}
              </dd>
            </div>
          </dl>
          <div className="mt-3 space-y-2">
            {visibleRoots.length > 0 ? (
              visibleRoots.map((root) => (
                <p
                  key={root}
                  className="truncate rounded border border-neutral-200 bg-neutral-50 px-2 py-1.5 font-mono text-xs text-neutral-700"
                  title={root}
                >
                  {formatPath(root)}
                </p>
              ))
            ) : (
              <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs leading-5 text-amber-900">
                还没有可展示的语料根目录。
              </p>
            )}
            {hiddenRootCount > 0 ? (
              <p className="text-xs text-neutral-500">还有 {hiddenRootCount} 个根目录未显示。</p>
            ) : null}
          </div>
          {ragErr ? (
            <p className="mt-3 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs leading-5 text-amber-900">
              RAG 状态读取失败：{ragErr}
            </p>
          ) : null}
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-neutral-500">
            快速任务
          </h3>
          <div className="mt-3">
            <AiChatPromptQueue />
          </div>
        </section>
      </div>

      <div className="mt-auto border-t border-neutral-200 bg-neutral-50 px-4 py-3 text-xs leading-5 text-neutral-600">
        请求由本机 serve 转发；密钥不进入前端构建产物。开启 RAG 时，本地片段会作为隐藏上下文发送给模型。
      </div>
    </aside>
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
          "w-fit max-w-[min(50rem,92%)] min-w-0 overflow-hidden rounded-lg px-4 py-3 text-sm shadow-sm",
          isUser
            ? "bg-blue-50 text-neutral-950"
            : "border border-neutral-100 bg-white text-neutral-900 ring-1 ring-black/[0.03]",
        ].join(" ")}
      >
        <header className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
          <span>{isUser ? "你" : "助手"}</span>
          <MessagePrimitive.If last>
            <span className="rounded bg-neutral-100 px-2 py-0.5 normal-case tracking-normal text-neutral-500">
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
            className="mt-3 flex gap-2 text-xs text-neutral-500 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100"
          >
            <ActionBarPrimitive.Copy className="rounded border border-neutral-200 bg-white px-2 py-1 hover:bg-neutral-50">
              复制
            </ActionBarPrimitive.Copy>
            <ActionBarPrimitive.Reload className="rounded border border-neutral-200 bg-white px-2 py-1 hover:bg-neutral-50">
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
    <ComposerPrimitive.Root className="rounded-lg border border-neutral-200 bg-white p-2 shadow-lg shadow-neutral-200/50 focus-within:border-blue-300 focus-within:ring-2 focus-within:ring-blue-500/10">
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
          <ComposerPrimitive.Cancel className="min-h-9 rounded-lg border border-neutral-200 px-4 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50">
            停止
          </ComposerPrimitive.Cancel>
        ) : (
          <ComposerPrimitive.Send className="min-h-9 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40">
            发送
          </ComposerPrimitive.Send>
        )}
      </div>
    </ComposerPrimitive.Root>
  );
}

function AiChatThread({ disabled }: { disabled: boolean }) {
  return (
    <ThreadPrimitive.Root className="flex h-[clamp(620px,calc(100vh-18rem),860px)] min-h-0 flex-col overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50/70">
      <ThreadPrimitive.Viewport
        turnAnchor="bottom"
        autoScroll
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-smooth"
      >
        <ThreadPrimitive.Empty>
          <AiChatEmptyState />
        </ThreadPrimitive.Empty>

        <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-4 px-6 py-6">
          <ThreadPrimitive.Messages>
            {() => <AiChatMessage />}
          </ThreadPrimitive.Messages>
        </div>

        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 border-t border-neutral-200 bg-neutral-50/90 px-3 py-3 backdrop-blur">
          <div className="mx-auto max-w-4xl">
            <ThreadPrimitive.ScrollToBottom className="mb-2 min-h-9 rounded-lg border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-600 shadow-sm hover:bg-neutral-50">
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
        <header className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-neutral-950">
              AI 对话
            </h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-neutral-600">
              面向本机资料的 AI 工作台。左侧锁定模型和语料边界，右侧保留对话线程和输入。
            </p>
          </div>
          <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-right text-xs leading-5 text-neutral-600">
            <p className="font-medium text-neutral-950">本机转发</p>
            <p>密钥不进入前端</p>
          </div>
        </header>

        <AiChatStatusBar
          cfg={cfg}
          cfgErr={cfgErr}
          rag={rag}
          ragErr={ragErr}
          useRag={useRag}
          onUseRagChange={setUseRag}
        />

        <div className="grid grid-cols-[380px_minmax(0,1fr)] items-start gap-6">
          <AiChatContextPanel
            cfg={cfg}
            cfgErr={cfgErr}
            rag={rag}
            ragErr={ragErr}
            useRag={useRag}
          />
          <AiChatThread disabled={disabled} />
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
