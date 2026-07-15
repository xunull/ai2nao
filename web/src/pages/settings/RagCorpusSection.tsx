import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Folder, Plus, X } from "lucide-react";
import { apiDelete, apiPatch } from "../../api";

type Setting = {
  set: boolean;
  source: "db" | "file" | null;
  label: string;
  values: Record<string, unknown> | null;
};

type CorpusValues = {
  corpusRoots?: string[];
  includeExtensions?: string[];
  maxFileBytes?: number;
  vectorStore?: { provider?: string; path?: string };
};

function shortErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const MB = 1024 * 1024;

/**
 * Corpus half of the RAG config — roots, file filters, vector store. The
 * embedding key/model is a separate credential (RagEmbeddingSection); this is
 * the non-secret part, stored in the `rag-corpus` setting.
 *
 * corpusRoots is the one field that actually changes often, so it gets the same
 * add/remove list UI as scan roots. Saving with an empty roots list is rejected
 * server-side (a corpus with no roots is not a config), so the button stays off
 * until there's at least one.
 */
export function RagCorpusSection({
  setting,
  onChanged,
}: {
  setting: Setting;
  onChanged: () => void;
}) {
  const v = (setting.values ?? {}) as CorpusValues;
  const [roots, setRoots] = useState<string[]>(v.corpusRoots ?? []);
  const [draft, setDraft] = useState("");
  const [exts, setExts] = useState((v.includeExtensions ?? [".md", ".mdx", ".txt"]).join(", "));
  const [maxMb, setMaxMb] = useState(String(Math.round((v.maxFileBytes ?? 8 * MB) / MB)));

  const save = useMutation({
    mutationFn: () =>
      apiPatch<unknown>("/api/settings/setting/rag-corpus", {
        corpusRoots: roots,
        includeExtensions: exts
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        maxFileBytes: Math.max(1, Number(maxMb) || 8) * MB,
      }),
    onSuccess: onChanged,
  });
  const clear = useMutation({
    mutationFn: () => apiDelete<unknown>("/api/settings/setting/rag-corpus"),
    onSuccess: onChanged,
  });
  const [confirmClear, setConfirmClear] = useState(false);

  function addRoot() {
    const p = draft.trim();
    if (!p) return;
    setRoots([...roots, p]);
    setDraft("");
  }

  return (
    <section className="rounded-lg border border-[var(--border)] bg-white p-4">
      <h2 className="text-sm font-semibold text-[var(--fg)]">语料库</h2>
      <p className="mt-1 text-xs text-[var(--muted)]">
        ai2nao rag ingest 会扫描这些目录里的 markdown。路径必须是本机存在的目录。
      </p>

      <div className="mt-3 mb-3 text-xs">
        {setting.source === "file" ? (
          <span className="text-amber-700">
            当前用的是 ~/.ai2nao/rag.json · 保存后改由设置接管（文件保留不动）
          </span>
        ) : setting.source === "db" ? (
          <span className="text-emerald-700">已在设置中管理</span>
        ) : (
          <span className="text-[var(--muted)]">未配置</span>
        )}
      </div>

      {roots.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 text-center text-xs text-[var(--muted)]">
          还没有语料根目录
        </p>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-[var(--border)] divide-y divide-[var(--border)]">
          {roots.map((r) => (
            <li key={r} className="group flex items-center gap-2.5 px-3 py-2 hover:bg-[var(--bg)]">
              <Folder aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--muted)]" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={r}>
                {r}
              </span>
              <button
                type="button"
                aria-label={`删除 ${r}`}
                onClick={() => setRoots(roots.filter((x) => x !== r))}
                className="shrink-0 rounded-md p-1 text-[var(--muted)] transition-colors hover:bg-red-50 hover:text-red-600"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex gap-2">
        <input
          aria-label="新增语料根目录"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addRoot()}
          placeholder="绝对路径，如 /Users/you/notes"
          className="h-9 flex-1 rounded-lg border border-[var(--border)] bg-white px-3 font-mono text-xs outline-none focus:border-[var(--accent)]"
        />
        <button
          type="button"
          onClick={addRoot}
          disabled={!draft.trim()}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-white px-3 text-sm font-medium outline-none transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          添加
        </button>
      </div>

      <div className="mt-3 space-y-2 border-t border-[var(--border)] pt-3">
        <div className="flex items-center gap-3">
          <label htmlFor="rag-exts" className="w-24 shrink-0 text-xs font-medium text-[var(--fg)]">
            索引扩展名
          </label>
          <input
            id="rag-exts"
            value={exts}
            onChange={(e) => setExts(e.target.value)}
            placeholder=".md, .mdx, .txt"
            className="h-8 flex-1 rounded-lg border border-[var(--border)] bg-white px-2.5 font-mono text-xs outline-none focus:border-[var(--accent)]"
          />
        </div>
        <div className="flex items-center gap-3">
          <label htmlFor="rag-maxmb" className="w-24 shrink-0 text-xs font-medium text-[var(--fg)]">
            单文件上限
          </label>
          <input
            id="rag-maxmb"
            type="number"
            min={1}
            max={64}
            value={maxMb}
            onChange={(e) => setMaxMb(e.target.value)}
            className="h-8 w-16 rounded-lg border border-[var(--border)] bg-white px-2 text-sm tabular-nums outline-none focus:border-[var(--accent)]"
          />
          <span className="text-xs text-[var(--muted)]">MB，超过的文件跳过不索引。</span>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={roots.length === 0 || save.isPending}
          className="h-8 rounded-lg border border-[var(--border)] bg-white px-3 text-sm font-medium transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
        >
          {save.isPending ? "保存中…" : setting.source === "db" ? "保存" : "接管配置"}
        </button>
        {setting.set && setting.source === "db" && (
          <button
            type="button"
            onClick={() => (confirmClear ? clear.mutate() : setConfirmClear(true))}
            className="h-8 rounded-lg border border-red-200 bg-white px-3 text-sm font-medium text-red-700 transition-colors hover:bg-red-50"
          >
            {confirmClear ? "再点一次确认清除" : "清除"}
          </button>
        )}
      </div>
      {save.isError && <p className="mt-2 text-xs text-red-700">{shortErr(save.error)}</p>}
    </section>
  );
}
