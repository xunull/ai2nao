import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { apiGet, apiPatch, apiPost } from "../api";
import { Page } from "../components/Page";

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

/** Display order for category groups; unknown categories sort to the end. */
const categoryOrder = ["local_inventory", "browser", "editor", "model_cache", "derived"];

function groupByCategory(tasks: Task[]): { category: string; tasks: Task[] }[] {
  const map = new Map<string, Task[]>();
  for (const task of tasks) {
    const list = map.get(task.category) ?? [];
    list.push(task);
    map.set(task.category, list);
  }
  return [...map.keys()]
    .sort((a, b) => {
      const ia = categoryOrder.indexOf(a);
      const ib = categoryOrder.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    })
    .map((category) => ({ category, tasks: map.get(category)! }));
}

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
  const runningCount = tasks.filter(
    (task) => task.leaseUntil && Date.parse(task.leaseUntil) > Date.now()
  ).length;
  const groups = groupByCategory(tasks);
  const busy = patchM.isPending || runM.isPending;
  const [tab, setTab] = useState<"tasks" | "runs">("tasks");

  return (
    <Page
      title="定时任务"
      subtitle="统一管理本机同步、扫描和派生重建任务。"
      actions={
        <button
          type="button"
          onClick={() => {
            void queryClient.invalidateQueries({ queryKey: ["scheduler-tasks"] });
            void queryClient.invalidateQueries({ queryKey: ["scheduler-runs"] });
          }}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-white px-3 text-sm text-[var(--fg)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
          刷新
        </button>
      }
      toolbar={
        <>
          <div className="flex gap-3 pb-3">
            <Metric label="已注册" value={String(tasks.length)} />
            <Metric label="已启用" value={String(enabledCount)} />
            <Metric label="运行中" value={String(runningCount)} />
          </div>
          <div className="flex gap-1">
            <TabButton active={tab === "tasks"} onClick={() => setTab("tasks")}>
              任务
            </TabButton>
            <TabButton active={tab === "runs"} onClick={() => setTab("runs")}>
              最近运行
            </TabButton>
          </div>
        </>
      }
    >
      <div className="space-y-4">
      {tasksQ.error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {String((tasksQ.error as Error).message)}
        </div>
      ) : null}
      {patchM.isError || runM.isError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {String(((patchM.error ?? runM.error) as Error).message)}
        </div>
      ) : null}

      {tab === "tasks" ? (
        tasksQ.isLoading ? (
          <p className="text-sm text-[var(--muted)]">加载任务…</p>
        ) : (
          <div className="space-y-5">
            {groups.map((group) => {
              const on = group.tasks.filter((t) => t.enabled).length;
              return (
                <section key={group.category}>
                  <div className="flex items-center justify-between px-1 pb-1.5">
                    <h2 className="text-xs font-semibold tracking-wide text-[var(--muted)]">
                      {categoryLabel[group.category] ?? group.category}
                    </h2>
                    <span className="text-xs text-[var(--muted)]">
                      {group.tasks.length} 个 · {on} 启用
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {group.tasks.map((task) => (
                      <TaskRow
                        key={task.key}
                        task={task}
                        busy={busy}
                        onToggle={(enabled) => patchM.mutate({ key: task.key, patch: { enabled } })}
                        onInterval={(intervalSeconds) =>
                          patchM.mutate({ key: task.key, patch: { intervalSeconds } })
                        }
                        onRun={() => runM.mutate(task.key)}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )
      ) : (
        <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-white">
          <div className="divide-y divide-[var(--border)] text-sm">
            {runsQ.isLoading ? (
              <div className="px-4 py-4 text-[var(--muted)]">加载运行历史…</div>
            ) : runsQ.data?.runs.length ? (
              runsQ.data.runs.map((run) => (
                <div
                  key={run.id}
                  className="grid grid-cols-[minmax(0,1.2fr)_90px_90px_160px_70px_minmax(0,1.4fr)] items-center gap-3 px-4 py-2.5"
                >
                  <div className="truncate font-mono text-xs">{run.taskKey}</div>
                  <StatusPill status={run.status} />
                  <div className="text-xs text-[var(--muted)]">{run.trigger}</div>
                  <div className="text-xs">{formatDate(run.startedAt)}</div>
                  <div className="text-xs tabular-nums">{duration(run)}</div>
                  <div className="truncate text-xs text-[var(--muted)]">
                    {run.errorSummary ?? summaryText(run.summary)}
                  </div>
                </div>
              ))
            ) : (
              <div className="px-4 py-4 text-[var(--muted)]">暂无运行记录</div>
            )}
          </div>
        </div>
      )}
      </div>
    </Page>
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
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-[var(--border)] bg-white px-3 py-2.5 transition-colors hover:border-[var(--accent)]">
      {/* identity */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-[var(--fg)]">{task.label}</span>
          <span className="shrink-0 font-mono text-[10px] text-[var(--muted)]">{task.key}</span>
        </div>
        <div className="truncate text-xs text-[var(--muted)]">{task.description}</div>
      </div>

      {/* schedule + controls */}
      <div className="flex items-center gap-3 justify-self-end">
        <div className="hidden items-center gap-2 sm:flex">
          <select
            className="h-8 rounded-lg border border-[var(--border)] bg-white px-2 text-xs text-[var(--fg)] outline-none focus:border-[var(--accent)] disabled:opacity-50"
            value={interval}
            disabled={busy}
            onChange={(e) => onInterval(parseInt(e.target.value, 10))}
            aria-label="运行间隔"
          >
            {intervalOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="w-28 shrink-0 text-right text-xs text-[var(--muted)]">
            {task.enabled ? `下次 ${shortTime(task.nextRunAt)}` : "关闭"}
          </span>
        </div>
        <Toggle checked={task.enabled} disabled={busy} onChange={onToggle} />
        <StatusPill status={task.lastRun?.status ?? "skipped"} muted={!task.lastRun} />
        <button
          type="button"
          disabled={busy}
          onClick={onRun}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Play aria-hidden="true" className="h-3.5 w-3.5" />
          运行
        </button>
      </div>
    </div>
  );
}

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={checked ? "已启用" : "已关闭"}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50 ${
        checked ? "bg-[var(--accent)]" : "bg-stone-300"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all ${
          checked ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? "border-[var(--accent)] text-[var(--fg)]"
          : "border-transparent text-[var(--muted)] hover:text-[var(--fg)]"
      }`}
    >
      {children}
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex-1 rounded-lg border border-[var(--border)] bg-white px-4 py-3">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
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
    <span
      className={`inline-flex w-[72px] items-center justify-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${
        muted ? "border-[var(--border)] bg-[var(--bg)] text-[var(--muted)]" : cls
      }`}
    >
      {!muted ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" /> : null}
      {muted ? "never" : status}
    </span>
  );
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

/** Short HH:MM for the inline next-run hint. */
function shortTime(value: string | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
