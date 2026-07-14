import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { apiGet, apiPatch } from "../../api";

type RuleKind = "domainSuffix" | "hostPrefix" | "titleKeyword";
type Rule = { kind: RuleKind; value: string };
type Category = { name: string; color: string; rules: Rule[] };

type TaxonomyRes = {
  source: "db" | "file" | "default";
  gapMinutes: number;
  /** The user's own categories — the only thing that gets saved. */
  own: Category[];
  /** Built-ins they have not overridden. Read-only until "覆盖" copies one into `own`. */
  builtin: Category[];
  otherCategory: string;
};

const RULE_LABELS: Record<RuleKind, string> = {
  domainSuffix: "域名后缀",
  hostPrefix: "域名前缀",
  titleKeyword: "标题关键词",
};

const RULE_PLACEHOLDER: Record<RuleKind, string> = {
  domainSuffix: "react.dev",
  hostPrefix: "docs.",
  titleKeyword: "kubernetes",
};

const PALETTE = ["#4f9dff", "#5ec8a0", "#ffb454", "#ff6b6b", "#b48ead", "#88c0d0", "#d08770"];

function shortErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Editor for the topic taxonomy — the categories behind 主题河流.
 *
 * Two things it deliberately does NOT do:
 *  - It never saves the built-in categories back. They merge in at read time, so
 *    freezing them here would cut you off from future updates to the built-in list.
 *    "覆盖" copies one into your own set; that (and only that) is what gets stored.
 *  - It doesn't offer to delete a built-in, because the merge rule makes that
 *    impossible. Overriding one with an empty rule list is the way to neutralise
 *    it: it stays listed but matches nothing.
 */
export function TaxonomyEditor() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["taxonomy"],
    queryFn: () => apiGet<TaxonomyRes>("/api/topics/taxonomy"),
  });

  const [draft, setDraft] = useState<Category[] | null>(null);
  const [gap, setGap] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  const own = draft ?? q.data?.own ?? [];
  const gapMinutes = gap ?? String(q.data?.gapMinutes ?? 30);
  const dirty = draft !== null || gap !== null;

  const save = useMutation({
    mutationFn: () =>
      apiPatch<TaxonomyRes>("/api/topics/taxonomy", {
        categories: own,
        gapMinutes: Number(gapMinutes),
      }),
    onSuccess: () => {
      setDraft(null);
      setGap(null);
      qc.invalidateQueries({ queryKey: ["taxonomy"] });
      // The topic river's rule_version now mismatches, so its own banner will
      // say 需要重建 — that page owns that message, not this one.
      qc.invalidateQueries({ queryKey: ["topics"] });
    },
  });

  function update(next: Category[]) {
    setDraft(next);
  }

  function patchCat(i: number, patch: Partial<Category>) {
    update(own.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  }

  if (q.isLoading) return <p className="text-sm text-[var(--muted)]">载入中…</p>;
  if (q.isError) return <p className="text-sm text-red-700">{shortErr(q.error)}</p>;

  const cur = own[selected];

  return (
    <div>
      <div className="mb-3 flex items-center gap-3 text-xs">
        {q.data?.source === "file" ? (
          <span className="text-amber-700">
            当前用的是 ~/.ai2nao/config.json · 在这里保存后改由设置接管（文件保留不动）
          </span>
        ) : q.data?.source === "db" ? (
          <span className="text-emerald-700">已在设置中管理</span>
        ) : (
          <span className="text-[var(--muted)]">当前使用内置分类</span>
        )}
      </div>

      <div className="flex gap-4">
        {/* left: your categories */}
        <div className="w-48 shrink-0">
          <div className="mb-1.5 text-xs font-medium text-[var(--fg)]">我的分类</div>
          <ul className="space-y-0.5">
            {own.map((c, i) => (
              <li key={`${c.name}-${i}`}>
                <button
                  type="button"
                  onClick={() => setSelected(i)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                    i === selected ? "bg-[var(--accent)]/10 font-medium" : "hover:bg-[var(--bg)]"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: c.color }}
                  />
                  <span className="min-w-0 flex-1 truncate">{c.name || "（未命名）"}</span>
                  <span className="shrink-0 tabular-nums text-[var(--muted)]">
                    {c.rules.length}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={() => {
              update([
                ...own,
                { name: "", color: PALETTE[own.length % PALETTE.length], rules: [] },
              ]);
              setSelected(own.length);
            }}
            className="mt-1.5 inline-flex h-7 w-full items-center justify-center gap-1 rounded-md border border-dashed border-[var(--border)] text-xs text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            新增分类
          </button>

          {q.data && q.data.builtin.length > 0 && (
            <div className="mt-4 border-t border-[var(--border)] pt-2">
              <div className="mb-1.5 text-xs font-medium text-[var(--muted)]">
                内置（{q.data.builtin.length}）
              </div>
              <ul className="max-h-40 space-y-0.5 overflow-y-auto pr-1">
                {q.data.builtin.map((b) => (
                  <li key={b.name} className="group flex items-center gap-2 px-2 py-1 text-xs">
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: b.color }}
                    />
                    <span className="min-w-0 flex-1 truncate text-[var(--muted)]">{b.name}</span>
                    <button
                      type="button"
                      title="复制成我的分类后再编辑"
                      onClick={() => {
                        update([...own, { ...b, rules: [...b.rules] }]);
                        setSelected(own.length);
                      }}
                      className="shrink-0 rounded px-1 text-[10px] text-[var(--muted)] opacity-0 transition-opacity hover:text-[var(--accent)] group-hover:opacity-100"
                    >
                      覆盖
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* right: the selected category */}
        <div className="min-w-0 flex-1 border-l border-[var(--border)] pl-4">
          {!cur ? (
            <p className="py-8 text-center text-xs text-[var(--muted)]">
              左边选一个分类，或新增一个。没被任何规则命中的浏览会落进「
              {q.data?.otherCategory}」。
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <input
                  aria-label="分类名"
                  value={cur.name}
                  onChange={(e) => patchCat(selected, { name: e.target.value })}
                  placeholder="分类名，如 自建·Homelab"
                  className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-white px-2.5 text-sm outline-none focus:border-[var(--accent)]"
                />
                <input
                  aria-label="颜色"
                  type="color"
                  value={cur.color}
                  onChange={(e) => patchCat(selected, { color: e.target.value })}
                  className="h-8 w-10 shrink-0 cursor-pointer rounded-lg border border-[var(--border)] bg-white p-0.5"
                />
                <button
                  type="button"
                  aria-label={`删除分类 ${cur.name}`}
                  onClick={() => {
                    update(own.filter((_, k) => k !== selected));
                    setSelected(Math.max(0, selected - 1));
                  }}
                  className="h-8 shrink-0 rounded-lg border border-red-200 px-2 text-xs text-red-700 transition-colors hover:bg-red-50"
                >
                  删除
                </button>
              </div>

              <div className="mt-3 space-y-1.5">
                {cur.rules.length === 0 && (
                  <p className="text-xs text-[var(--muted)]">
                    没有规则 · 这个分类不会命中任何东西（用来「废掉」一个内置分类正合适）
                  </p>
                )}
                {cur.rules.map((r, ri) => (
                  <div key={ri} className="flex items-center gap-2">
                    <select
                      aria-label="规则类型"
                      value={r.kind}
                      onChange={(e) =>
                        patchCat(selected, {
                          rules: cur.rules.map((x, k) =>
                            k === ri ? { ...x, kind: e.target.value as RuleKind } : x
                          ),
                        })
                      }
                      className="h-8 w-28 shrink-0 rounded-lg border border-[var(--border)] bg-white px-1.5 text-xs outline-none focus:border-[var(--accent)]"
                    >
                      {(Object.keys(RULE_LABELS) as RuleKind[]).map((k) => (
                        <option key={k} value={k}>
                          {RULE_LABELS[k]}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label="规则值"
                      value={r.value}
                      onChange={(e) =>
                        patchCat(selected, {
                          rules: cur.rules.map((x, k) =>
                            k === ri ? { ...x, value: e.target.value } : x
                          ),
                        })
                      }
                      placeholder={RULE_PLACEHOLDER[r.kind]}
                      className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-white px-2.5 font-mono text-xs outline-none focus:border-[var(--accent)]"
                    />
                    <button
                      type="button"
                      aria-label="删除规则"
                      onClick={() =>
                        patchCat(selected, { rules: cur.rules.filter((_, k) => k !== ri) })
                      }
                      className="shrink-0 rounded-md p-1 text-[var(--muted)] transition-colors hover:bg-red-50 hover:text-red-600"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    patchCat(selected, {
                      rules: [...cur.rules, { kind: "domainSuffix", value: "" }],
                    })
                  }
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-[var(--border)] px-2 text-xs text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                >
                  <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                  新增规则
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3 border-t border-[var(--border)] pt-3">
        <label htmlFor="tax-gap" className="text-xs font-medium text-[var(--fg)]">
          会话间隔
        </label>
        <input
          id="tax-gap"
          type="number"
          min={1}
          max={1440}
          value={gapMinutes}
          onChange={(e) => setGap(e.target.value)}
          className="h-8 w-16 rounded-lg border border-[var(--border)] bg-white px-2 text-sm tabular-nums outline-none focus:border-[var(--accent)]"
        />
        <span className="text-xs text-[var(--muted)]">分钟没有活动就切一段新会话。</span>

        <div className="flex-1" />

        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={!dirty || save.isPending}
          className="h-8 rounded-lg border border-[var(--border)] bg-white px-3 text-sm font-medium transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
        >
          {save.isPending ? "保存中…" : "保存"}
        </button>
      </div>

      {save.isError && <p className="mt-2 text-xs text-red-700">{shortErr(save.error)}</p>}
      {save.isSuccess && !dirty && (
        <p className="mt-2 text-xs text-emerald-700">
          已保存 · 主题河流会提示「需要重建」，跑一次 <code>ai2nao topics rebuild</code> 生效。
        </p>
      )}
    </div>
  );
}
