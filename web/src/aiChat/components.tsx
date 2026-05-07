import {
  ActionBarPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import {
  MarkdownTextPrimitive,
  type MarkdownTextPrimitiveProps,
} from "@assistant-ui/react-markdown";
import type { AiChatSessionSummary, LlmChatStatus, RagStatus } from "./types";
import type { AiChatThreadStatus } from "./useAiChatThreads";
import { messagePreview } from "./messageCodec";

export const samplePrompts = [
  "总结我今天在这个项目里推进了什么。",
  "从本地 RAG 里找 ai2nao 最近的设计决策。",
  "帮我把这段错误日志拆成排查步骤。",
  "根据最近的浏览和仓库记录，给我一个继续工作的建议。",
];

export function formatHost(host: string | null) {
  if (!host) return "未设置";
  return host.replace(/^https?:\/\//, "");
}

export function formatPath(path: string) {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

export function StatusChips({
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
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
      <span className={chipClass(cfg?.configured && !cfgErr ? "good" : cfgErr ? "bad" : "warn")}>
        {cfgErr ? "模型状态失败" : cfg?.configured ? cfg.model ?? "已连接模型" : cfg ? "未配置 LLM" : "读取模型"}
      </span>
      <span className={chipClass(useRag ? "info" : "muted")}>
        RAG {useRag ? "on" : "off"} · {rag ? `${rag.chunkCount} chunks` : "unknown"}
      </span>
      <span className={chipClass(ragErr ? "warn" : "muted")}>
        本机转发 · {formatHost(cfg?.baseHost ?? null)}
      </span>
    </div>
  );
}

export function SessionRail({
  sessions,
  activeSessionId,
  loading,
  error,
  cfg,
  rag,
  useRag,
  onNew,
  onSelect,
  onDelete,
}: {
  sessions: AiChatSessionSummary[];
  activeSessionId: string | null;
  loading: boolean;
  error: string | null;
  cfg: LlmChatStatus | null;
  rag: RagStatus | null;
  useRag: boolean;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const visibleRoots = rag?.corpusRoots.slice(0, 3) ?? [];

  return (
    <aside className="flex h-[clamp(640px,calc(100vh-15.5rem),900px)] min-h-0 flex-col overflow-hidden rounded-lg border border-neutral-200/80 bg-white/85 shadow-sm shadow-neutral-200/60">
      <div className="border-b border-neutral-200/80 p-3">
        <button
          type="button"
          onClick={onNew}
          className="flex min-h-10 w-full items-center justify-center rounded-lg border border-neutral-200 bg-neutral-950 px-3 text-sm font-medium text-white transition hover:bg-neutral-800"
        >
          新对话
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mb-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-400">
              历史
            </h2>
            {loading ? <span className="text-xs text-neutral-400">读取中</span> : null}
          </div>
          {error ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
              历史读取失败：{error}
            </p>
          ) : null}
          <div className="space-y-1">
            {sessions.length === 0 && !loading ? (
              <p className="rounded-lg border border-dashed border-neutral-200 px-3 py-4 text-sm leading-6 text-neutral-500">
                第一条消息后，会话会保存在这里。
              </p>
            ) : null}
            {sessions.map((session) => (
              <div
                key={session.id}
                className={[
                  "group grid grid-cols-[minmax(0,1fr)_28px] items-center gap-1 rounded-lg px-2 py-2",
                  session.id === activeSessionId ? "bg-blue-50 ring-1 ring-blue-100" : "hover:bg-neutral-50",
                ].join(" ")}
              >
                <button
                  type="button"
                  onClick={() => onSelect(session.id)}
                  className="min-w-0 text-left"
                >
                  <span className="block truncate text-sm font-medium text-neutral-900">
                    {session.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-neutral-400">
                    {session.message_count} 条消息
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`删除 ${session.title}`}
                  onClick={() => onDelete(session.id)}
                  className="size-7 rounded text-neutral-400 opacity-0 transition hover:bg-white hover:text-red-600 group-hover:opacity-100 focus:opacity-100"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>

        <section className="space-y-3 border-t border-neutral-200/80 pt-4">
          <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-400">
            上下文包
          </h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-500">模型</dt>
              <dd className="max-w-40 truncate font-mono text-xs text-neutral-800">
                {cfg?.model ?? "unknown"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-500">RAG</dt>
              <dd className={useRag ? "font-medium text-blue-700" : "text-neutral-500"}>
                {useRag ? "开启" : "关闭"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-500">Chunks</dt>
              <dd className="font-mono text-xs text-neutral-900">
                {rag ? rag.chunkCount.toLocaleString() : "unknown"}
              </dd>
            </div>
          </dl>
          <div className="space-y-1.5">
            {visibleRoots.map((root) => (
              <p
                key={root}
                title={root}
                className="truncate rounded-md bg-neutral-50 px-2 py-1.5 font-mono text-[11px] text-neutral-600"
              >
                {formatPath(root)}
              </p>
            ))}
          </div>
        </section>
      </div>

      <div className="border-t border-neutral-200/80 bg-neutral-50/80 px-3 py-3 text-xs leading-5 text-neutral-500">
        请求经本机 serve 转发；密钥不进入前端构建产物。
      </div>
    </aside>
  );
}

export function AiChatEmptyState({
  disabled,
  cfg,
  onPrompt,
}: {
  disabled: boolean;
  cfg: LlmChatStatus | null;
  onPrompt: (prompt: string) => void;
}) {
  return (
    <div className="mx-auto flex min-h-[430px] w-full max-w-3xl flex-col justify-center px-8 py-14">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-600">
        Local AI Studio
      </p>
      <h2 className="mt-4 text-3xl font-semibold tracking-tight text-neutral-950">
        问一个和你本机资料有关的问题。
      </h2>
      <p className="mt-3 max-w-2xl text-sm leading-7 text-neutral-600">
        对话会保存在本机 SQLite；需要查项目文档或本地笔记时，打开 RAG 后再提问。
      </p>
      {disabled && cfg ? (
        <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
          还没有配置 LLM。创建配置后即可开始：
          <code className="mt-1 block break-all font-mono text-xs">{cfg.configPath}</code>
        </div>
      ) : null}
      <div className="mt-8 grid grid-cols-2 gap-3">
        {samplePrompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            disabled={disabled}
            onClick={() => onPrompt(prompt)}
            className="min-h-20 rounded-lg border border-neutral-200 bg-white px-4 py-3 text-left text-sm leading-6 text-neutral-800 shadow-sm shadow-neutral-200/50 transition hover:border-blue-200 hover:bg-blue-50/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

export function MarkdownText(props: MarkdownTextPrimitiveProps) {
  return (
    <MarkdownTextPrimitive
      {...props}
      className="prose prose-neutral max-w-none overflow-hidden break-words text-[15px] leading-7 prose-p:my-3 prose-p:break-words prose-li:break-words prose-pre:my-4 prose-pre:max-w-full prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:bg-neutral-950 prose-pre:p-4 prose-pre:text-neutral-50 prose-code:whitespace-pre-wrap prose-code:break-words prose-code:rounded prose-code:bg-neutral-100 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em]"
    />
  );
}

export function AiChatMessage() {
  const role = useAuiState((s) => s.message.role);
  const isUser = role === "user";

  return (
    <MessagePrimitive.Root
      className={[
        "group flex w-full min-w-0",
        isUser ? "justify-end" : "justify-start",
      ].join(" ")}
    >
      <article
        className={[
          "min-w-0 overflow-hidden text-sm",
          isUser
            ? "max-w-[min(42rem,78%)] rounded-lg bg-blue-50 px-4 py-3 text-neutral-950 ring-1 ring-blue-100"
            : "w-full max-w-[52rem] px-1 py-2 text-neutral-900",
        ].join(" ")}
      >
        {!isUser ? (
          <header className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-neutral-400">
            <span>Assistant</span>
            <MessagePrimitive.If last>
              <span className="rounded bg-neutral-100 px-2 py-0.5 normal-case tracking-normal text-neutral-500">
                最新
              </span>
            </MessagePrimitive.If>
          </header>
        ) : null}

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

export function AiChatComposer({
  disabled,
  cfg,
  rag,
  useRag,
  onUseRagChange,
}: {
  disabled: boolean;
  cfg: LlmChatStatus | null;
  rag: RagStatus | null;
  useRag: boolean;
  onUseRagChange: (value: boolean) => void;
}) {
  const isRunning = useAuiState((s) => s.thread.isRunning);

  return (
    <ComposerPrimitive.Root className="rounded-lg border border-neutral-200 bg-white p-2 shadow-xl shadow-neutral-200/60 ring-1 ring-black/[0.02] focus-within:border-blue-300 focus-within:ring-4 focus-within:ring-blue-500/10">
      <ComposerPrimitive.Input
        className="max-h-44 min-h-16 w-full resize-none bg-transparent px-3 py-3 text-[15px] leading-7 text-neutral-950 outline-none placeholder:text-neutral-400 disabled:cursor-not-allowed disabled:opacity-60"
        placeholder={disabled ? "配置 LLM 后即可开始对话" : "问本机资料、代码痕迹、模型状态或调试问题..."}
        submitMode="enter"
        disabled={disabled}
        aria-label="消息内容"
      />
      <div className="flex items-center justify-between gap-3 px-1 pt-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-neutral-500">
          <label className="inline-flex min-h-8 items-center gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-2">
            <input
              type="checkbox"
              className="size-3.5 rounded border-neutral-300"
              checked={useRag}
              disabled={disabled}
              onChange={(e) => onUseRagChange(e.target.checked)}
            />
            <span>RAG</span>
          </label>
          <span className="truncate">
            {cfg?.model ?? "unknown model"} · {rag ? `${rag.chunkCount} chunks` : "RAG unknown"}
          </span>
        </div>
        {isRunning ? (
          <ComposerPrimitive.Cancel className="min-h-9 rounded-lg border border-neutral-200 px-4 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50">
            停止
          </ComposerPrimitive.Cancel>
        ) : (
          <ComposerPrimitive.Send className="min-h-9 rounded-lg bg-neutral-950 px-4 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40">
            发送
          </ComposerPrimitive.Send>
        )}
      </div>
    </ComposerPrimitive.Root>
  );
}

export function AiChatThread({
  disabled,
  cfg,
  rag,
  ragErr,
  useRag,
  onUseRagChange,
  onPrompt,
  activeSession,
  threadStatus,
  threadError,
  lastSavedAt,
  restoredMessages,
}: {
  disabled: boolean;
  cfg: LlmChatStatus | null;
  rag: RagStatus | null;
  ragErr: string | null;
  useRag: boolean;
  onUseRagChange: (value: boolean) => void;
  onPrompt: (prompt: string) => void;
  activeSession: AiChatSessionSummary | null;
  threadStatus: AiChatThreadStatus;
  threadError: string | null;
  lastSavedAt: string | null;
  restoredMessages: unknown[];
}) {
  const ragReady = Boolean(rag && rag.chunkCount > 0);
  const runtimeMessages = useAuiState((s) => s.thread.messages);
  const showRestoredTranscript = runtimeMessages.length === 0 && restoredMessages.length > 0;

  return (
    <ThreadPrimitive.Root className="flex h-[clamp(640px,calc(100vh-15.5rem),900px)] min-h-0 flex-col overflow-hidden rounded-lg border border-neutral-200/80 bg-[linear-gradient(180deg,#ffffff_0%,#fafafa_100%)] shadow-sm shadow-neutral-200/60">
      <div className="flex min-h-14 items-center justify-between gap-4 border-b border-neutral-200/80 bg-white/80 px-5">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-neutral-950">
            {activeSession?.title ?? "新对话"}
          </p>
          <p className="text-xs text-neutral-500">
            {threadStatusLabel(threadStatus, lastSavedAt)}
          </p>
        </div>
        {threadError ? (
          <p className="max-w-md truncate rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900">
            {threadError}
          </p>
        ) : null}
      </div>
      <ThreadPrimitive.Viewport
        turnAnchor="bottom"
        autoScroll
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-smooth"
      >
        <ThreadPrimitive.Empty>
          <AiChatEmptyState disabled={disabled} cfg={cfg} onPrompt={onPrompt} />
        </ThreadPrimitive.Empty>

        <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-5 px-8 py-8">
          {showRestoredTranscript ? (
            <RestoredTranscript messages={restoredMessages} />
          ) : null}
          <ThreadPrimitive.Messages>{() => <AiChatMessage />}</ThreadPrimitive.Messages>
        </div>

        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 border-t border-neutral-200/80 bg-white/88 px-4 py-4 backdrop-blur">
          <div className="mx-auto max-w-4xl">
            <ThreadPrimitive.ScrollToBottom className="mb-2 min-h-9 rounded-lg border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-600 shadow-sm hover:bg-neutral-50">
              回到底部
            </ThreadPrimitive.ScrollToBottom>
            {ragErr ? (
              <p className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
                RAG 状态不可用：{ragErr}。普通对话仍可继续。
              </p>
            ) : null}
            {useRag && rag && !ragReady ? (
              <p className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
                已开启 RAG，但当前索引没有 chunk。先运行 <code className="font-mono">ai2nao rag ingest</code>。
              </p>
            ) : null}
            <AiChatComposer
              disabled={disabled}
              cfg={cfg}
              rag={rag}
              useRag={useRag}
              onUseRagChange={onUseRagChange}
            />
          </div>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function RestoredTranscript({ messages }: { messages: unknown[] }) {
  return (
    <>
      {messages.map((message, index) => {
        const role = (message as { role?: unknown }).role;
        const isUser = role === "user";
        const text = messagePreview(message, 4000);
        return (
          <article
            key={`${(message as { id?: string }).id ?? "restored"}-${index}`}
            className={[
              "min-w-0 overflow-hidden text-sm",
              isUser
                ? "ml-auto max-w-[min(42rem,78%)] rounded-lg bg-blue-50 px-4 py-3 text-neutral-950 ring-1 ring-blue-100"
                : "w-full max-w-[52rem] px-1 py-2 text-neutral-900",
            ].join(" ")}
          >
            {!isUser ? (
              <header className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-neutral-400">
                Assistant
              </header>
            ) : null}
            <p className="whitespace-pre-wrap break-words text-[15px] leading-7">
              {text}
            </p>
          </article>
        );
      })}
    </>
  );
}

function chipClass(kind: "good" | "bad" | "warn" | "info" | "muted") {
  const base = "inline-flex min-h-8 items-center rounded-lg border px-2.5 font-medium";
  if (kind === "good") return `${base} border-emerald-200 bg-emerald-50 text-emerald-800`;
  if (kind === "bad") return `${base} border-red-200 bg-red-50 text-red-800`;
  if (kind === "warn") return `${base} border-amber-200 bg-amber-50 text-amber-800`;
  if (kind === "info") return `${base} border-blue-200 bg-blue-50 text-blue-800`;
  return `${base} border-neutral-200 bg-white text-neutral-600`;
}

function threadStatusLabel(status: AiChatThreadStatus, lastSavedAt: string | null) {
  if (status === "loading") return "正在读取历史";
  if (status === "restoring") return "正在打开会话";
  if (status === "saving") return "正在保存";
  if (status === "saved") return lastSavedAt ? `已保存 · ${formatSavedAt(lastSavedAt)}` : "已保存";
  if (status === "save_error") return "保存失败";
  if (status === "restore_error") return "恢复失败，当前对话未切换";
  return "本机会话";
}

function formatSavedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
