import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Folder, Plus, X } from "lucide-react";
import { apiDelete, apiGet, apiPatch } from "../api";

type SettingsRes = {
  scanRoots: string[];
  scanMaxDepth: number;
  scanMaxDocs: number;
  scanConcurrency: number;
  github: { set: boolean; source: "env" | "file" | null };
};

function shortErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function Settings() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiGet<SettingsRes>("/api/settings"),
  });

  return (
    <div className="min-h-[70vh] max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--fg)]">设置</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">扫描默认值与密钥。配置只保存在本机。</p>
      </header>

      {q.isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900" role="alert">
          {shortErr(q.error)}
        </div>
      )}

      {q.data && (
        <>
          <ScanRootsSection
            roots={q.data.scanRoots}
            maxDepth={q.data.scanMaxDepth}
            maxDocs={q.data.scanMaxDocs}
            concurrency={q.data.scanConcurrency}
            onChanged={() => qc.invalidateQueries({ queryKey: ["settings"] })}
          />
          <GithubTokenSection github={q.data.github} onChanged={() => qc.invalidateQueries({ queryKey: ["settings"] })} />
        </>
      )}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-[var(--border)] bg-white p-4">
      <h2 className="text-sm font-semibold text-[var(--fg)]">{title}</h2>
      {hint && <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function ScanRootsSection({
  roots,
  maxDepth,
  maxDocs,
  concurrency,
  onChanged,
}: {
  roots: string[];
  maxDepth: number;
  maxDocs: number;
  concurrency: number;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [depth, setDepth] = useState(String(maxDepth));
  const [docs, setDocs] = useState(String(maxDocs));
  const [conc, setConc] = useState(String(concurrency));

  const save = useMutation({
    mutationFn: (next: string[]) => apiPatch<SettingsRes>("/api/settings", { scanRoots: next }),
    onSuccess: () => {
      setDraft("");
      setErr(null);
      onChanged();
    },
    onError: (e) => setErr(shortErr(e)),
  });

  const saveDepth = useMutation({
    mutationFn: (n: number) => apiPatch<SettingsRes>("/api/settings", { scanMaxDepth: n }),
    onSuccess: () => onChanged(),
  });

  const saveDocs = useMutation({
    mutationFn: (n: number) => apiPatch<SettingsRes>("/api/settings", { scanMaxDocs: n }),
    onSuccess: () => onChanged(),
  });

  const saveConc = useMutation({
    mutationFn: (n: number) => apiPatch<SettingsRes>("/api/settings", { scanConcurrency: n }),
    onSuccess: () => onChanged(),
  });

  function add() {
    const p = draft.trim();
    if (!p) return;
    save.mutate([...roots, p]);
  }

  return (
    <Section title="默认扫描根目录" hint="不带 --root 运行 scan 时使用。未设置则默认当前目录。">
      {roots.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--border)] px-3 py-5 text-center text-sm text-[var(--muted)]">
          尚未设默认扫描根 · scan 默认用当前目录
        </p>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-[var(--border)] divide-y divide-[var(--border)]">
          {roots.map((r) => (
            <li key={r} className="group flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-[var(--bg)]">
              <Folder aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--muted)]" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--fg)]" title={r}>{r}</span>
              <button
                type="button"
                aria-label={`删除根目录 ${r}`}
                disabled={save.isPending}
                onClick={() => save.mutate(roots.filter((x) => x !== r))}
                className="shrink-0 rounded-md p-1 text-[var(--muted)] transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="绝对路径，如 /Users/you/code"
          className="h-9 flex-1 rounded-lg border border-[var(--border)] bg-white px-3 font-mono text-xs text-[var(--fg)] outline-none transition-colors placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
        />
        <button
          type="button"
          onClick={add}
          disabled={save.isPending || !draft.trim()}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-white px-3 text-sm font-medium text-[var(--fg)] outline-none transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] focus-visible:ring-1 focus-visible:ring-[var(--accent)] disabled:opacity-50"
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          添加
        </button>
      </div>
      {err && <p className="mt-2 text-xs text-red-600">{err}</p>}

      <div className="mt-4 space-y-2 border-t border-[var(--border)] pt-3">
        <div className="flex items-center gap-2">
          <label htmlFor="scan-depth" className="w-24 shrink-0 text-xs font-medium text-[var(--fg)]">
            最大扫描深度
          </label>
          <input
            id="scan-depth"
            type="number"
            min={0}
            max={64}
            value={depth}
            onChange={(e) => setDepth(e.target.value)}
            onBlur={() => {
              const n = Number(depth);
              if (Number.isInteger(n) && n >= 0 && n <= 64 && n !== maxDepth) saveDepth.mutate(n);
              else setDepth(String(maxDepth));
            }}
            className="h-8 w-16 rounded-lg border border-[var(--border)] bg-white px-2 text-sm tabular-nums text-[var(--fg)] outline-none transition-colors focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
          />
          <span className="text-xs text-[var(--muted)]">层（防止扫穿大目录，如 home）。</span>
          {saveDepth.isError && (
            <span className="text-xs text-red-600">{shortErr(saveDepth.error)}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="scan-docs" className="w-24 shrink-0 text-xs font-medium text-[var(--fg)]">
            每仓库最多文档
          </label>
          <input
            id="scan-docs"
            type="number"
            min={1}
            max={5000}
            value={docs}
            onChange={(e) => setDocs(e.target.value)}
            onBlur={() => {
              const n = Number(docs);
              if (Number.isInteger(n) && n >= 1 && n <= 5000 && n !== maxDocs) saveDocs.mutate(n);
              else setDocs(String(maxDocs));
            }}
            className="h-8 w-16 rounded-lg border border-[var(--border)] bg-white px-2 text-sm tabular-nums text-[var(--fg)] outline-none transition-colors focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
          />
          <span className="text-xs text-[var(--muted)]">篇（docs/ 下 markdown，超出按设计跳过，不算错误）。</span>
          {saveDocs.isError && (
            <span className="text-xs text-red-600">{shortErr(saveDocs.error)}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="scan-conc" className="w-24 shrink-0 text-xs font-medium text-[var(--fg)]">
            扫描并发度
          </label>
          <input
            id="scan-conc"
            type="number"
            min={1}
            max={64}
            value={conc}
            onChange={(e) => setConc(e.target.value)}
            onBlur={() => {
              const n = Number(conc);
              if (Number.isInteger(n) && n >= 1 && n <= 64 && n !== concurrency) saveConc.mutate(n);
              else setConc(String(concurrency));
            }}
            className="h-8 w-16 rounded-lg border border-[var(--border)] bg-white px-2 text-sm tabular-nums text-[var(--fg)] outline-none transition-colors focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
          />
          <span className="text-xs text-[var(--muted)]">并行 I/O 上限（多根/目录/文件并行扫描）。</span>
          {saveConc.isError && (
            <span className="text-xs text-red-600">{shortErr(saveConc.error)}</span>
          )}
        </div>
      </div>
    </Section>
  );
}

function GithubTokenSection({
  github,
  onChanged,
}: {
  github: SettingsRes["github"];
  onChanged: () => void;
}) {
  const [token, setToken] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const envManaged = github.source === "env";

  const save = useMutation({
    mutationFn: () => apiPatch<unknown>("/api/settings/secret/github", { token: token.trim() }),
    onSuccess: () => {
      setToken("");
      onChanged();
    },
  });
  const clear = useMutation({
    mutationFn: () => apiDelete<unknown>("/api/settings/secret/github"),
    onSuccess: () => {
      setConfirmClear(false);
      onChanged();
    },
  });

  return (
    <Section title="GitHub Token" hint="保存在 ~/.ai2nao/github.json（权限 0600，仅本机）。">
      <div className="mb-2 text-xs">
        {envManaged ? (
          <span className="text-amber-700">由 GITHUB_TOKEN 环境变量接管 · 文件设置当前不会生效</span>
        ) : github.set ? (
          <span className="text-emerald-700">已设置 token</span>
        ) : (
          <span className="text-[var(--muted)]">未设置</span>
        )}
      </div>

      <div className="flex gap-2">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          disabled={envManaged}
          placeholder={github.set ? "重新填写以替换" : "粘贴 ghp_… token"}
          className="h-9 flex-1 rounded-lg border border-neutral-200 px-3 text-sm disabled:bg-neutral-50 disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={envManaged || save.isPending || !token.trim()}
          className="h-9 rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
        >
          {save.isPending ? "保存中…" : "保存"}
        </button>
        {github.set && (
          <button
            type="button"
            onClick={() => (confirmClear ? clear.mutate() : setConfirmClear(true))}
            disabled={envManaged || clear.isPending}
            className="h-9 rounded-lg border border-red-200 bg-white px-3 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {confirmClear ? "再点一次确认清除" : "清除"}
          </button>
        )}
      </div>
      {save.isError && <p className="mt-2 text-xs text-red-700">{shortErr(save.error)}</p>}
    </Section>
  );
}
