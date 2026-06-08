import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { apiGet, apiPatch, apiPost } from "../api";

type RunStatus = "running" | "success" | "partial" | "failed" | "skipped";
type Trigger = "manual" | "scheduled" | "cli";

type TaskRun = {
  id: number;
  taskKey: string;
  trigger: Trigger;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  summary: Record<string, unknown>;
  errorSummary: string | null;
  leaseOwner: string | null;
};

type Task = {
  key: string;
  label: string;
  description: string;
  category: string;
  defaultIntervalSeconds: number;
  sensitivity: "low" | "medium" | "high";
  enabled: boolean;
  intervalSeconds: number | null;
  nextRunAt: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  config: Record<string, unknown>;
  lastRun: TaskRun | null;
  updatedAt: string;
};

type TasksRes = { tasks: Task[] };
type RunsRes = { runs: TaskRun[] };

const intervalOptions = [
  { label: "30 秒", value: 30 },
  { label: "5 分钟", value: 5 * 60 },
  { label: "1 小时", value: 60 * 60 },
  { label: "6 小时", value: 6 * 60 * 60 },
  { label: "每天", value: 24 * 60 * 60 },
];

const categoryLabel: Record<string, string> = {
  local_inventory: "本机清单",
  browser: "浏览器",
  editor: "编辑器",
  model_cache: "模型缓存",
  derived: "派生重建",
};

export function Scheduler() {
  const queryClient = useQueryClient();
  const tasksQ = useQuery({
    queryKey: ["scheduler-tasks"],
    queryFn: () => apiGet<TasksRes>("/api/scheduler/tasks"),
  });
  const runsQ = useQuery({
    queryKey: ["scheduler-runs"],
    queryFn: () => apiGet<RunsRes>("/api/scheduler/runs?limit=30"),
  });

  const patchM = useMutation({
    mutationFn: ({ key, patch }: { key: string; patch: Record<string, unknown> }) =>
      apiPatch(`/api/scheduler/tasks/${encodeURIComponent(key)}`, patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["scheduler-tasks"] });
    },
  });
  const runM = useMutation({
    mutationFn: (key: string) =>
      apiPost(`/api/scheduler/tasks/${encodeURIComponent(key)}/run`, {}),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["scheduler-tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["scheduler-runs"] });
    },
  });

  const tasks = tasksQ.data?.tasks ?? [];
  const enabledCount = tasks.filter((task) => task.enabled).length;
  const runningCount = tasks.filter((task) => task.leaseUntil && Date.parse(task.leaseUntil) > Date.now()).length;

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">定时任务</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            统一管理本机同步、扫描和派生重建任务。
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void queryClient.invalidateQueries({ queryKey: ["scheduler-tasks"] });
            void queryClient.invalidateQueries({ queryKey: ["scheduler-runs"] });
          }}
          className="inline-flex h-9 items-center gap-2 rounded border border-[var(--border)] px-3 text-sm"
        >
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
          刷新
        </button>
      </header>

      <div className="grid grid-cols-[160px_160px_minmax(0,1fr)] gap-px rounded border border-[var(--border)] bg-[var(--border)] text-sm">
        <Metric label="已注册" value={String(tasks.length)} />
        <Metric label="已启用" value={String(enabledCount)} />
        <Metric label="运行中" value={String(runningCount)} />
      </div>

      {tasksQ.error ? (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {String((tasksQ.error as Error).message)}
        </div>
      ) : null}
      {patchM.isError || runM.isError ? (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {String(((patchM.error ?? runM.error) as Error).message)}
        </div>
      ) : null}

      <div className="overflow-hidden rounded border border-[var(--border)] bg-white">
        <div className="grid grid-cols-[minmax(260px,1.25fr)_120px_110px_130px_170px_170px_110px_120px] gap-px bg-[var(--border)] text-sm">
          <HeaderCell>任务</HeaderCell>
          <HeaderCell>类别</HeaderCell>
          <HeaderCell>开关</HeaderCell>
          <HeaderCell>间隔</HeaderCell>
          <HeaderCell>下次运行</HeaderCell>
          <HeaderCell>最近运行</HeaderCell>
          <HeaderCell>状态</HeaderCell>
          <HeaderCell>操作</HeaderCell>
          {tasksQ.isLoading ? (
            <div className="col-span-8 bg-white px-4 py-6 text-sm text-[var(--muted)]">
              加载任务…
            </div>
          ) : (
            tasks.map((task) => (
              <TaskRow
                key={task.key}
                task={task}
                busy={patchM.isPending || runM.isPending}
                onToggle={(enabled) => patchM.mutate({ key: task.key, patch: { enabled } })}
                onInterval={(intervalSeconds) =>
                  patchM.mutate({ key: task.key, patch: { intervalSeconds } })
                }
                onRun={() => runM.mutate(task.key)}
              />
            ))
          )}
        </div>
      </div>

      <section className="rounded border border-[var(--border)] bg-white">
        <div className="border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-sm font-semibold">最近运行</h2>
        </div>
        <div className="divide-y divide-[var(--border)] text-sm">
          {runsQ.isLoading ? (
            <div className="px-4 py-4 text-[var(--muted)]">加载运行历史…</div>
          ) : runsQ.data?.runs.length ? (
            runsQ.data.runs.map((run) => (
              <div key={run.id} className="grid grid-cols-[220px_110px_120px_180px_180px_minmax(0,1fr)] gap-3 px-4 py-3">
                <div className="font-mono text-xs">{run.taskKey}</div>
                <StatusPill status={run.status} />
                <div className="text-[var(--muted)]">{run.trigger}</div>
                <div>{formatDate(run.startedAt)}</div>
                <div>{duration(run)}</div>
                <div className="truncate text-[var(--muted)]">{run.errorSummary ?? summaryText(run.summary)}</div>
              </div>
            ))
          ) : (
            <div className="px-4 py-4 text-[var(--muted)]">暂无运行记录</div>
          )}
        </div>
      </section>
    </div>
  );
}

function TaskRow({
  task,
  busy,
  onToggle,
  onInterval,
  onRun,
}: {
  task: Task;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onInterval: (intervalSeconds: number) => void;
  onRun: () => void;
}) {
  const interval = task.intervalSeconds ?? task.defaultIntervalSeconds;
  return (
    <>
      <div className="min-w-0 bg-white px-3 py-3">
        <div className="truncate font-medium">{task.label}</div>
        <div className="mt-1 truncate font-mono text-xs text-[var(--muted)]">{task.key}</div>
        <div className="mt-1 truncate text-xs text-[var(--muted)]">{task.description}</div>
      </div>
      <Cell>{categoryLabel[task.category] ?? task.category}</Cell>
      <Cell>
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={task.enabled}
            disabled={busy}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span>{task.enabled ? "启用" : "关闭"}</span>
        </label>
      </Cell>
      <Cell>
        <select
          className="h-8 w-full rounded border border-[var(--border)] bg-white px-2 text-sm"
          value={interval}
          disabled={busy}
          onChange={(e) => onInterval(parseInt(e.target.value, 10))}
        >
          {intervalOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Cell>
      <Cell>{task.enabled ? formatDate(task.nextRunAt) : "-"}</Cell>
      <Cell>{task.lastRun ? formatDate(task.lastRun.startedAt) : "-"}</Cell>
      <Cell>
        <StatusPill status={task.lastRun?.status ?? "skipped"} muted={!task.lastRun} />
      </Cell>
      <Cell>
        <button
          type="button"
          disabled={busy}
          onClick={onRun}
          className="inline-flex h-8 items-center gap-1.5 rounded bg-[var(--accent)] px-3 text-sm text-white disabled:opacity-50"
        >
          <Play aria-hidden="true" className="h-3.5 w-3.5" />
          Run
        </button>
      </Cell>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white px-4 py-3">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function HeaderCell({ children }: { children: string }) {
  return <div className="bg-neutral-50 px-3 py-2 text-xs font-semibold text-[var(--muted)]">{children}</div>;
}

function Cell({ children }: { children: ReactNode }) {
  return <div className="min-w-0 bg-white px-3 py-3">{children}</div>;
}

function StatusPill({ status, muted = false }: { status: RunStatus; muted?: boolean }) {
  const cls =
    status === "success"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : status === "partial" || status === "skipped"
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : status === "failed"
          ? "bg-red-50 text-red-700 border-red-200"
          : "bg-blue-50 text-blue-700 border-blue-200";
  return (
    <span className={`inline-flex rounded border px-2 py-1 text-xs ${muted ? "border-neutral-200 bg-neutral-50 text-[var(--muted)]" : cls}`}>
      {muted ? "never" : status}
    </span>
  );
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function duration(run: TaskRun): string {
  if (!run.finishedAt) return "-";
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function summaryText(summary: Record<string, unknown>): string {
  const keys = Object.keys(summary);
  if (keys.length === 0) return "";
  return keys
    .slice(0, 4)
    .map((key) => `${key}=${String(summary[key])}`)
    .join(" · ");
}
