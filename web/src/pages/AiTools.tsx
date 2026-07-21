import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api";

type AiToolKind = "desktop-app" | "cli" | "local-runtime" | "ide-extension";
type DetectSource = "mac_apps" | "brew" | "path";

type AiToolView = {
  toolKey: string;
  name: string;
  kind: AiToolKind;
  vendor: string | null;
  detectSources: DetectSource[];
  version: string | null;
  installPath: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  missingSince: string | null;
};

type Group = { kind: AiToolKind; label: string; tools: AiToolView[] };
type ListRes = { groups: Group[]; total: number };
type Status = { total: number; present: number; lastSyncAt: string | null };
type ScanRes = {
  ok: boolean;
  status: string;
  inserted: number;
  updated: number;
  markedMissing: number;
};

const SOURCE_LABEL: Record<DetectSource, string> = {
  mac_apps: "应用",
  brew: "Homebrew",
  path: "PATH",
};

export function AiTools() {
  const queryClient = useQueryClient();
  const [includeMissing, setIncludeMissing] = useState(false);

  const statusQ = useQuery({
    queryKey: ["ai-tools-status"],
    queryFn: () => apiGet<Status>("/api/ai-tools/status"),
  });
  const listQ = useQuery({
    queryKey: ["ai-tools", includeMissing],
    queryFn: () =>
      apiGet<ListRes>(`/api/ai-tools?includeMissing=${includeMissing ? "1" : "0"}`),
  });
  const scanM = useMutation({
    mutationFn: () => apiPost<ScanRes>("/api/ai-tools/scan", {}),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["ai-tools"] });
      await queryClient.invalidateQueries({ queryKey: ["ai-tools-status"] });
    },
  });

  const groups = listQ.data?.groups ?? [];

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">AI 工具</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            识别本机装了哪些 AI 工具：桌面 app、命令行 CLI、本地运行时。来自已扫的应用 /
            Homebrew 清单 + PATH 探测。
          </p>
        </div>
        <button
          type="button"
          onClick={() => scanM.mutate()}
          disabled={scanM.isPending}
          className="rounded bg-[var(--accent)] px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {scanM.isPending ? "扫描中…" : "立即扫描"}
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-4 rounded border border-[var(--border)] bg-white px-4 py-3 text-sm">
        <span>
          在场 <b>{statusQ.data?.present ?? 0}</b> 个
          {statusQ.data && statusQ.data.total > statusQ.data.present ? (
            <span className="text-[var(--muted)]">
              （另有 {statusQ.data.total - statusQ.data.present} 个已移除）
            </span>
          ) : null}
        </span>
        <span className="text-[var(--muted)]">
          最近扫描：{statusQ.data?.lastSyncAt ? statusQ.data.lastSyncAt.slice(0, 16).replace("T", " ") : "尚未扫描"}
        </span>
        <label className="ml-auto flex items-center gap-2 text-[var(--muted)]">
          <input
            type="checkbox"
            checked={includeMissing}
            onChange={(e) => setIncludeMissing(e.target.checked)}
          />
          显示已移除
        </label>
      </div>

      {scanM.isError ? (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {String((scanM.error as Error).message)}
        </div>
      ) : null}

      {listQ.isLoading ? (
        <p className="text-sm text-[var(--muted)]">加载中…</p>
      ) : listQ.error ? (
        <p className="text-sm text-red-700">{String((listQ.error as Error).message)}</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">
          暂无记录。点「立即扫描」，或先运行应用 / Homebrew 同步后再看。
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <ToolGroup key={g.kind} group={g} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolGroup({ group }: { group: Group }) {
  return (
    <div className="overflow-x-auto rounded border border-[var(--border)] bg-white">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2 text-sm">
        <h2 className="font-medium">{group.label}</h2>
        <span className="text-[var(--muted)]">{group.tools.length} 个</span>
      </div>
      <table className="min-w-full text-sm">
        <thead className="bg-neutral-50 text-left">
          <tr>
            <th className="px-3 py-2 font-medium">名称</th>
            <th className="px-3 py-2 font-medium">厂商</th>
            <th className="px-3 py-2 font-medium">检测来源</th>
            <th className="px-3 py-2 font-medium">版本</th>
            <th className="px-3 py-2 font-medium">状态</th>
          </tr>
        </thead>
        <tbody>
          {group.tools.map((t) => (
            <tr key={t.toolKey} className="border-t border-[var(--border)] align-top">
              <td className="px-3 py-2 font-medium">
                {t.name}
                {t.installPath ? (
                  <div
                    className="mt-0.5 max-w-[26rem] truncate text-xs text-[var(--muted)]"
                    title={t.installPath}
                  >
                    {t.installPath}
                  </div>
                ) : null}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-[var(--muted)]">
                {t.vendor ?? "—"}
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  {t.detectSources.map((s) => (
                    <span
                      key={s}
                      className="rounded border border-[var(--border)] px-1.5 py-0.5 text-xs text-[var(--muted)]"
                    >
                      {SOURCE_LABEL[s]}
                    </span>
                  ))}
                </div>
              </td>
              <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-[var(--muted)]">
                {t.version ?? "—"}
              </td>
              <td className="whitespace-nowrap px-3 py-2">
                {t.missingSince ? (
                  <span className="text-amber-700">已移除</span>
                ) : (
                  <span className="text-emerald-700">在场</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
