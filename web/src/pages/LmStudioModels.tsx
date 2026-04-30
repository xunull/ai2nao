import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useState } from "react";
import { apiGet, apiPost } from "../api";
import { formatByteSize } from "../util/formatDisplay";

type SyncRun = {
  id: number;
  status: "running" | "success" | "partial" | "failed";
  started_at: string;
  finished_at: string | null;
  inserted: number;
  updated: number;
  marked_missing: number;
  warnings_count: number;
  error_summary: string | null;
};

type RootWarning = { code: string; message: string; path?: string };
type AlternativeRoot = { source: string; modelsRoot: string; settingsPath: string };

type LmStatus = {
  modelsRoot: string;
  rootSource: string;
  settingsPath: string | null;
  alternativeRoots: AlternativeRoot[];
  warnings: RootWarning[];
  counts: {
    total: number;
    active: number;
    missing: number;
    totalSizeBytes: number;
    largestSizeBytes: number;
    largestModel: string | null;
  };
  lastRun: SyncRun | null;
};

type LmModel = {
  id: number;
  model_key: string;
  models_root: string;
  format: string;
  weight_file_count: number;
  auxiliary_file_count: number;
  total_file_count: number;
  total_size_bytes: number;
  weight_size_bytes: number;
  primary_file: string | null;
  warnings_json: string;
  last_modified_ms: number | null;
  missing_since: string | null;
  files: {
    rel_path: string;
    file_kind: "weight" | "auxiliary";
    format: string;
    size_bytes: number;
    is_symlink: number;
    warnings: unknown[];
  }[];
};

type ModelsRes = {
  rows: LmModel[];
  total: number;
  limit: number;
  offset: number;
};

type SyncRes = {
  ok: boolean;
  status: "success" | "partial" | "failed";
  modelsRoot: string;
  warnings: { message: string }[];
};

const PAGE_SIZE = 50;
const FORMATS = ["", "gguf", "mlx_safetensors", "safetensors", "mixed", "unknown"];

export function LmStudioModels() {
  const queryClient = useQueryClient();
  const [root, setRoot] = useState("");
  const [submittedRoot, setSubmittedRoot] = useState("");
  const [q, setQ] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");
  const [format, setFormat] = useState("");
  const [submittedFormat, setSubmittedFormat] = useState("");
  const [includeMissing, setIncludeMissing] = useState(false);
  const [offset, setOffset] = useState(0);

  const rootParam = submittedRoot ? `root=${encodeURIComponent(submittedRoot)}` : "";
  const statusQ = useQuery({
    queryKey: ["lmstudio-status", submittedRoot],
    queryFn: () => apiGet<LmStatus>(`/api/lmstudio/status${rootParam ? `?${rootParam}` : ""}`),
  });
  const listQ = useQuery({
    queryKey: ["lmstudio-models", submittedRoot, submittedQ, submittedFormat, includeMissing, offset],
    queryFn: () => {
      const qs = new URLSearchParams();
      qs.set("limit", String(PAGE_SIZE));
      qs.set("offset", String(offset));
      qs.set("includeMissing", includeMissing ? "1" : "0");
      if (submittedRoot) qs.set("root", submittedRoot);
      if (submittedQ) qs.set("q", submittedQ);
      if (submittedFormat) qs.set("format", submittedFormat);
      return apiGet<ModelsRes>(`/api/lmstudio/models?${qs.toString()}`);
    },
  });
  const syncM = useMutation({
    mutationFn: () => apiPost<SyncRes>("/api/lmstudio/sync", submittedRoot ? { root: submittedRoot } : {}),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["lmstudio-status"] });
      await queryClient.invalidateQueries({ queryKey: ["lmstudio-models"] });
    },
  });

  function onSearch(e: FormEvent) {
    e.preventDefault();
    setOffset(0);
    setSubmittedQ(q.trim());
    setSubmittedRoot(root.trim());
    setSubmittedFormat(format);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">LM Studio 模型</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          读取 LM Studio settings 的下载目录，扫描本机模型文件，只记录元数据、大小和 warning。
        </p>
      </header>

      <StatusPanel status={statusQ.data} isLoading={statusQ.isLoading} error={statusQ.error} />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => syncM.mutate()}
          disabled={syncM.isPending}
          className="rounded bg-[var(--accent)] px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {syncM.isPending ? "同步中…" : "立即同步"}
        </button>
        {syncM.isError ? (
          <span className="text-sm text-red-700">{String((syncM.error as Error).message)}</span>
        ) : syncM.data?.status === "partial" ? (
          <span className="text-sm text-amber-700">
            同步部分完成，{syncM.data.warnings.length} 个 warning。
          </span>
        ) : null}
      </div>

      <form onSubmit={onSearch} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          models root
          <input
            className="min-h-10 min-w-[18rem] rounded border border-[var(--border)] px-3 py-2 text-sm text-[var(--fg)]"
            placeholder="默认读取 LM Studio settings 或 ~/.lmstudio/models"
            value={root}
            onChange={(e) => setRoot(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          模型
          <input
            className="min-h-10 min-w-[14rem] rounded border border-[var(--border)] px-3 py-2 text-sm text-[var(--fg)]"
            placeholder="搜索 publisher/model"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          format
          <select
            className="min-h-10 rounded border border-[var(--border)] px-3 py-2 text-sm text-[var(--fg)]"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            {FORMATS.map((f) => (
              <option key={f || "all"} value={f}>
                {f || "全部"}
              </option>
            ))}
          </select>
        </label>
        <button className="min-h-10 rounded border border-[var(--border)] px-3 py-2 text-sm">
          筛选
        </button>
        <label className="flex min-h-10 items-center gap-2 text-sm text-[var(--muted)]">
          <input
            type="checkbox"
            checked={includeMissing}
            onChange={(e) => {
              setOffset(0);
              setIncludeMissing(e.target.checked);
            }}
          />
          显示已移除
        </label>
      </form>

      <ModelList res={listQ.data} isLoading={listQ.isLoading} error={listQ.error} offset={offset} setOffset={setOffset} />
    </div>
  );
}

function StatusPanel({ status, isLoading, error }: { status: LmStatus | undefined; isLoading: boolean; error: unknown }) {
  if (isLoading) return <p className="text-sm text-[var(--muted)]">加载状态…</p>;
  if (error) return <p className="text-sm text-red-700">{String((error as Error).message)}</p>;
  if (!status) return null;
  return (
    <div className="space-y-2 rounded border border-[var(--border)] bg-white p-4 text-sm">
      <div>
        已记录 {status.counts.active} 个模型 · 总大小 {formatByteSize(status.counts.totalSizeBytes)}
        {status.counts.missing ? ` · 已移除 ${status.counts.missing}` : ""}
      </div>
      <div className="break-all text-[var(--muted)]">
        models root：{status.modelsRoot} · {status.rootSource}
      </div>
      {status.settingsPath ? <div className="break-all text-[var(--muted)]">settings：{status.settingsPath}</div> : null}
      {status.alternativeRoots.length ? (
        <div className="break-all text-amber-700">
          其他 settings 指向：{status.alternativeRoots.map((r) => `${r.source} ${r.modelsRoot}`).join(" · ")}
        </div>
      ) : null}
      {status.warnings.length ? (
        <div className="whitespace-pre-wrap text-amber-700">{status.warnings.map((w) => w.message).join("\n")}</div>
      ) : null}
      {status.counts.largestModel ? (
        <div className="text-[var(--muted)]">
          最大模型：{status.counts.largestModel} · {formatByteSize(status.counts.largestSizeBytes)}
        </div>
      ) : null}
      <RunSummary run={status.lastRun} />
    </div>
  );
}

function RunSummary({ run }: { run: SyncRun | null }) {
  if (!run) return <div className="text-[var(--muted)]">尚未同步。</div>;
  const color = run.status === "failed" ? "text-red-700" : run.status === "partial" ? "text-amber-700" : "text-[var(--muted)]";
  return (
    <div className={color}>
      最近同步：{run.status} · 新增 {run.inserted} · 更新 {run.updated} · 标记移除 {run.marked_missing} · warning {run.warnings_count}
      {run.error_summary ? <div className="mt-1 whitespace-pre-wrap">{run.error_summary}</div> : null}
    </div>
  );
}

function ModelList({ res, isLoading, error, offset, setOffset }: { res: ModelsRes | undefined; isLoading: boolean; error: unknown; offset: number; setOffset: (n: number) => void }) {
  if (isLoading) return <p className="text-sm text-[var(--muted)]">加载列表…</p>;
  if (error) return <p className="text-sm text-red-700">{String((error as Error).message)}</p>;
  const rows = res?.rows ?? [];
  return (
    <div className="space-y-3">
      <div className="text-sm text-[var(--muted)]">共 {res?.total ?? 0} 条</div>
      <div className="divide-y divide-[var(--border)] rounded border border-[var(--border)] bg-white">
        {rows.length === 0 ? (
          <div className="p-4 text-sm text-[var(--muted)]">暂无模型记录。运行同步后再查看。</div>
        ) : (
          rows.map((model) => <ModelItem key={model.id} model={model} />)
        )}
      </div>
      <Pager total={res?.total ?? 0} offset={offset} setOffset={setOffset} />
    </div>
  );
}

function ModelItem({ model }: { model: LmModel }) {
  const warnings = safeJsonArray(model.warnings_json);
  const topFiles = model.files.slice(0, 5);
  return (
    <div className="p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <strong className="font-mono">{model.model_key}</strong>
        <span className="rounded border border-[var(--border)] px-2 py-0.5 font-mono text-xs text-[var(--muted)]">{model.format}</span>
        <span className="text-[var(--muted)]">{formatByteSize(model.total_size_bytes)}</span>
        <span className="text-xs text-[var(--muted)]">
          weights {model.weight_file_count} · aux {model.auxiliary_file_count} · files {model.total_file_count}
        </span>
        {model.missing_since ? <span className="text-xs text-amber-700">已移除</span> : null}
        {warnings.length ? <span className="text-xs text-amber-700">warning {warnings.length}</span> : null}
      </div>
      <div className="mt-1 break-all text-xs text-[var(--muted)]">
        primary：{model.primary_file ?? "—"} · weights {formatByteSize(model.weight_size_bytes)}
        {model.last_modified_ms ? ` · ${formatDate(model.last_modified_ms)}` : ""}
      </div>
      {topFiles.length ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {topFiles.map((f) => (
            <span key={f.rel_path} className="rounded border border-[var(--border)] px-2 py-1 font-mono text-xs text-[var(--muted)]">
              {f.rel_path} · {formatByteSize(f.size_bytes)}
              {f.is_symlink ? " · link" : ""}
            </span>
          ))}
        </div>
      ) : null}
      {warnings.length ? (
        <div className="mt-2 whitespace-pre-wrap text-xs text-amber-700">{warnings.map((w) => warningMessage(w)).join("\n")}</div>
      ) : null}
    </div>
  );
}

function Pager({ total, offset, setOffset }: { total: number; offset: number; setOffset: (n: number) => void }) {
  return (
    <div className="flex gap-2">
      <button type="button" className="rounded border border-[var(--border)] px-3 py-1 text-sm disabled:opacity-50" disabled={offset <= 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
        上一页
      </button>
      <button type="button" className="rounded border border-[var(--border)] px-3 py-1 text-sm disabled:opacity-50" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
        下一页
      </button>
    </div>
  );
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function safeJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function warningMessage(w: unknown): string {
  if (w && typeof w === "object" && "message" in w) return String((w as { message: unknown }).message);
  return String(w);
}
