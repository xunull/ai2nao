import { CopilotChat, CopilotKit, useDefaultRenderTool, useRenderTool } from "@copilotkit/react-core/v2";
import { Component, useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";
import { apiGet, apiPost } from "../api";
import {
  createAiChatSession,
  deleteAiChatSession,
  listAiChatSessions,
} from "../aiChat/sessionApi";
import type {
  AiChatSessionSummary,
  LlmChatStatus,
  CodeRunnerStatus,
  RagStatus,
  WebSearchStatus,
} from "../aiChat/types";

function StatusPill({ label, tone }: { label: string; tone: "ok" | "warn" | "idle" }) {
  const cls =
    tone === "ok"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : tone === "warn"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : "border-neutral-200 bg-white text-neutral-600";
  return (
    <span className={`rounded-full border px-3 py-1 text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

function formatSessionTime(value: string | null): string {
  if (!value) return "尚无消息";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

type BashApprovalRequest = {
  id: string;
  sessionId: string | null;
  command: string;
  cwd: string;
  risk: "read-only" | "project-command";
  description: string | null;
  status: "pending" | "approved" | "denied" | "expired";
  source: "local" | "remote";
  remoteRequestId: string | null;
  orphaned: boolean;
  mode: BashPermissionMode;
  suggestedRules: BashPermissionRuleSuggestion[];
  debug: BashPermissionDebug | null;
  savedRule: BashPermissionRule | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
};

type BashPermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";

type BashPermissionRuleType = "exact" | "prefix" | "wildcard";

type BashPermissionRule = {
  id: string;
  behavior: "allow" | "ask" | "deny";
  ruleType: BashPermissionRuleType;
  ruleContent: string;
  scopeType: "global" | "directory";
  scopeValue: string;
  source: "user" | "suggested" | "remote" | "system";
  note: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  useCount: number;
};

type BashPermissionRuleSuggestion = {
  behavior: "allow";
  ruleType: BashPermissionRuleType;
  ruleContent: string;
  label: string;
};

type BashPermissionDebug = {
  mode: BashPermissionMode;
  baseRisk?: "read-only" | "project-command";
  decision: "allow" | "ask" | "deny";
  decisionReason:
    | { type: "static"; message: string }
    | { type: "rule"; behavior: "allow" | "ask" | "deny"; ruleId: string; ruleContent: string }
    | { type: "mode"; mode: BashPermissionMode; message: string }
    | { type: "default"; message: string };
  matchedRules: Array<{ rule: BashPermissionRule; matched: boolean; reason: string }>;
  suggestedRules: BashPermissionRuleSuggestion[];
  source: "local" | "remote";
  orphaned: boolean;
};

const bashToolParametersSchema = z.object({
  command: z.string().optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().optional(),
  description: z.string().optional(),
});

type BashToolResultPreview = {
  ok?: boolean;
  command?: string;
  cwd?: string;
  risk?: "read-only" | "project-command";
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  outputTruncated?: boolean;
  approval?: {
    required?: boolean;
    status?: "not_required" | "approved" | "denied" | "expired";
    reason?: string;
    savedRule?: BashPermissionRule | null;
  };
  deniedReason?: string;
  permissionDebug?: BashPermissionDebug;
};

type BashToolCallCardProps = {
  toolCallId: string;
  command: string;
  cwd?: string;
  description?: string;
  approval?: BashApprovalRequest;
  approvalError: string | null;
  parsedResult: BashToolResultPreview | null;
  status: "inProgress" | "executing" | "complete";
  isExpanded: boolean;
  onExpandedChange: (toolCallId: string, expanded: boolean) => void;
  onDecision: (
    approvalId: string,
    decision: "approve" | "deny",
    rememberRule?: { ruleContent: string; ruleType: BashPermissionRuleType }
  ) => void | Promise<void>;
};

function parseBashToolResult(result: string | undefined): BashToolResultPreview | null {
  if (!result) return null;
  try {
    const parsed = JSON.parse(result) as unknown;
    if (parsed && typeof parsed === "object") return parsed as BashToolResultPreview;
  } catch {
    return null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeBashToolParameters(parameters: unknown): {
  command: string;
  cwd?: string;
  description?: string;
} {
  const record = isRecord(parameters) ? parameters : {};
  return {
    command: optionalString(record.command) ?? "",
    cwd: optionalString(record.cwd),
    description: optionalString(record.description),
  };
}

function normalizeBashToolStatus(status: unknown): BashToolCallCardProps["status"] {
  return status === "executing" || status === "complete" ? status : "inProgress";
}

function normalizeSuggestedRules(value: unknown): BashPermissionRuleSuggestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const ruleType = item.ruleType;
    const ruleContent = optionalString(item.ruleContent);
    if (
      item.behavior !== "allow" ||
      (ruleType !== "exact" && ruleType !== "prefix" && ruleType !== "wildcard") ||
      !ruleContent
    ) {
      return [];
    }
    return [
      {
        behavior: "allow" as const,
        ruleType,
        ruleContent,
        label: optionalString(item.label) ?? ruleContent,
      },
    ];
  });
}

function normalizeMatchedRuleDebug(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || !isRecord(item.rule)) return [];
    return [
      {
        behavior: item.rule.behavior,
        ruleType: item.rule.ruleType,
        ruleContent: item.rule.ruleContent,
        scopeType: item.rule.scopeType,
        scopeValue: item.rule.scopeValue,
        reason: item.reason,
      },
    ];
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateOutput(value: string | undefined, maxChars = 1200): string {
  if (!value) return "";
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n...` : value;
}

function BashToolCallCard({
  toolCallId,
  command,
  cwd,
  description,
  approval,
  approvalError,
  parsedResult,
  status,
  isExpanded,
  onExpandedChange,
  onDecision,
}: BashToolCallCardProps) {
  const isWaiting = status !== "complete" && approval?.status === "pending";
  const suggestedRules = normalizeSuggestedRules(approval?.suggestedRules);
  const defaultSuggestion = suggestedRules[0];
  const [rememberRuleContent, setRememberRuleContent] = useState(defaultSuggestion?.ruleContent ?? "");
  const [localExpanded, setLocalExpanded] = useState(isExpanded);
  useEffect(() => {
    setRememberRuleContent(defaultSuggestion?.ruleContent ?? "");
  }, [defaultSuggestion?.ruleContent]);
  useEffect(() => {
    setLocalExpanded(isExpanded);
  }, [isExpanded]);
  const expanded = isWaiting || localExpanded;
  const risk = approval?.risk ?? parsedResult?.risk;
  const debug = approval?.debug ?? parsedResult?.permissionDebug ?? null;
  const statusLabel = isWaiting
    ? "Waiting approval"
    : status === "complete"
      ? !parsedResult
        ? "Done"
        : parsedResult.approval?.status === "denied"
          ? "Denied"
          : parsedResult.approval?.status === "expired"
            ? "Expired"
            : parsedResult.ok
              ? "Done"
              : "Failed"
      : "Running";
  const isError =
    status === "complete" &&
    (parsedResult?.ok === false ||
      parsedResult?.approval?.status === "denied" ||
      parsedResult?.approval?.status === "expired");
  const dotColor = isError ? "#ef4444" : isWaiting || status !== "complete" ? "#f59e0b" : "#10b981";
  const badgeBg = isError ? "#fee2e2" : isWaiting || status !== "complete" ? "#fef3c7" : "#d1fae5";
  const badgeColor = isError ? "#991b1b" : isWaiting || status !== "complete" ? "#92400e" : "#065f46";
  const stdout = truncateOutput(parsedResult?.stdout);
  const stderr = truncateOutput(parsedResult?.stderr);
  const commandText = command || parsedResult?.command || "正在生成命令...";
  const cwdText = approval?.cwd ?? parsedResult?.cwd ?? cwd ?? ".";
  const descriptionText = approval?.description ?? description;

  return (
    <div style={{ marginTop: "8px", paddingBottom: "8px" }}>
      <div
        style={{
          borderRadius: "12px",
          border: "1px solid #e4e4e7",
          backgroundColor: "#fafafa",
          padding: "14px 16px",
        }}
      >
        <div
          onClick={() => {
            const nextExpanded = !expanded;
            setLocalExpanded(nextExpanded);
            onExpandedChange(toolCallId, nextExpanded);
          }}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
            <svg
              style={{
                height: "14px",
                width: "14px",
                color: "#71717a",
                transition: "transform 0.15s",
                transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                flexShrink: 0,
              }}
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
            <span
              style={{
                display: "inline-block",
                height: "8px",
                width: "8px",
                borderRadius: "50%",
                backgroundColor: dotColor,
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontSize: "13px",
                fontWeight: 600,
                color: "#18181b",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              ai2nao_run_shell
            </span>
          </div>

          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              borderRadius: "9999px",
              padding: "2px 8px",
              fontSize: "11px",
              fontWeight: 500,
              backgroundColor: badgeBg,
              color: badgeColor,
              flexShrink: 0,
            }}
          >
            {statusLabel}
          </span>
        </div>

        {expanded ? (
          <div style={{ marginTop: "12px", display: "grid", gap: "12px" }}>
            <div>
              <div className="text-[10px] font-medium uppercase text-neutral-500">Arguments</div>
              <pre className="mt-1.5 max-h-[200px] overflow-auto rounded-md bg-neutral-100 p-2.5 font-mono text-[11px] leading-5 text-neutral-800 whitespace-pre-wrap break-words">
                {JSON.stringify(
                  {
                    command: commandText,
                    cwd: cwdText,
                    ...(descriptionText ? { description: descriptionText } : {}),
                    ...(risk ? { risk } : {}),
                  },
                  null,
                  2
                )}
              </pre>
            </div>

            {isWaiting && approval ? (
              <div className="grid gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                <div className="min-w-0 text-xs text-amber-950">
                  <div className="font-medium">需要确认后才会执行该 Shell 命令。</div>
                  {approvalError ? <div className="mt-1 truncate">{approvalError}</div> : null}
                </div>
                {suggestedRules.length > 0 ? (
                  <label className="grid gap-1 text-xs text-amber-950">
                    <span className="font-medium">在当前目录下执行并记住规则</span>
                    <input
                      value={rememberRuleContent}
                      onChange={(event) => setRememberRuleContent(event.currentTarget.value)}
                      className="h-8 rounded-md border border-amber-200 bg-white px-2 font-mono text-[11px] text-neutral-800 outline-none focus:border-amber-400"
                    />
                  </label>
                ) : null}
                <div className="flex shrink-0 items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void onDecision(approval.id, "deny");
                    }}
                    className="h-8 rounded-md border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
                  >
                    拒绝
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void onDecision(approval.id, "approve");
                    }}
                    className="h-8 rounded-md bg-neutral-950 px-3 text-xs font-medium text-white hover:bg-neutral-800"
                  >
                    本次执行
                  </button>
                  {rememberRuleContent.trim() ? (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void onDecision(approval.id, "approve", {
                          ruleContent: rememberRuleContent.trim(),
                          ruleType: rememberRuleContent.trim().endsWith(":*") ? "prefix" : "exact",
                        });
                      }}
                      className="h-8 rounded-md bg-emerald-700 px-3 text-xs font-medium text-white hover:bg-emerald-800"
                    >
                      执行并记住
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {debug ? (
              <div>
                <div className="text-[10px] font-medium uppercase text-neutral-500">Permission Debug</div>
                <pre className="mt-1.5 max-h-[180px] overflow-auto rounded-md bg-neutral-100 p-2.5 font-mono text-[11px] leading-5 text-neutral-700 whitespace-pre-wrap break-words">
                  {JSON.stringify(
                    {
                      mode: debug.mode,
                      decision: debug.decision,
                      reason: debug.decisionReason,
                      matchedRules: normalizeMatchedRuleDebug(debug.matchedRules),
                      suggestedRules: normalizeSuggestedRules(debug.suggestedRules),
                      source: debug.source,
                      orphaned: debug.orphaned,
                    },
                    null,
                    2
                  )}
                </pre>
              </div>
            ) : null}

            {parsedResult?.approval?.savedRule ? (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                已保存规则：{parsedResult.approval.savedRule.ruleContent}
                {parsedResult.approval.savedRule.scopeType === "directory"
                  ? `（目录：${parsedResult.approval.savedRule.scopeValue}）`
                  : "（全局）"}
              </div>
            ) : null}

            {status === "complete" && parsedResult ? (
              <div>
                <div className="text-[10px] font-medium uppercase text-neutral-500">Result</div>
                <div className="mt-1.5 grid gap-2">
                  {parsedResult.deniedReason ? (
                    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
                      {parsedResult.deniedReason}
                    </div>
                  ) : null}
                  {stdout ? (
                    <pre className="max-h-48 overflow-auto rounded-md bg-neutral-100 px-3 py-2 font-mono text-xs leading-5 text-neutral-800 whitespace-pre-wrap break-words">
                      {stdout}
                    </pre>
                  ) : null}
                  {stderr ? (
                    <pre className="max-h-48 overflow-auto rounded-md bg-red-50 px-3 py-2 font-mono text-xs leading-5 text-red-900 whitespace-pre-wrap break-words">
                      {stderr}
                    </pre>
                  ) : null}
                  <div className="text-xs text-neutral-500">
                    exit: {parsedResult.exitCode ?? "-"} · {parsedResult.durationMs ?? 0}ms
                    {parsedResult.outputTruncated ? " · 输出已截断" : ""}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BashToolCallRenderer({
  approvals,
  approvalError,
  onDecision,
}: {
  approvals: BashApprovalRequest[];
  approvalError: string | null;
  onDecision: (
    approvalId: string,
    decision: "approve" | "deny",
    rememberRule?: { ruleContent: string; ruleType: BashPermissionRuleType }
  ) => void | Promise<void>;
}) {
  const [expandedToolCallIds, setExpandedToolCallIds] = useState<Record<string, boolean>>({});
  const setToolCallExpanded = useCallback((toolCallId: string, expanded: boolean) => {
    setExpandedToolCallIds((current) => ({ ...current, [toolCallId]: expanded }));
  }, []);

  useDefaultRenderTool();
  useRenderTool(
    {
      name: "ai2nao_run_shell",
      parameters: bashToolParametersSchema,
      render: ({ toolCallId, parameters, status, result }) => {
        const { command, cwd, description } = normalizeBashToolParameters(parameters);
        const safeToolCallId = toolCallId || command || "ai2nao_run_shell";
        const safeStatus = normalizeBashToolStatus(status);
        const approval =
          approvals.find((item) => item.command === command) ??
          (approvals.length === 1 ? approvals[0] : undefined);
        const parsedResult = parseBashToolResult(result);

        return (
          <BashToolCallCard
            toolCallId={safeToolCallId}
            command={command}
            cwd={cwd}
            description={description}
            approval={approval}
            approvalError={approvalError}
            parsedResult={parsedResult}
            status={safeStatus}
            isExpanded={expandedToolCallIds[safeToolCallId] ?? safeStatus !== "complete"}
            onExpandedChange={setToolCallExpanded}
            onDecision={onDecision}
          />
        );
      },
    },
    [approvals, approvalError, expandedToolCallIds, onDecision, setToolCallExpanded]
  );

  return null;
}

type AiChatRenderBoundaryProps = {
  children: ReactNode;
  onError: (message: string) => void;
  resetKey: string | null;
};

type AiChatRenderBoundaryState = {
  hasError: boolean;
  message: string | null;
};

class AiChatRenderBoundary extends Component<
  AiChatRenderBoundaryProps,
  AiChatRenderBoundaryState
> {
  state: AiChatRenderBoundaryState = { hasError: false, message: null };

  static getDerivedStateFromError(error: Error): AiChatRenderBoundaryState {
    return { hasError: true, message: errorMessage(error) };
  }

  componentDidCatch(error: Error) {
    this.props.onError(`AI 对话界面渲染失败：${errorMessage(error)}`);
  }

  componentDidUpdate(prevProps: AiChatRenderBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false, message: null });
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center rounded-lg border border-red-200 bg-red-50 px-6 text-center text-sm text-red-900">
        <div className="font-medium">AI 对话界面渲染失败。</div>
        {this.state.message ? (
          <div className="mt-2 max-w-[720px] break-words text-xs">{this.state.message}</div>
        ) : null}
      </div>
    );
  }
}

export function AiChat() {
  const [cfg, setCfg] = useState<LlmChatStatus | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const [rag, setRag] = useState<RagStatus | null>(null);
  const [ragErr, setRagErr] = useState<string | null>(null);
  const [useRag, setUseRag] = useState(false);
  const [webSearch, setWebSearch] = useState<WebSearchStatus | null>(null);
  const [webSearchErr, setWebSearchErr] = useState<string | null>(null);
  const [useWebSearch, setUseWebSearch] = useState(false);
  const [useSessionMemory, setUseSessionMemory] = useState(true);
  const [useCodeExecution, setUseCodeExecution] = useState(false);
  const [useShellExecution, setUseShellExecution] = useState(false);
  const [shellPermissionMode, setShellPermissionMode] = useState<BashPermissionMode>("default");
  const [codeExecutionRuntime, setCodeExecutionRuntime] = useState<"pyodide" | "docker">("pyodide");
  const [codeRunner, setCodeRunner] = useState<CodeRunnerStatus | null>(null);
  const [codeRunnerErr, setCodeRunnerErr] = useState<string | null>(null);
  const [bashApprovals, setBashApprovals] = useState<BashApprovalRequest[]>([]);
  const [bashApprovalErr, setBashApprovalErr] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AiChatSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionErr, setSessionErr] = useState<string | null>(null);
  const [chatErr, setChatErr] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(true);

  const refreshSessions = useCallback(async (signal?: AbortSignal) => {
    const rows = await listAiChatSessions({ signal });
    setSessions(rows);
    return rows;
  }, []);

  const createAndSelect = useCallback(async () => {
    const session = await createAiChatSession();
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setSessionErr(null);
    setChatErr(null);
  }, []);

  const deleteAndSelectNext = useCallback(
    async (sessionId: string) => {
      await deleteAiChatSession(sessionId);
      const next = sessions.filter((s) => s.id !== sessionId);
      setSessions(next);
      if (activeSessionId === sessionId) {
        setActiveSessionId(next[0]?.id ?? null);
        if (!next[0]) await createAndSelect();
      }
    },
    [activeSessionId, createAndSelect, sessions]
  );

  const handleChatError = useCallback((event: unknown) => {
    const maybeRecord =
      event && typeof event === "object" ? (event as Record<string, unknown>) : {};
    const rawError = maybeRecord.error;
    const message =
      rawError instanceof Error
        ? rawError.message
        : typeof rawError === "string"
          ? rawError
          : typeof maybeRecord.message === "string"
            ? maybeRecord.message
            : "AI 对话请求失败，请检查后端服务和模型配置。";
    setChatErr(message);
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    apiGet<LlmChatStatus>("/api/llm-chat/status", { signal: ac.signal })
      .then((s) => {
        setCfg(s);
        setCfgErr(null);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setCfgErr(e instanceof Error ? e.message : String(e));
      });
    apiGet<RagStatus>("/api/rag/status", { signal: ac.signal })
      .then((s) => {
        setRag(s);
        setRagErr(null);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setRagErr(e instanceof Error ? e.message : String(e));
      });
    apiGet<WebSearchStatus>("/api/web-search/status", { signal: ac.signal })
      .then((s) => {
        setWebSearch(s);
        setWebSearchErr(null);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setWebSearchErr(e instanceof Error ? e.message : String(e));
      });
    apiGet<CodeRunnerStatus>("/api/code-runner/status", { signal: ac.signal })
      .then((s) => {
        setCodeRunner(s);
        setCodeRunnerErr(null);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setCodeRunnerErr(e instanceof Error ? e.message : String(e));
      });
    return () => ac.abort();
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    setLoadingSessions(true);
    refreshSessions(ac.signal)
      .then(async (rows) => {
        if (ac.signal.aborted) return;
        if (rows[0]) {
          setActiveSessionId(rows[0].id);
        } else {
          await createAndSelect();
        }
        setSessionErr(null);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setSessionErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoadingSessions(false);
      });
    return () => ac.abort();
  }, [createAndSelect, refreshSessions]);

  const refreshBashApprovals = useCallback(
    async (signal?: AbortSignal) => {
      if (!activeSessionId || !useShellExecution) {
        setBashApprovals([]);
        return;
      }
      const result = await apiGet<{ approvals: BashApprovalRequest[] }>(
        `/api/bash-approvals?sessionId=${encodeURIComponent(activeSessionId)}`,
        { signal }
      );
      setBashApprovals(result.approvals);
      setBashApprovalErr(null);
    },
    [activeSessionId, useShellExecution]
  );

  useEffect(() => {
    if (!activeSessionId || !useShellExecution) {
      setBashApprovals([]);
      return;
    }
    const ac = new AbortController();
    void refreshBashApprovals(ac.signal).catch((e: unknown) => {
      if (!ac.signal.aborted) setBashApprovalErr(e instanceof Error ? e.message : String(e));
    });
    const id = window.setInterval(() => {
      void refreshBashApprovals().catch((e: unknown) => {
        setBashApprovalErr(e instanceof Error ? e.message : String(e));
      });
    }, 1000);
    return () => {
      ac.abort();
      window.clearInterval(id);
    };
  }, [activeSessionId, refreshBashApprovals, useShellExecution]);

  const decideBashApproval = useCallback(
    async (
      approvalId: string,
      decision: "approve" | "deny",
      rememberRule?: { ruleContent: string; ruleType: BashPermissionRuleType }
    ) => {
      await apiPost(
        `/api/bash-approvals/${approvalId}/${decision}`,
        rememberRule
          ? {
              remember: true,
              rememberRule: {
                behavior: decision === "approve" ? "allow" : "deny",
                ...rememberRule,
              },
            }
          : {}
      );
      await refreshBashApprovals();
    },
    [refreshBashApprovals]
  );

  const disabled = cfg?.configured !== true;
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const webSearchAvailable = webSearch?.ok === true;
  const effectiveWebSearch = useWebSearch && webSearchAvailable;
  const dockerRuntimeAvailable = codeRunner?.docker.available === true;
  const effectiveCodeRuntime = codeExecutionRuntime === "docker" && dockerRuntimeAvailable ? "docker" : "pyodide";

  return (
    <div className="cursor-chat-root -mx-1 h-[calc(100vh-56px)] min-h-[720px] overflow-hidden rounded-xl border border-neutral-200 bg-[#f7f7f4]">
      <link rel="stylesheet" href="/vendor/copilotkit-v2.css" />
      <div className="grid h-full grid-cols-[300px_minmax(0,1fr)]">
        <aside className="flex h-full min-h-0 flex-col border-r border-neutral-200 bg-white">
          <div className="border-b border-neutral-200 px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-400">
                  AI Studio
                </p>
                <h1 className="mt-1 text-xl font-semibold tracking-tight text-neutral-950">
                  AI 对话
                </h1>
              </div>
              <button
                type="button"
                onClick={() => void createAndSelect()}
                className="h-9 rounded-md bg-neutral-950 px-3 text-sm font-medium text-white hover:bg-neutral-800"
              >
                新对话
              </button>
            </div>
            {sessionErr ? (
              <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
                {sessionErr}
              </p>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3" data-testid="ai-chat-session-rail">
            {loadingSessions ? (
              <p className="px-3 py-2 text-sm text-neutral-500">加载会话中...</p>
            ) : sessions.length === 0 ? (
              <p className="px-3 py-2 text-sm text-neutral-500">还没有会话</p>
            ) : (
              sessions.map((session) => {
                const active = session.id === activeSessionId;
                return (
                  <div
                    key={session.id}
                    className={`group mb-1 flex items-center gap-2 rounded-lg border px-3 py-2 ${
                      active
                        ? "border-neutral-900 bg-neutral-950 text-white"
                        : "border-transparent bg-white text-neutral-800 hover:border-neutral-200 hover:bg-neutral-50"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setActiveSessionId(session.id);
                        setChatErr(null);
                      }}
                      className="min-w-0 flex-1 text-left"
                      data-testid="ai-chat-session"
                    >
                      <div className="truncate text-sm font-medium">{session.title}</div>
                      <div className={`mt-1 text-xs ${active ? "text-neutral-300" : "text-neutral-500"}`}>
                        {formatSessionTime(session.last_message_at)}
                      </div>
                    </button>
                    <button
                      type="button"
                      aria-label="删除对话"
                      onClick={() => void deleteAndSelectNext(session.id)}
                      className={`rounded px-2 py-1 text-xs ${
                        active ? "text-neutral-300 hover:bg-white/10" : "text-neutral-400 hover:bg-neutral-100"
                      }`}
                    >
                      删除
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        <main className="flex h-full min-h-0 flex-col">
          <header className="flex flex-col gap-3 border-b border-neutral-200 bg-white/80 px-5 py-4">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold text-neutral-950">
                {activeSession?.title ?? "新对话"}
              </h2>
              <p className="mt-1 text-sm text-neutral-500">
                每个历史会话独立保存到本机 SQLite，模型与工具流程由 ai2nao 后端掌控。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill
                label={cfg?.configured ? `模型 ${cfg.model}` : cfgErr ?? "模型未配置"}
                tone={cfg?.configured ? "ok" : "warn"}
              />
              <StatusPill
                label={rag?.ok ? `RAG ${rag.chunkCount} chunks` : ragErr ?? "RAG 不可用"}
                tone={rag?.ok ? "ok" : "idle"}
              />
              <StatusPill
                label={
                  webSearch?.ok
                    ? `Web ${webSearch.provider}`
                    : webSearch?.error ?? webSearchErr ?? "Web 未配置"
                }
                tone={webSearch?.ok ? "ok" : "idle"}
              />
              <label className="flex h-8 items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-700">
                <input
                  type="checkbox"
                  checked={useRag}
                  onChange={(e) => setUseRag(e.currentTarget.checked)}
                  className="h-3.5 w-3.5"
                />
                RAG
              </label>
              <label className={`flex h-8 items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 text-xs font-medium ${
                webSearchAvailable ? "text-neutral-700" : "text-neutral-400"
              }`}>
                <input
                  type="checkbox"
                  checked={useWebSearch}
                  disabled={!webSearchAvailable}
                  onChange={(e) => setUseWebSearch(e.currentTarget.checked)}
                  className="h-3.5 w-3.5"
                />
                Web Search
              </label>
              <label className="flex h-8 items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-700">
                <input
                  type="checkbox"
                  checked={useSessionMemory}
                  onChange={(e) => setUseSessionMemory(e.currentTarget.checked)}
                  className="h-3.5 w-3.5"
                />
                Memory
              </label>
              <label className="flex h-8 items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-700">
                <input
                  type="checkbox"
                  checked={useCodeExecution}
                  onChange={(e) => setUseCodeExecution(e.currentTarget.checked)}
                  className="h-3.5 w-3.5"
                />
                Code
              </label>
              {useCodeExecution ? (
                <select
                  value={codeExecutionRuntime}
                  onChange={(e) => setCodeExecutionRuntime(e.currentTarget.value === "docker" ? "docker" : "pyodide")}
                  className="h-8 rounded-full border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-700"
                  title={codeRunnerErr ?? codeRunner?.docker.error ?? undefined}
                >
                  <option value="pyodide">Safe Python</option>
                  <option value="docker" disabled={!dockerRuntimeAvailable}>
                    Docker Python
                  </option>
                </select>
              ) : null}
              <label className="flex h-8 items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-700">
                <input
                  type="checkbox"
                  checked={useShellExecution}
                  onChange={(e) => setUseShellExecution(e.currentTarget.checked)}
                  className="h-3.5 w-3.5"
                />
                Shell
              </label>
              {useShellExecution ? (
                <select
                  value={shellPermissionMode}
                  onChange={(e) => setShellPermissionMode(e.currentTarget.value as BashPermissionMode)}
                  className="h-8 rounded-full border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-700"
                  title="Shell permission mode"
                >
                  <option value="default">Default approval</option>
                  <option value="plan">Plan read-only</option>
                  <option value="acceptEdits">Accept edits</option>
                  <option value="dontAsk">Don't ask</option>
                  <option value="bypassPermissions">Bypass prompts</option>
                </select>
              ) : null}
            </div>
          </header>

          <section className="min-h-0 flex-1 p-4" data-testid="ai-chat-thread-shell">
            {disabled ? (
              <div className="flex h-full flex-col items-center justify-center rounded-lg border border-dashed border-neutral-300 bg-white px-6 text-center text-sm text-neutral-600">
                <div>请先配置 LLM，再开始对话。</div>
                <div className="mt-2 max-w-[720px] text-xs text-neutral-500">
                  在「设置 → AI 与模型」里填服务商、模型与 API Key。
                </div>
              </div>
            ) : activeSessionId ? (
              <AiChatRenderBoundary resetKey={activeSessionId} onError={setChatErr}>
                <CopilotKit
                  runtimeUrl="/api/copilotkit"
                  useSingleEndpoint={true}
                  properties={{
                    useRag,
                    ragTopK: 8,
                    webSearchEnabled: effectiveWebSearch,
                    sessionMemoryEnabled: useSessionMemory,
                    sessionMemoryTopK: 8,
                    codeExecutionEnabled: useCodeExecution,
                    codeExecutionRuntime: effectiveCodeRuntime,
                    codeExecutionTimeoutMs: 10_000,
                    shellExecutionEnabled: useShellExecution,
                    shellExecutionTimeoutMs: 10_000,
                    shellPermissionMode,
                  }}
                  onError={handleChatError}
                  showDevConsole={false}
                >
                  <BashToolCallRenderer
                    approvals={bashApprovals}
                    approvalError={bashApprovalErr}
                    onDecision={decideBashApproval}
                  />
                  <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm [&_.copilotKitChat]:h-full">
                    {chatErr ? (
                      <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
                        {chatErr}
                      </div>
                    ) : null}
                    <CopilotChat
                      key={activeSessionId}
                      threadId={activeSessionId}
                      onError={handleChatError}
                      labels={{
                        modalHeaderTitle: "AI 对话",
                        welcomeMessageText: "开始新的本机 AI 对话",
                        chatInputPlaceholder: "输入消息，按 Enter 发送",
                      }}
                    />
                  </div>
                </CopilotKit>
              </AiChatRenderBoundary>
            ) : (
              <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-neutral-300 bg-white text-sm text-neutral-600">
                正在准备新对话...
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
