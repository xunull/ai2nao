import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiGet, apiPost } from "../api";

type Mode = "raw" | "filtered";

type DirectoryRow = {
  cwd: string;
  raw_command_count: number;
  filtered_command_count: number;
  raw_failed_count: number;
  filtered_failed_count: number;
  first_timestamp_ns: number | null;
  last_timestamp_ns: number | null;
  last_exit: number | null;
  updated_at: string;
};

type CommandRow = {
  cwd: string;
  command: string;
  raw_count: number;
  filtered_count: number;
  raw_failed_count: number;
  filtered_failed_count: number;
  first_timestamp_ns: number | null;
  last_timestamp_ns: number | null;
  last_exit: number | null;
  updated_at: string;
};

type DirectoryActivityStatus = {
  ruleVersion: number;
  configPath: string;
  configOk: boolean;
  configIssues: { path: string; message: string }[];
  filterConfigHash: string | null;
  state: {
    last_rebuilt_at: string | null;
    last_error: string | null;
    error_code: string | null;
    source_entry_count: number;
    derived_directory_count: number;
    derived_command_count: number;
    last_rebuild_duration_ms: number | null;
  } | null;
  currentDerivedDirectoryCount: number;
  currentDerivedCommandCount: number;
  fresh: boolean;
  staleReasons: string[];
};

type StatusRes = {
  enabled: boolean;
  atuinPath: string | null;
  directoryActivity: DirectoryActivityStatus;
};

function enc(value: string): string {
  return encodeURIComponent(value);
}

function modeCount(row: DirectoryRow, mode: Mode): number {
  return mode === "raw" ? row.raw_command_count : row.filtered_command_count;
}

function modeFailed(row: DirectoryRow, mode: Mode): number {
  return mode === "raw" ? row.raw_failed_count : row.filtered_failed_count;
}

function commandCount(row: CommandRow, mode: Mode): number {
  return mode === "raw" ? row.raw_count : row.filtered_count;
}

function commandFailed(row: CommandRow, mode: Mode): number {
  return mode === "raw" ? row.raw_failed_count : row.filtered_failed_count;
}

function formatNs(ns: number | null): string {
  if (ns == null) return "-";
  return new Date(Math.floor(ns / 1_000_000)).toLocaleString();
}

function failureRate(failed: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((failed / total) * 100)}%`;
}

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function AtuinDirectories() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const mode: Mode = params.get("mode") === "raw" ? "raw" : "filtered";
  const selectedCwd = params.get("cwd") ?? "";
  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q, 200);

  function setMode(next: Mode) {
    const copy = new URLSearchParams(params);
    copy.set("mode", next);
    setParams(copy);
  }

  function selectCwd(cwd: string) {
    const copy = new URLSearchParams(params);
    copy.set("mode", mode);
    copy.set("cwd", cwd);
    setParams(copy);
  }

  const statusQ = useQuery({
    queryKey: ["atuin-directory-status"],
    queryFn: () => apiGet<StatusRes>("/api/atuin/directories/status"),
  });

  const topQ = useQuery({
    queryKey: ["atuin-directory-top", mode],
    queryFn: () =>
      apiGet<{ directories: DirectoryRow[] }>(
        `/api/atuin/directories/top?mode=${mode}&limit=80`
      ),
  });

  const searchQ = useQuery({
    queryKey: ["atuin-directory-search", mode, debouncedQ],
    queryFn: () =>
      apiGet<{ directories: DirectoryRow[] }>(
        `/api/atuin/directories/search?mode=${mode}&limit=50&q=${enc(debouncedQ)}`
      ),
    enabled: debouncedQ.trim().length > 0,
  });

  const commandsQ = useQuery({
    queryKey: ["atuin-directory-commands", mode, selectedCwd],
    queryFn: () =>
      apiGet<{ commands: CommandRow[] }>(
        `/api/atuin/directories/commands?mode=${mode}&limit=100&cwd=${enc(selectedCwd)}`
      ),
    enabled: selectedCwd.length > 0,
  });

  const rebuild = useMutation({
    mutationFn: () => apiPost<{ ok: boolean }>("/api/atuin/directories/rebuild", {}),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["atuin-directory-status"] }),
        queryClient.invalidateQueries({ queryKey: ["atuin-directory-top"] }),
        queryClient.invalidateQueries({ queryKey: ["atuin-directory-search"] }),
        queryClient.invalidateQueries({ queryKey: ["atuin-directory-commands"] }),
      ]);
    },
  });

  const selectedFromTop = useMemo(
    () => topQ.data?.directories.find((row) => row.cwd === selectedCwd) ?? null,
    [topQ.data, selectedCwd]
  );
  const searchRows = searchQ.data?.directories ?? [];

  if (statusQ.isLoading) return <p className="text-[var(--muted)]">加载中...</p>;
  if (statusQ.isError) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-red-800">
        {String((statusQ.error as Error).message)}
      </div>
    );
  }

  const status = statusQ.data?.directoryActivity;
  const enabled = statusQ.data?.enabled === true;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-xl font-semibold">Atuin 目录活动</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            从 Atuin 历史重建目录维度的命令聚合，raw 保留全部命令，filtered 默认排除低信息命令。
          </p>
        </div>
        <button
          type="button"
          disabled={!enabled || rebuild.isPending}
          onClick={() => rebuild.mutate()}
          className="min-h-11 shrink-0 rounded bg-[var(--accent)] px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {rebuild.isPending ? "重建中" : "重建"}
        </button>
      </div>

      <section
        className={
          "rounded border p-4 text-sm " +
          (status?.fresh
            ? "border-green-200 bg-green-50 text-green-900"
            : "border-amber-200 bg-amber-50 text-amber-900")
        }
      >
        <div className="grid grid-cols-[1fr_auto_auto_auto] items-start gap-x-6 gap-y-2">
          <div>
            <div className="font-medium">{enabled ? "Atuin 已连接" : "Atuin 未连接"}</div>
            <div className="mt-1 break-all text-xs">
              {statusQ.data?.atuinPath ?? "启动 serve 时传入 --atuin-db，或使用默认 ~/.local/share/atuin/history.db"}
            </div>
          </div>
          <div>
            <div className="text-xs opacity-75">source_count</div>
            <div className="font-mono">{status?.state?.source_entry_count ?? 0}</div>
          </div>
          <div>
            <div className="text-xs opacity-75">duration</div>
            <div className="font-mono">
              {status?.state?.last_rebuild_duration_ms == null
                ? "-"
                : `${status.state.last_rebuild_duration_ms}ms`}
            </div>
          </div>
          <div>
            <div className="text-xs opacity-75">state</div>
            <div>{status?.fresh ? "fresh" : status?.staleReasons.join(", ") || "not_built"}</div>
          </div>
        </div>
        {status && !status.configOk ? (
          <div className="mt-3 border-t border-amber-200 pt-3">
            {status.configIssues.map((issue) => (
              <div key={`${issue.path}:${issue.message}`}>
                {issue.path}: {issue.message}
              </div>
            ))}
          </div>
        ) : null}
        {rebuild.isError ? (
          <div className="mt-3 border-t border-amber-200 pt-3">
            {String((rebuild.error as Error).message)}
          </div>
        ) : null}
      </section>

      <div className="flex items-end gap-4">
        <div className="inline-flex rounded border border-[var(--border)] bg-white p-1">
          {(["filtered", "raw"] as Mode[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setMode(item)}
              className={
                "min-h-9 rounded px-3 text-sm " +
                (mode === item ? "bg-[var(--accent)] text-white" : "text-[var(--fg)]")
              }
            >
              {item}
            </button>
          ))}
        </div>
        <label className="flex min-w-[24rem] flex-col gap-1 text-xs text-[var(--muted)]">
          搜索目录
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="min-h-11 rounded border border-[var(--border)] px-3 py-2 text-sm text-[var(--fg)]"
            placeholder="/Users/quincy/..."
          />
        </label>
      </div>

      {debouncedQ.trim() ? (
        <section className="rounded border border-[var(--border)] bg-white">
          <div className="border-b border-[var(--border)] px-4 py-3 text-sm font-medium">
            搜索结果
          </div>
          <DirectoryTable
            rows={searchRows}
            mode={mode}
            selectedCwd={selectedCwd}
            onSelect={selectCwd}
          />
        </section>
      ) : null}

      <div className="grid grid-cols-[minmax(22rem,0.95fr)_minmax(30rem,1.35fr)] gap-6">
        <section className="rounded border border-[var(--border)] bg-white">
          <div className="border-b border-[var(--border)] px-4 py-3 text-sm font-medium">
            高频目录
          </div>
          <DirectoryTable
            rows={topQ.data?.directories ?? []}
            mode={mode}
            selectedCwd={selectedCwd}
            onSelect={selectCwd}
          />
        </section>

        <section className="rounded border border-[var(--border)] bg-white">
          <div className="border-b border-[var(--border)] px-4 py-3">
            <div className="text-sm font-medium">命令聚合</div>
            <div className="mt-1 break-all text-xs text-[var(--muted)]">
              {selectedCwd || "从左侧选择一个目录"}
            </div>
          </div>
          {selectedCwd ? (
            <div>
              {selectedFromTop ? (
                <div className="grid grid-cols-4 gap-3 border-b border-[var(--border)] px-4 py-3 text-sm">
                  <Metric label="count" value={String(modeCount(selectedFromTop, mode))} />
                  <Metric
                    label="failed"
                    value={`${modeFailed(selectedFromTop, mode)} (${failureRate(
                      modeFailed(selectedFromTop, mode),
                      modeCount(selectedFromTop, mode)
                    )})`}
                  />
                  <Metric label="last" value={formatNs(selectedFromTop.last_timestamp_ns)} />
                  <Metric label="exit" value={String(selectedFromTop.last_exit ?? "-")} />
                </div>
              ) : null}
              <div className="max-h-[42rem] overflow-auto">
                <table className="w-full table-fixed text-sm">
                  <thead className="sticky top-0 bg-neutral-50 text-left text-xs text-[var(--muted)]">
                    <tr>
                      <th className="w-[52%] px-4 py-2 font-medium">command</th>
                      <th className="w-[12%] px-3 py-2 font-medium">count</th>
                      <th className="w-[12%] px-3 py-2 font-medium">failed</th>
                      <th className="w-[16%] px-3 py-2 font-medium">last</th>
                      <th className="w-[8%] px-3 py-2 font-medium">exit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(commandsQ.data?.commands ?? []).map((row) => {
                      const total = commandCount(row, mode);
                      const failed = commandFailed(row, mode);
                      return (
                        <tr key={row.command} className="border-t border-[var(--border)]">
                          <td className="break-words px-4 py-3 font-mono text-xs">
                            {row.command}
                          </td>
                          <td className="px-3 py-3 font-mono">{total}</td>
                          <td className="px-3 py-3 font-mono">
                            {failed} ({failureRate(failed, total)})
                          </td>
                          <td className="px-3 py-3 text-xs">{formatNs(row.last_timestamp_ns)}</td>
                          <td className="px-3 py-3 font-mono">{row.last_exit ?? "-"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="px-4 py-12 text-sm text-[var(--muted)]">
              选择目录后显示该目录下的命令聚合。
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className="mt-1 truncate font-mono text-sm" title={value}>
        {value}
      </div>
    </div>
  );
}

function DirectoryTable({
  rows,
  mode,
  selectedCwd,
  onSelect,
}: {
  rows: DirectoryRow[];
  mode: Mode;
  selectedCwd: string;
  onSelect: (cwd: string) => void;
}) {
  if (rows.length === 0) {
    return <div className="px-4 py-8 text-sm text-[var(--muted)]">暂无目录数据。</div>;
  }
  return (
    <div className="max-h-[32rem] overflow-auto">
      <table className="w-full table-fixed text-sm">
        <thead className="sticky top-0 bg-neutral-50 text-left text-xs text-[var(--muted)]">
          <tr>
            <th className="w-[62%] px-4 py-2 font-medium">cwd</th>
            <th className="w-[14%] px-3 py-2 font-medium">count</th>
            <th className="w-[14%] px-3 py-2 font-medium">failed</th>
            <th className="w-[10%] px-3 py-2 font-medium">exit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const total = modeCount(row, mode);
            const failed = modeFailed(row, mode);
            return (
              <tr
                key={row.cwd}
                className={
                  "cursor-pointer border-t border-[var(--border)] hover:bg-blue-50 " +
                  (selectedCwd === row.cwd ? "bg-blue-50" : "")
                }
                onClick={() => onSelect(row.cwd)}
              >
                <td className="break-all px-4 py-3 text-xs" title={row.cwd}>
                  {row.cwd}
                </td>
                <td className="px-3 py-3 font-mono">{total}</td>
                <td className="px-3 py-3 font-mono">
                  {failed} ({failureRate(failed, total)})
                </td>
                <td className="px-3 py-3 font-mono">{row.last_exit ?? "-"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
