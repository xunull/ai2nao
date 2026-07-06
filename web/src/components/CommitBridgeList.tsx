import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { apiGet } from "../api";

// 三源品牌色,与全 app 一致(AgentMessages / AiRhythm)。导出供「那天回放」复用。
export const SOURCE_COLORS: Record<string, string> = {
  claude: "#d97757",
  codex: "#2563eb",
  opencode: "#7c3aed",
};

export type Coverage = {
  totalCommits: number;
  commitsInReposWithConversation: number;
  pctReposWithConversation: number;
};

type CommitItem = {
  repoKey: string;
  commitHash: string;
  authorDateUtc: string;
  committerDateUtc: string | null;
  subject: string | null;
  added: number;
  deleted: number;
  filesChanged: number;
  projectKey: string | null;
  matchedCount: number;
};
type CommitCursor = { authorDateUtc: string; commitHash: string };
type CommitsResp = {
  ok: true;
  items: CommitItem[];
  nextBefore: CommitCursor | null;
  coverage: Coverage;
};

type ConvMessage = {
  id: number;
  source: string;
  eventAtUtc: string;
  cleanedText: string;
};
type CommitConvResp = {
  ok: true;
  commit: Omit<CommitItem, "matchedCount">;
  windowFromUtc: string;
  messages: ConvMessage[];
};

/** 本地时间(zh-CN,24h)。commit author 时刻用它。 */
function fmtLocal(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}
/** 只留时分秒(对话消息行,不重复日期)。 */
function fmtTimeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
}
/** 前端兜底友好名:去前导 `-` 取最后一个 `-` 段(与后端 friendlyRepoName 同口径)。 */
export function friendlyRepoName(projectKey: string | null): string {
  if (!projectKey) return "(未知仓库)";
  const trimmed = projectKey.replace(/^-+/, "");
  const seg = trimmed.split("-").pop() ?? trimmed;
  return seg || projectKey;
}

/** 展开后:拉 /commit 的窗口对话并渲染。空窗口给诚实提示。 */
function ConversationPanel({ repo, hash }: { repo: string; hash: string }) {
  const q = useQuery<CommitConvResp>({
    queryKey: ["commit-bridge-conv", repo, hash],
    queryFn: () =>
      apiGet<CommitConvResp>(
        `/api/commit-bridge/commit?repo=${encodeURIComponent(repo)}&hash=${encodeURIComponent(hash)}`
      ),
  });

  if (q.isLoading) {
    return <div className="mt-2 pl-4 text-xs text-[var(--fg-muted)]">加载对话…</div>;
  }
  if (q.isError) {
    return (
      <div className="mt-2 pl-4 text-xs text-rose-600">
        对话读取失败：{(q.error as Error).message}
      </div>
    );
  }
  const { windowFromUtc, messages } = q.data!;
  if (messages.length === 0) {
    return (
      <div className="mt-2 rounded-md border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-3 py-3 text-xs text-[var(--fg-muted)]">
        这个 commit 没找到对应对话：可能手改、别的机器、或窗口内无对话。
      </div>
    );
  }
  return (
    <div className="mt-2 border-l-2 border-[var(--border)] pl-3">
      <div className="mb-1.5 text-[10px] text-[var(--fg-muted)]">
        窗口:{fmtLocal(windowFromUtc)} → 提交时刻 · 共 {messages.length} 条(启发式,非因果)
      </div>
      <div>
        {messages.map((m) => (
          <div
            key={m.id}
            className="flex gap-2.5 border-b border-[var(--border)] py-2 last:border-b-0"
          >
            <span
              className="mt-[6px] h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: SOURCE_COLORS[m.source] ?? "var(--fg-muted)" }}
              title={m.source}
            />
            <div className="min-w-0 flex-1">
              <div className="whitespace-pre-wrap break-words text-sm text-[var(--fg)]">
                {m.cleanedText}
              </div>
              <div className="mt-0.5 text-[11px] tabular-nums text-[var(--fg-muted)]">
                {fmtTimeOnly(m.eventAtUtc)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 一行 commit:主题 · 变更行数 · 本地时刻 · 仓库短名 · matched 徽标。点击展开窗口对话。 */
function CommitRow({
  item,
  showRepo,
  open,
  onToggle,
}: {
  item: CommitItem;
  showRepo: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const matched = item.matchedCount > 0;
  return (
    <div className="border-b border-[var(--border)] last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-[var(--surface-2)]"
      >
        <span className="min-w-0 flex-1 truncate text-sm text-[var(--fg)]" title={item.subject ?? ""}>
          {item.subject || "(无主题)"}
        </span>
        <span
          className="shrink-0 tabular-nums text-xs text-[var(--fg-muted)]"
          title={`${item.filesChanged} 个文件`}
        >
          <span className="text-emerald-600">+{item.added}</span>{" "}
          <span className="text-rose-600">-{item.deleted}</span>
        </span>
        <span
          className="w-40 shrink-0 truncate text-right text-xs tabular-nums text-[var(--fg-muted)]"
          title={item.authorDateUtc}
        >
          {fmtLocal(item.authorDateUtc)}
        </span>
        {showRepo && (
          <span
            className="w-28 shrink-0 truncate text-right text-xs text-[var(--fg-muted)]"
            title={item.projectKey ?? ""}
          >
            {friendlyRepoName(item.projectKey)}
          </span>
        )}
        <span
          className={`w-20 shrink-0 rounded-full px-2 py-0.5 text-center text-[11px] ${
            matched
              ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
              : "bg-[var(--surface-2)] text-[var(--fg-muted)] ring-1 ring-[var(--border)]"
          }`}
        >
          {matched ? `${item.matchedCount} 条对话` : "无"}
        </span>
      </button>
      {open && (
        <div className="pb-3">
          <ConversationPanel repo={item.projectKey ?? ""} hash={item.commitHash} />
        </div>
      )}
    </div>
  );
}

/**
 * 复用的 commit↔对话列表(keyset 分页 + 点开展开)。
 *   repo="" → 全部仓库(显示仓库列);repo=<project_key> → 单仓库(隐仓库列)。
 * CommitBridge 页(带筛选/覆盖率)和 RepoDetail 页(按本仓库 project_key)都用它。
 * onCoverage:每次首页加载回传当前筛选下的覆盖率,供上层显示。
 */
export function CommitBridgeList({
  repo,
  onCoverage,
}: {
  repo: string;
  onCoverage?: (c: Coverage) => void;
}) {
  const [openHash, setOpenHash] = useState<string | null>(null);

  const commitsQ = useInfiniteQuery<CommitsResp>({
    queryKey: ["commit-bridge-commits", repo],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams();
      if (repo) p.set("repo", repo);
      const cur = pageParam as CommitCursor | null;
      if (cur) {
        p.set("before", cur.authorDateUtc);
        p.set("beforeHash", cur.commitHash);
      }
      const qs = p.toString();
      return apiGet<CommitsResp>(`/api/commit-bridge/commits${qs ? `?${qs}` : ""}`);
    },
    initialPageParam: null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });

  const firstCoverage = commitsQ.data?.pages[0]?.coverage;
  useEffect(() => {
    if (firstCoverage && onCoverage) onCoverage(firstCoverage);
  }, [firstCoverage, onCoverage]);

  if (commitsQ.isLoading) {
    return <div className="text-xs text-[var(--fg-muted)]">加载提交…</div>;
  }
  if (commitsQ.isError) {
    return (
      <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
        加载失败：{(commitsQ.error as Error).message}
      </div>
    );
  }
  const items = commitsQ.data?.pages.flatMap((pg) => pg.items) ?? [];
  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--fg-muted)]">
        还没有已索引的提交。确认 git commit 已同步。
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4">
      {items.map((it) => (
        <CommitRow
          key={`${it.projectKey}-${it.commitHash}`}
          item={it}
          showRepo={!repo}
          open={openHash === it.commitHash}
          onToggle={() =>
            setOpenHash(openHash === it.commitHash ? null : it.commitHash)
          }
        />
      ))}
      {commitsQ.hasNextPage && (
        <button
          type="button"
          onClick={() => commitsQ.fetchNextPage()}
          disabled={commitsQ.isFetchingNextPage}
          className="my-3 w-full rounded-md border border-[var(--border)] py-2 text-sm text-[var(--fg-muted)] hover:bg-[var(--surface-2)] disabled:opacity-50"
        >
          {commitsQ.isFetchingNextPage ? "加载中…" : "加载更多"}
        </button>
      )}
    </div>
  );
}
