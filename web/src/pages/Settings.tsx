import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { X } from "lucide-react";
import { apiDelete, apiGet, apiPatch } from "../api";

type SettingsRes = {
  scanRoots: string[];
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
          <ScanRootsSection roots={q.data.scanRoots} onChanged={() => qc.invalidateQueries({ queryKey: ["settings"] })} />
          <GithubTokenSection github={q.data.github} onChanged={() => qc.invalidateQueries({ queryKey: ["settings"] })} />
        </>
      )}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-[var(--border)] bg-white p-4">
      <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>
      {hint && <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function ScanRootsSection({ roots, onChanged }: { roots: string[]; onChanged: () => void }) {
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (next: string[]) => apiPatch<SettingsRes>("/api/settings", { scanRoots: next }),
    onSuccess: () => {
      setDraft("");
      setErr(null);
      onChanged();
    },
    onError: (e) => setErr(shortErr(e)),
  });

  function add() {
    const p = draft.trim();
    if (!p) return;
    save.mutate([...roots, p]);
  }

  return (
    <Section title="默认扫描根目录" hint="不带 --root 运行 scan 时使用。未设置则默认当前目录。">
      {roots.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">尚未设默认扫描根 · scan 默认用当前目录。</p>
      ) : (
        <ul className="space-y-1">
          {roots.map((r) => (
            <li key={r} className="flex items-center justify-between gap-3 rounded border border-neutral-100 px-3 py-1.5">
              <span className="truncate font-mono text-xs text-neutral-700" title={r}>{r}</span>
              <button
                type="button"
                aria-label="删除根目录"
                disabled={save.isPending}
                onClick={() => save.mutate(roots.filter((x) => x !== r))}
                className="text-neutral-400 hover:text-red-600 disabled:opacity-50"
              >
                <X className="h-4 w-4" />
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
          className="h-9 flex-1 rounded-lg border border-neutral-200 px-3 font-mono text-xs"
        />
        <button
          type="button"
          onClick={add}
          disabled={save.isPending || !draft.trim()}
          className="h-9 rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
        >
          添加
        </button>
      </div>
      {err && <p className="mt-2 text-xs text-red-700">{err}</p>}
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
