import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk";
import { useEffect, useMemo, useState } from "react";
import { apiGet } from "../api";
import {
  AiChatThread,
  SessionRail,
  StatusChips,
} from "../aiChat/components";
import type { LlmChatStatus, RagStatus } from "../aiChat/types";
import { useAiChatThreads } from "../aiChat/useAiChatThreads";
import { mergeWithRestoredBase } from "../aiChat/runtimeBridge";

function AiChatStudio({
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
  const threads = useAiChatThreads();

  const disabled = cfg?.configured !== true;

  return (
    <div className="cursor-chat-root -mx-1 rounded-xl bg-[#f6f6f3] px-5 py-5">
      <header className="mb-5 flex items-start justify-between gap-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-400">
            AI Studio
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-neutral-950">
            AI 对话
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-neutral-600">
            一个面向本机资料的现代 AI 对话空间。历史保存在本机 SQLite，RAG 和模型状态保持可见但不抢主舞台。
          </p>
          {threads.error ? (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
              会话状态：{threads.error}
            </p>
          ) : null}
        </div>
        <StatusChips
          cfg={cfg}
          cfgErr={cfgErr}
          rag={rag}
          ragErr={ragErr}
          useRag={useRag}
        />
      </header>

      <div className="grid grid-cols-[320px_minmax(0,1fr)] items-start gap-5">
        <SessionRail
          sessions={threads.sessions}
          activeSessionId={threads.activeSessionId}
          loading={threads.status === "loading"}
          error={threads.status === "restore_error" ? threads.error : null}
          cfg={cfg}
          rag={rag}
          useRag={useRag}
          onNew={threads.startNew}
          onSelect={threads.selectSession}
          onDelete={threads.removeSession}
        />
        <AiChatThread
          disabled={disabled}
          cfg={cfg}
          rag={rag}
          ragErr={ragErr}
          useRag={useRag}
          onUseRagChange={onUseRagChange}
          onPrompt={threads.appendPrompt}
          activeSession={threads.activeSession}
          threadStatus={threads.status}
          threadError={threads.error}
          lastSavedAt={threads.lastSavedAt}
          restoredMessages={threads.restoredMessages}
        />
      </div>
    </div>
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
        prepareSendMessagesRequest: async (options) => {
          return {
            body: {
              ...options.body,
              id: options.id,
              messages: mergeWithRestoredBase(options.messages),
              trigger: options.trigger,
              messageId: options.messageId,
              metadata: options.requestMetadata,
              useRag,
              ragTopK: 8,
            },
          };
        },
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

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AiChatStudio
        cfg={cfg}
        cfgErr={cfgErr}
        rag={rag}
        ragErr={ragErr}
        useRag={useRag}
        onUseRagChange={setUseRag}
      />
    </AssistantRuntimeProvider>
  );
}
