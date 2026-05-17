import {
  useAgentContext,
  useFrontendTool,
  useHumanInTheLoop,
} from "@copilotkit/react-core/v2";
import type React from "react";
import { z } from "zod";
import { apiPost } from "../api";
import type { AiChatSessionSummary, LlmChatStatus, RagStatus } from "./types";

type RagSearchResponse = {
  ok: true;
  query: string;
  hits: RagEvidenceHit[];
};

type RagEvidenceHit = {
  id: number;
  sourceRoot: string;
  filePath: string;
  content: string;
  ftsRank: number;
  cosine?: number;
};

type AiChatCopilotToolsProps = {
  activeSession: AiChatSessionSummary | null;
  cfg: LlmChatStatus | null;
  rag: RagStatus | null;
  sessions: AiChatSessionSummary[];
  useRag: boolean;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => Promise<void>;
};

const emptyParams = z.object({});

const ragSearchParams = z.object({
  query: z.string().describe("要在本机 RAG 索引中搜索的问题或关键词。"),
  topK: z.number().optional().describe("返回证据条数，建议 3 到 6。"),
});

const sessionParams = z.object({
  sessionId: z.string().describe("AI 对话会话 ID。"),
});

const deleteSessionParams = z.object({
  sessionId: z.string().describe("要删除的 AI 对话会话 ID。"),
  sessionTitle: z.string().optional().describe("会话标题，用于确认界面展示。"),
});

export function AiChatCopilotTools({
  activeSession,
  cfg,
  rag,
  sessions,
  useRag,
  onSelectSession,
  onDeleteSession,
}: AiChatCopilotToolsProps) {
  const contextValue = {
    page: "ai-chat",
    activeSession: activeSession
      ? {
          id: activeSession.id,
          title: activeSession.title,
          messageCount: activeSession.message_count,
          lastMessageAt: activeSession.last_message_at,
        }
      : null,
    llm: cfg
      ? {
          configured: cfg.configured,
          provider: cfg.provider,
          model: cfg.model,
          baseHost: cfg.baseHost,
        }
      : null,
    rag: rag
      ? {
          enabledForChat: useRag,
          chunkCount: rag.chunkCount,
          corpusRoots: rag.corpusRoots,
          embeddingEnabled: rag.embeddingEnabled,
        }
      : null,
    recentSessions: sessions.slice(0, 12).map((session) => ({
      id: session.id,
      title: session.title,
      messageCount: session.message_count,
      lastMessageAt: session.last_message_at,
    })),
  };

  useAgentContext({
    description:
      "ai2nao 当前 AI 对话工作台状态。优先使用这里的页面、会话、模型和 RAG 状态来理解用户正在操作什么。",
    value: contextValue,
  });

  useFrontendTool(
    {
      name: "ai2nao_read_workspace_context",
      description:
        "读取 ai2nao 当前 AI 对话工作台状态，包括当前会话、模型配置、RAG 状态和最近会话列表。这个工具只读，不会修改任何数据。",
      parameters: emptyParams,
      handler: async () => contextValue,
      render: ({ status }) => (
        <ToolFrame title="工作台上下文" status={status}>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <Metric label="模型" value={cfg?.model ?? "未配置"} />
            <Metric label="RAG" value={rag ? `${rag.chunkCount} chunks` : "不可用"} />
            <Metric label="会话" value={activeSession?.title ?? "未选择"} />
          </div>
        </ToolFrame>
      ),
    },
    [activeSession?.id, cfg?.model, rag?.chunkCount, useRag, sessions.length]
  );

  useFrontendTool(
    {
      name: "ai2nao_search_rag_evidence",
      description:
        "在本机 RAG 索引中搜索证据，并把匹配文件、片段和排序信息展示给用户。适合回答需要引用本机资料、项目文档或历史上下文的问题。",
      parameters: ragSearchParams,
      available: Boolean(rag?.ok && rag.chunkCount > 0),
      handler: async ({ query, topK }) => {
        return apiPost<RagSearchResponse>("/api/rag/search", {
          query,
          topK: Math.min(12, Math.max(1, topK ?? 6)),
        });
      },
      render: ({ args, result, status }) => (
        <RagEvidenceCard query={String(args.query ?? "")} result={result} status={status} />
      ),
    },
    [rag?.chunkCount]
  );

  useFrontendTool(
    {
      name: "ai2nao_select_session",
      description:
        "切换到一个已有 AI 对话会话。只改变当前页面选中的会话，不会删除或写入数据。",
      parameters: sessionParams,
      handler: async ({ sessionId }) => {
        const session = sessions.find((item) => item.id === sessionId);
        if (!session) return { ok: false, error: "session not found", sessionId };
        onSelectSession(sessionId);
        return { ok: true, sessionId, title: session.title };
      },
      render: ({ args, status }) => (
        <ToolFrame title="切换会话" status={status}>
          <p className="truncate text-xs text-neutral-700">目标会话：{String(args.sessionId ?? "")}</p>
        </ToolFrame>
      ),
    },
    [sessions, onSelectSession]
  );

  useHumanInTheLoop(
    {
      name: "ai2nao_confirm_session_delete",
      description:
        "删除 AI 对话会话前必须调用这个确认工具。只有用户在确认面板点击删除后，才能继续删除流程。",
      parameters: deleteSessionParams,
      render: (props) => (
        <DeleteSessionApproval
          {...props}
          onDeleteSession={onDeleteSession}
        />
      ),
    },
    [onDeleteSession]
  );

  return null;
}

function ToolFrame({
  children,
  status,
  title,
}: {
  children: React.ReactNode;
  status: string;
  title: string;
}) {
  return (
    <div className="my-2 rounded-lg border border-neutral-200 bg-white p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-neutral-950">{title}</span>
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600">
          {statusLabel(status)}
        </span>
      </div>
      {children}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5">
      <div className="text-[11px] text-neutral-500">{label}</div>
      <div className="truncate font-medium text-neutral-900">{value}</div>
    </div>
  );
}

function RagEvidenceCard({
  query,
  result,
  status,
}: {
  query: string;
  result: unknown;
  status: string;
}) {
  const parsed = parseToolResult<RagSearchResponse>(result);
  const hits = parsed?.hits ?? [];
  return (
    <ToolFrame title="RAG 证据" status={status}>
      <p className="mb-2 text-xs text-neutral-600">查询：{query || "准备中"}</p>
      {status !== "complete" ? (
        <p className="text-sm text-neutral-700">正在检索本机索引...</p>
      ) : hits.length === 0 ? (
        <p className="text-sm text-neutral-700">没有找到匹配证据。</p>
      ) : (
        <div className="space-y-2">
          {hits.slice(0, 5).map((hit) => (
            <div key={hit.id} className="rounded-md border border-neutral-200 bg-neutral-50 p-2">
              <div className="truncate text-xs font-semibold text-neutral-900">
                {hit.filePath}
              </div>
              <p className="mt-1 max-h-16 overflow-hidden text-xs leading-5 text-neutral-700">
                {hit.content}
              </p>
            </div>
          ))}
        </div>
      )}
    </ToolFrame>
  );
}

function DeleteSessionApproval({
  args,
  status,
  respond,
  result,
  onDeleteSession,
}: {
  args: { sessionId?: string; sessionTitle?: string };
  status: string;
  respond?: (result: unknown) => Promise<void>;
  result?: string;
  onDeleteSession: (sessionId: string) => Promise<void>;
}) {
  const sessionId = args.sessionId ?? "";
  const title = args.sessionTitle || sessionId || "未知会话";

  async function approve() {
    if (!sessionId || !respond) return;
    await onDeleteSession(sessionId);
    await respond({ approved: true, deletedSessionId: sessionId });
  }

  async function deny() {
    if (!respond) return;
    await respond({ approved: false, reason: "user denied deletion" });
  }

  return (
    <ToolFrame title="删除确认" status={status}>
      {status === "complete" ? (
        <p className="text-sm text-neutral-700">{result || "确认流程已完成。"}</p>
      ) : (
        <>
          <p className="text-sm text-neutral-800">确认删除会话：{title}</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={!respond || !sessionId}
              onClick={() => void approve()}
              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              删除
            </button>
            <button
              type="button"
              disabled={!respond}
              onClick={() => void deny()}
              className="rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-xs font-semibold text-neutral-700 disabled:opacity-50"
            >
              保留
            </button>
          </div>
        </>
      )}
    </ToolFrame>
  );
}

function parseToolResult<T>(value: unknown): T | null {
  if (!value) return null;
  if (typeof value === "object") return value as T;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function statusLabel(status: string) {
  if (status === "complete") return "完成";
  if (status === "executing") return "执行中";
  return "准备中";
}
