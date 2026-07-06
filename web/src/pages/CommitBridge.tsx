import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api";
import { CommitBridgeList, type Coverage } from "../components/CommitBridgeList";

type BridgeRepo = { projectKey: string; displayName: string; commitCount: number };
type ReposResp = { ok: true; repos: BridgeRepo[]; coverage: Coverage };

/** 「对话 ↔ 提交」:看某个 commit 时你在跟 AI 聊什么。关联是启发式(提交前对话窗口),非因果。 */
export function CommitBridge() {
  const [repo, setRepo] = useState<string>(""); // "" = 全部仓库
  const [coverage, setCoverage] = useState<Coverage | null>(null);

  const reposQ = useQuery<ReposResp>({
    queryKey: ["commit-bridge-repos"],
    queryFn: () => apiGet<ReposResp>("/api/commit-bridge/repos"),
  });

  // coverage 优先用列表回传的(跟随筛选);未加载则退回 /repos 的全局头条。
  const cov = coverage ?? reposQ.data?.coverage ?? null;

  return (
    <main className="mx-auto max-w-[1040px] px-8 py-6">
      <header className="mb-4">
        <h1 className="text-xl font-semibold text-[var(--fg)]">
          对话 ↔ 提交 <span className="text-sm font-normal text-[var(--fg-muted)]">· 看某个 commit 时你在跟 AI 聊什么</span>
        </h1>
        <p className="mt-1 text-xs text-[var(--fg-muted)]">
          关联 = 提交前的对话窗口(本仓库上一个提交之后、最多回溯 6 小时里你发的话)。
          这是<strong>启发式</strong>(时间+仓库邻近),<strong>不代表因果</strong>。
        </p>
        {cov && (
          <p className="mt-1 text-xs text-[var(--fg-muted)]">
            你的 {cov.totalCommits} 个提交里 {cov.commitsInReposWithConversation} 个在有对话的仓库
            (仓库级 {Math.round(cov.pctReposWithConversation * 100)}%)。
          </p>
        )}
      </header>

      {/* 仓库筛选 */}
      <div className="mb-4 flex items-center gap-2">
        <label htmlFor="repo-filter" className="text-xs text-[var(--fg-muted)]">
          仓库
        </label>
        <select
          id="repo-filter"
          value={repo}
          onChange={(e) => {
            setRepo(e.target.value);
            setCoverage(null);
          }}
          className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--fg)]"
        >
          <option value="">全部仓库</option>
          {(reposQ.data?.repos ?? []).map((r) => (
            <option key={r.projectKey} value={r.projectKey}>
              {r.displayName} ({r.commitCount})
            </option>
          ))}
        </select>
      </div>

      <CommitBridgeList repo={repo} onCoverage={setCoverage} />
    </main>
  );
}
