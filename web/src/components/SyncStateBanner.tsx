import type { GhSyncState, GhTokenStatus } from "../types/github";

type Props = {
  token: GhTokenStatus;
  sync: GhSyncState;
  counts: { repos: number; stars: number };
};

/**
 * Top-of-page banner summarising token source + last sync outcome. Keeps the
 * user honest: if a sync silently failed 3 days ago, the error text shows up
 * here without them having to open the CLI output.
 */
export function SyncStateBanner({ token, sync, counts }: Props) {
  const hasError = sync.last_full_sync_error || sync.last_incremental_sync_error;
  return (
    <div className="rounded border border-[var(--border)] bg-white p-4 shadow-sm space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium">GitHub 镜像</span>
        {!token.configured ? (
          <span className="rounded bg-amber-50 text-amber-900 px-2 py-0.5 text-xs">
            未配置 token
          </span>
        ) : (
          <span className="rounded bg-emerald-50 text-emerald-900 px-2 py-0.5 text-xs">
            token: {token.source === "env" ? "GITHUB_TOKEN" : token.configPath}
          </span>
        )}
        <span className="text-[var(--muted)]">
          {counts.repos} 个自己的 repo · {counts.stars} 个 star
        </span>
        {sync.in_progress ? (
          <span className="rounded bg-sky-50 text-sky-900 px-2 py-0.5 text-xs">
            正在同步
          </span>
        ) : null}
      </div>
      <div className="text-xs text-[var(--muted)] flex flex-wrap gap-x-4 gap-y-1">
        <span>
          last full sync:{" "}
          {sync.last_full_sync_at ? (
            <>
              {new Date(sync.last_full_sync_at).toLocaleString()}
              {sync.last_full_sync_duration_ms
                ? ` (${sync.last_full_sync_duration_ms}ms)`
                : ""}
            </>
          ) : (
            <span>从未</span>
          )}
        </span>
        <span>
          last incremental:{" "}
          {sync.last_incremental_sync_at ? (
            <>
              {new Date(sync.last_incremental_sync_at).toLocaleString()}
              {sync.last_incremental_sync_duration_ms
                ? ` (${sync.last_incremental_sync_duration_ms}ms)`
                : ""}
            </>
          ) : (
            <span>从未</span>
          )}
        </span>
      </div>
      {hasError ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-red-700">
            上次同步有错误（展开）
          </summary>
          <pre className="whitespace-pre-wrap break-all bg-red-50 text-red-900 p-2 rounded mt-1">
            {sync.last_full_sync_error || sync.last_incremental_sync_error}
          </pre>
        </details>
      ) : null}
      {token.insecureFilePermissions ? (
        <p className="text-xs text-amber-800">
          ⚠️ token 文件权限过宽，建议执行{" "}
          <code className="bg-neutral-100 px-1 rounded">
            chmod 0600 {token.configPath}
          </code>
        </p>
      ) : null}
      {!token.configured ? (
        <p className="text-xs text-[var(--muted)]">
          首次使用：导出环境变量{" "}
          <code className="bg-neutral-100 px-1 rounded">
            export GITHUB_TOKEN=ghp_...
          </code>{" "}
          或创建{" "}
          <code className="bg-neutral-100 px-1 rounded">
            ~/.ai2nao/github.json
          </code>
          （字段{" "}
          <code className="bg-neutral-100 px-1 rounded">{"{\"token\":\"ghp_...\"}"}</code>
          ，chmod 0600），然后运行{" "}
          <code className="bg-neutral-100 px-1 rounded">
            ai2nao github sync --full
          </code>
          。
        </p>
      ) : null}
    </div>
  );
}
