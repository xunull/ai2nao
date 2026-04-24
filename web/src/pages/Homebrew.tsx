import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useState } from "react";
import { apiGet, apiPost } from "../api";

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

type BrewStatus = {
  detected: boolean;
  brewPath: string | null;
  counts: { total: number; formulae: number; casks: number; missing: number };
  lastRun: SyncRun | null;
};

type BrewKind = "" | "formula" | "cask";

type BrewRow = {
  id: number;
  kind: "formula" | "cask";
  name: string;
  full_name: string | null;
  installed_version: string | null;
  current_version: string | null;
  desc: string | null;
  tap: string | null;
  installed_as_dependency: number | null;
  installed_on_request: number | null;
  missing_since: string | null;
};

type BrewRes = {
  rows: BrewRow[];
  total: number;
  limit: number;
  offset: number;
};

const PAGE_SIZE = 50;

export function Homebrew() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");
  const [kind, setKind] = useState<BrewKind>("");
  const [includeMissing, setIncludeMissing] = useState(false);
  const [offset, setOffset] = useState(0);

  const statusQ = useQuery({
    queryKey: ["brew-status"],
    queryFn: () => apiGet<BrewStatus>("/api/brew/status"),
  });
  const listQ = useQuery({
    queryKey: ["brew-list", submittedQ, kind, includeMissing, offset],
    queryFn: () =>
      apiGet<BrewRes>(
        `/api/brew/packages?limit=${PAGE_SIZE}&offset=${offset}&includeMissing=${
          includeMissing ? "1" : "0"
        }${kind ? `&kind=${kind}` : ""}${submittedQ ? `&q=${encodeURIComponent(submittedQ)}` : ""}`
      ),
  });
  const syncM = useMutation({
    mutationFn: () => apiPost("/api/brew/sync", {}),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["brew-status"] });
      await queryClient.invalidateQueries({ queryKey: ["brew-list"] });
    },
  });

  function onSearch(e: FormEvent) {
    e.preventDefault();
    setOffset(0);
    setSubmittedQ(q.trim());
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Homebrew</h1>
        <p className="text-sm text-[var(--muted)] mt-1">
          同步本机 Homebrew formula 与 cask。ai2nao 只做本地清单回看，不替代 Brewfile。
        </p>
      </header>

      <StatusPanel status={statusQ.data} isLoading={statusQ.isLoading} error={statusQ.error} />

      <div className="flex flex-wrap gap-3 items-center">
        <button
          type="button"
          onClick={() => syncM.mutate()}
          disabled={syncM.isPending || statusQ.data?.detected === false}
          className="rounded bg-[var(--accent)] text-white px-4 py-2 text-sm disabled:opacity-50"
        >
          {syncM.isPending ? "同步中…" : "立即同步"}
        </button>
        {syncM.isError ? (
          <span className="text-sm text-red-700">
            {String((syncM.error as Error).message)}
          </span>
        ) : null}
      </div>

      <form onSubmit={onSearch} className="flex flex-wrap gap-2 items-center">
        <input
          className="rounded border border-[var(--border)] px-3 py-2 text-sm min-w-[16rem]"
          placeholder="搜索名称、描述或 tap"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="rounded border border-[var(--border)] px-3 py-2 text-sm"
          value={kind}
          onChange={(e) => {
            setOffset(0);
            setKind(e.target.value as BrewKind);
          }}
        >
          <option value="">全部</option>
          <option value="formula">Formula</option>
          <option value="cask">Cask</option>
        </select>
        <button className="rounded border border-[var(--border)] px-3 py-2 text-sm">
          搜索
        </button>
        <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
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

      <PackageList
        res={listQ.data}
        isLoading={listQ.isLoading}
        error={listQ.error}
        offset={offset}
        setOffset={setOffset}
      />
    </div>
  );
}

function StatusPanel({
  status,
  isLoading,
  error,
}: {
  status: BrewStatus | undefined;
  isLoading: boolean;
  error: unknown;
}) {
  if (isLoading) return <p className="text-sm text-[var(--muted)]">加载状态…</p>;
  if (error) return <p className="text-sm text-red-700">{String((error as Error).message)}</p>;
  if (!status) return null;
  return (
    <div className="rounded border border-[var(--border)] bg-white p-4 text-sm space-y-2">
      <div>
        Formula {status.counts.formulae} · Cask {status.counts.casks}
        {status.counts.missing ? ` · 已移除 ${status.counts.missing}` : ""}
      </div>
      {status.detected ? (
        <div className="text-[var(--muted)] break-all">brew：{status.brewPath}</div>
      ) : (
        <div className="text-amber-700">未检测到 Homebrew。CLI 可用 --brew 指定路径。</div>
      )}
      <RunSummary run={status.lastRun} />
    </div>
  );
}

function RunSummary({ run }: { run: SyncRun | null }) {
  if (!run) return <div className="text-[var(--muted)]">尚未同步。</div>;
  const color =
    run.status === "failed"
      ? "text-red-700"
      : run.status === "partial"
        ? "text-amber-700"
        : "text-[var(--muted)]";
  return (
    <div className={color}>
      最近同步：{run.status} · 新增 {run.inserted} · 更新 {run.updated} · 标记移除{" "}
      {run.marked_missing} · warning {run.warnings_count}
      {run.error_summary ? <div className="mt-1 whitespace-pre-wrap">{run.error_summary}</div> : null}
    </div>
  );
}

function PackageList({
  res,
  isLoading,
  error,
  offset,
  setOffset,
}: {
  res: BrewRes | undefined;
  isLoading: boolean;
  error: unknown;
  offset: number;
  setOffset: (n: number) => void;
}) {
  if (isLoading) return <p className="text-sm text-[var(--muted)]">加载列表…</p>;
  if (error) return <p className="text-sm text-red-700">{String((error as Error).message)}</p>;
  const rows = res?.rows ?? [];
  return (
    <div className="space-y-3">
      <div className="text-sm text-[var(--muted)]">共 {res?.total ?? 0} 条</div>
      <div className="rounded border border-[var(--border)] bg-white divide-y divide-[var(--border)]">
        {rows.length === 0 ? (
          <div className="p-4 text-sm text-[var(--muted)]">暂无记录。</div>
        ) : (
          rows.map((pkg) => (
            <div key={pkg.id} className="p-3 text-sm">
              <div className="flex flex-wrap gap-2 items-baseline">
                <strong>{pkg.name}</strong>
                <span className="text-xs rounded border border-[var(--border)] px-1">
                  {pkg.kind}
                </span>
                <span className="text-[var(--muted)]">
                  {pkg.installed_version ?? ""}
                </span>
                {pkg.missing_since ? (
                  <span className="text-xs text-amber-700">已移除</span>
                ) : null}
              </div>
              {pkg.desc ? (
                <div className="text-sm mt-1">{pkg.desc}</div>
              ) : null}
              <div className="text-xs text-[var(--muted)] break-all mt-1">
                {pkg.tap ?? "无 tap"} · {pkg.full_name ?? pkg.name}
              </div>
            </div>
          ))
        )}
      </div>
      <Pager total={res?.total ?? 0} offset={offset} setOffset={setOffset} />
    </div>
  );
}

function Pager({
  total,
  offset,
  setOffset,
}: {
  total: number;
  offset: number;
  setOffset: (n: number) => void;
}) {
  return (
    <div className="flex gap-2">
      <button
        type="button"
        className="rounded border border-[var(--border)] px-3 py-1 text-sm disabled:opacity-50"
        disabled={offset <= 0}
        onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
      >
        上一页
      </button>
      <button
        type="button"
        className="rounded border border-[var(--border)] px-3 py-1 text-sm disabled:opacity-50"
        disabled={offset + PAGE_SIZE >= total}
        onClick={() => setOffset(offset + PAGE_SIZE)}
      >
        下一页
      </button>
    </div>
  );
}
