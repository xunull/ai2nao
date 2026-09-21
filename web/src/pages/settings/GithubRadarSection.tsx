import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Folder } from "lucide-react";
import { apiPatch } from "../../api";

type Setting = {
  set: boolean;
  source: "db" | "file" | null;
  label: string;
  values: Record<string, unknown> | null;
};

function shortErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 开源雷达的「当前工作目录」。
 *
 * 雷达的推荐要回答「你现在在做什么」,靠的是从一个具体目录里扫 git 分支、提交和
 * TODO 文档。它原来读的是**进程的工作目录**,而打包的桌面版守护进程 cwd 是 `/` ——
 * 扫出来必然是空,推荐于是退化成静态排序,界面上还看不出来。
 *
 * 留空是合法的:那样只用 star 库的信号,重算结果里会带一条说明。
 * 填错(不存在、不是目录、相对路径)在保存时就会被拒绝,不会等到任务跑起来才发现。
 */
export function GithubRadarSection({
  setting,
  onChanged,
}: {
  setting: Setting;
  onChanged: () => void;
}) {
  const stored = String((setting.values as { cwd?: unknown } | null)?.cwd ?? "");
  const [cwd, setCwd] = useState(stored);

  const save = useMutation({
    mutationFn: () => apiPatch<unknown>("/api/settings/setting/github-radar", { cwd: cwd.trim() }),
    onSuccess: onChanged,
  });

  return (
    <section className="rounded-lg border border-[var(--border)] bg-white p-4">
      <header className="mb-3">
        <h2 className="text-sm font-semibold text-neutral-900">开源雷达 · 当前工作目录</h2>
        <p className="mt-1 text-xs text-[var(--muted)]">
          雷达用这个目录里的 git 分支、提交和 TODO 文档判断「你现在在做什么」，再据此推荐
          star 过的项目。留空则只用 star 库的信号。
        </p>
      </header>

      <label className="block">
        <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-neutral-700">
          <Folder className="h-3.5 w-3.5" aria-hidden="true" />
          目录绝对路径
        </span>
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="留空 = 不扫当前工作"
          className="h-9 w-full rounded-lg border border-neutral-200 bg-white px-3 font-mono text-xs"
        />
      </label>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending || cwd.trim() === stored}
          className="inline-flex h-9 items-center rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-800 shadow-sm transition hover:border-blue-200 hover:bg-slate-50 disabled:opacity-50"
        >
          {save.isPending ? "保存中…" : "保存"}
        </button>
        {setting.set && (
          <span className="text-xs text-[var(--muted)]">
            当前：{stored || "（留空）"}
          </span>
        )}
      </div>

      {save.isError && (
        <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          {shortErr(save.error)}
        </p>
      )}
    </section>
  );
}
