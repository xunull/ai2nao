import { useState } from "react";
import type { GhRepo } from "../types/github";

type Props = {
  repo: GhRepo;
};

function formatDay(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const now = Date.now();
  const days = Math.floor((now - then) / (1000 * 60 * 60 * 24));
  if (days < 1) return "今天";
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

function commitCountLabel(repo: GhRepo): string {
  if (repo.commit_count != null) return `${repo.commit_count} 次提交`;
  if (repo.commit_count_error === "empty") return "空仓库（0 次提交）";
  if (repo.commit_count_error === "no_default_branch") return "无默认分支";
  if (repo.commit_count_error === "fetch_failed") return "提交数获取失败";
  return "提交数未知";
}

/**
 * Detail-rich repo card, inline-expandable for clone URL / topics / metadata
 * that would otherwise clutter the stream. The collapsed view is tuned for
 * scanning: name, one-line description, created date, commit count, language.
 */
export function GithubRepoCard({ repo }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <article className="rounded border border-[var(--border)] bg-white p-4 shadow-sm">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">
            <a
              className="text-[var(--accent)] hover:underline break-all"
              href={repo.html_url}
              target="_blank"
              rel="noreferrer"
            >
              {repo.full_name}
            </a>
            {repo.private ? (
              <span className="ml-2 rounded bg-neutral-100 px-2 py-0.5 text-xs text-[var(--muted)] align-middle">
                private
              </span>
            ) : null}
            {repo.fork ? (
              <span className="ml-2 rounded bg-neutral-100 px-2 py-0.5 text-xs text-[var(--muted)] align-middle">
                fork
              </span>
            ) : null}
            {repo.archived ? (
              <span className="ml-2 rounded bg-amber-50 text-amber-900 px-2 py-0.5 text-xs align-middle">
                archived
              </span>
            ) : null}
          </h3>
          {repo.description ? (
            <p className="mt-1 text-sm text-[var(--fg)]">{repo.description}</p>
          ) : (
            <p className="mt-1 text-sm italic text-[var(--muted)]">无描述</p>
          )}
        </div>
        <button
          type="button"
          className="shrink-0 rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-neutral-50"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "收起" : "展开"}
        </button>
      </header>

      <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-y-2 gap-x-4 text-xs">
        <div>
          <dt className="text-[var(--muted)]">创建</dt>
          <dd title={repo.created_at}>{formatDay(repo.created_at)}</dd>
        </div>
        <div>
          <dt className="text-[var(--muted)]">最后推送</dt>
          <dd title={repo.pushed_at ?? ""}>
            {formatDay(repo.pushed_at)}{" "}
            <span className="text-[var(--muted)]">
              ({formatRelative(repo.pushed_at)})
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-[var(--muted)]">提交数</dt>
          <dd>{commitCountLabel(repo)}</dd>
        </div>
        <div>
          <dt className="text-[var(--muted)]">语言</dt>
          <dd>{repo.language ?? "—"}</dd>
        </div>
      </dl>

      {repo.topics.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1">
          {repo.topics.map((t) => (
            <span
              key={t}
              className="rounded bg-sky-50 text-sky-900 px-2 py-0.5 text-xs"
            >
              {t}
            </span>
          ))}
        </div>
      ) : null}

      {open ? (
        <div className="mt-3 border-t border-[var(--border)] pt-3 space-y-2 text-xs text-[var(--muted)]">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <span className="text-[var(--muted)]">默认分支：</span>
              <code className="bg-neutral-100 px-1 rounded">
                {repo.default_branch ?? "—"}
              </code>
            </div>
            <div>
              <span className="text-[var(--muted)]">Star 数：</span>
              {repo.stargazers_count}
            </div>
            <div>
              <span className="text-[var(--muted)]">Fork 数：</span>
              {repo.forks_count}
            </div>
            <div>
              <span className="text-[var(--muted)]">Open issues：</span>
              {repo.open_issues_count}
            </div>
            <div>
              <span className="text-[var(--muted)]">仓库大小：</span>
              {repo.size_kb} KB
            </div>
            <div>
              <span className="text-[var(--muted)]">更新时间：</span>
              {formatDay(repo.updated_at)} ({formatRelative(repo.updated_at)})
            </div>
          </div>
          {repo.clone_url ? (
            <div>
              <span>clone:</span>{" "}
              <code className="bg-neutral-100 px-1 rounded break-all">
                {repo.clone_url}
              </code>
            </div>
          ) : null}
          {repo.commit_count_checked_at ? (
            <div>
              提交数最后刷新：{formatDay(repo.commit_count_checked_at)}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
