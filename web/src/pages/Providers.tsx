import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPatch, apiPost } from "../api";

type ProviderItem = {
  key: string;
  label: string;
  remainingPercent: number | null;
  resetAt: string | null;
  detail: Record<string, unknown>;
  syncedAt: string;
};

type ProviderView = {
  id: string;
  label: string;
  enabled: boolean;
  historyEnabled: boolean;
  requiresApiKey: boolean;
  hasKey: boolean;
  lastSyncAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  items: ProviderItem[];
};

type ListResponse = { ok: true; providers: ProviderView[] };

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

/** Kimi 会员档位友好名(API 只给枚举,不含价格);未知付费档回退去掉 LEVEL_ 前缀。 */
const KIMI_LEVEL_ZH: Record<string, string> = { LEVEL_TRIAL: "试用", LEVEL_FREE: "免费" };
function tierZh(detail: Record<string, unknown>): string {
  // Codex 的档位是自由文本(plus / pro …),Kimi 是 LEVEL_* 枚举 —— 按字段取,不按平台猜。
  const planType = typeof detail.planType === "string" ? detail.planType : null;
  if (planType) return planType;
  const level = typeof detail.level === "string" ? detail.level : null;
  const subType = typeof detail.subType === "string" ? detail.subType : null;
  if (level && KIMI_LEVEL_ZH[level]) return KIMI_LEVEL_ZH[level];
  if (level) return level.replace(/^LEVEL_/, "");
  return subType === "TYPE_PURCHASE" ? "已购买" : "—";
}

/**
 * 配额表的列语义因源而异,但**由数据决定,不由 provider id 决定** —— 否则每加一个源都要
 * 回来改这里,新源会静默掉进别人的分支(Claude/Codex 曾因此显示「模型组」和一整列空的
 * 「周剩余」)。第一列:有窗口语义就是「窗口」,否则是 MiniMax 那种按模型组切的。
 * 第四列:谁有数据显示谁,都没有就退化成「—」。
 */
type QuotaItem = ProviderItem;
function firstColumnHeader(items: QuotaItem[]): string {
  return items.some((it) => it.detail.kind === "window" || it.detail.kind === "weekly")
    ? "窗口"
    : "模型组";
}
function fourthColumn(items: QuotaItem[]): { header: string; cell: (it: QuotaItem) => string } {
  if (items.some((it) => typeof it.detail.limit === "number")) {
    return {
      header: "已用/上限",
      cell: (it) =>
        typeof it.detail.used === "number" && typeof it.detail.limit === "number"
          ? `${it.detail.used}/${it.detail.limit}`
          : "—",
    };
  }
  if (items.some((it) => typeof it.detail.weeklyRemainingPercent === "number")) {
    return {
      header: "周剩余",
      cell: (it) =>
        typeof it.detail.weeklyRemainingPercent === "number"
          ? `${it.detail.weeklyRemainingPercent}%`
          : "—",
    };
  }
  return {
    header: "已用",
    cell: (it) => (typeof it.detail.usedPercent === "number" ? `${it.detail.usedPercent}%` : "—"),
  };
}

function StatusBadge({ status }: { status: string | null }) {
  const map: Record<string, string> = {
    success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    partial: "bg-amber-50 text-amber-700 ring-amber-200",
    failed: "bg-rose-50 text-rose-700 ring-rose-200",
  };
  const cls = status ? map[status] ?? "bg-[var(--surface-2)] text-[var(--fg-muted)] ring-[var(--border)]" : "bg-[var(--surface-2)] text-[var(--fg-muted)] ring-[var(--border)]";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] ring-1 ${cls}`}>
      {status ?? "未同步"}
    </span>
  );
}

function ProviderCard({ p }: { p: ProviderView }) {
  const qc = useQueryClient();
  const [keyInput, setKeyInput] = useState("");
  const invalidate = () => qc.invalidateQueries({ queryKey: ["providers"] });

  const patch = useMutation({
    mutationFn: (body: { enabled?: boolean; historyEnabled?: boolean; apiKey?: string }) =>
      apiPatch<ListResponse>(`/api/providers/${p.id}`, body),
    onSuccess: () => {
      setKeyInput("");
      invalidate();
    },
  });
  const sync = useMutation({
    mutationFn: () => apiPost<ListResponse>(`/api/providers/${p.id}/sync`, {}),
    onSuccess: invalidate,
  });

  // Kimi 把「当前档位」塞成一个 kind:"membership" 的元信息项,单独渲,不进配额表。
  const membership = p.items.find((it) => it.detail.kind === "membership");
  const quota = p.items.filter((it) => it.detail.kind !== "membership");
  const fourth = fourthColumn(quota);

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-[var(--fg)]">{p.label}</h2>
          <StatusBadge status={p.lastStatus} />
          <span className="text-xs text-[var(--fg-muted)]">
            {p.requiresApiKey ? (p.hasKey ? "已配置 key" : "未配置 key") : "读取本机登录凭据"}
          </span>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--fg-muted)]">
          启用
          <input
            type="checkbox"
            checked={p.enabled}
            disabled={patch.isPending}
            onChange={(e) => patch.mutate({ enabled: e.target.checked })}
          />
        </label>
      </div>

      {p.id === "minimax" && (
        <label className="mb-3 flex cursor-pointer items-start gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-xs text-[var(--fg-muted)]">
          <input
            type="checkbox"
            checked={p.historyEnabled}
            disabled={patch.isPending}
            onChange={(e) => patch.mutate({ historyEnabled: e.target.checked })}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium text-[var(--fg)]">同步用量历史到 Token 趋势页</span>
            <span className="ml-1">
              （每小时拉取 MiniMax 未公开的账单接口
              <code>/account/amount</code>，逐小时 token 历史；账单 T+1~T+2 结算，最近一两天可能不全）
            </span>
          </span>
        </label>
      )}

      <div className="mb-3 flex items-center gap-2">
        {p.requiresApiKey ? (
          <>
            <input
              type="password"
              value={keyInput}
              placeholder={p.hasKey ? "重新填写以替换 key" : "粘贴 API key"}
              onChange={(e) => setKeyInput(e.target.value)}
              className="flex-1 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--fg)]"
            />
            <button
              type="button"
              disabled={!keyInput || patch.isPending}
              onClick={() => patch.mutate({ apiKey: keyInput })}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)] hover:bg-[var(--surface-2)] disabled:opacity-50"
            >
              保存 key
            </button>
          </>
        ) : (
          // 无需填 key:直接读本机 Claude Code / Codex 的登录凭据(只读,不刷新、不写回)。
          <span className="flex-1 text-xs text-[var(--fg-muted)]">
            无需填写 key，直接读取本机登录凭据；凭据失效时请在对应 CLI 里重新登录。
          </span>
        )}
        <button
          type="button"
          disabled={sync.isPending}
          onClick={() => sync.mutate()}
          className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
        >
          {sync.isPending ? "同步中…" : "立即同步"}
        </button>
      </div>

      <div className="mb-2 text-xs text-[var(--fg-muted)]">
        上次同步：{fmtTime(p.lastSyncAt)}
        {p.lastError && <span className="ml-2 text-rose-600">· {p.lastError}</span>}
      </div>

      {membership && (
        <div className="mb-2 text-xs text-[var(--fg)]">
          档位：<span className="font-medium">{tierZh(membership.detail)}</span>
          {typeof membership.detail.parallelLimit === "number" && (
            <span className="ml-2 text-[var(--fg-muted)]">并发上限 {membership.detail.parallelLimit}</span>
          )}
        </div>
      )}

      {quota.length > 0 ? (
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-[var(--fg-muted)]">
              <th className="py-1 text-left font-medium">{firstColumnHeader(quota)}</th>
              <th className="py-1 text-right font-medium">剩余</th>
              <th className="py-1 text-right font-medium">重置时间</th>
              <th className="py-1 text-right font-medium">{fourth.header}</th>
            </tr>
          </thead>
          <tbody>
            {quota.map((it) => (
              <tr key={it.key} className="border-t border-[var(--border)] text-[var(--fg)]">
                <td className="py-1.5 text-left">{it.label}</td>
                <td className="py-1.5 text-right">
                  {it.remainingPercent == null ? "—" : `${it.remainingPercent}%`}
                </td>
                <td className="py-1.5 text-right text-xs text-[var(--fg-muted)]">{fmtTime(it.resetAt)}</td>
                <td className="py-1.5 text-right">{fourth.cell(it)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="rounded-md border border-dashed border-[var(--border)] p-3 text-center text-xs text-[var(--fg-muted)]">
          {p.enabled ? "暂无数据，点「立即同步」拉取。" : "已禁用，启用后同步。"}
        </div>
      )}
    </section>
  );
}

export function Providers() {
  const q = useQuery<ListResponse>({
    queryKey: ["providers"],
    queryFn: () => apiGet<ListResponse>("/api/providers"),
  });

  return (
    <main className="mx-auto max-w-[1100px] px-8 py-6">
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-[var(--fg)]">外部 AI 平台用量</h1>
        <p className="mt-1 text-xs text-[var(--fg-muted)]">
          从各平台 API 同步用量快照（当前剩余额度，非每天历史）。API key 只保存在本机数据库、
          不会通过接口返回；Claude / Codex 无需填 key，直接读本机对应 CLI 的登录凭据（只读，
          不刷新也不写回）。关闭的平台不同步、不展示。
        </p>
      </header>

      {q.isError && (
        <div className="mb-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
          读取失败：{(q.error as Error).message}
        </div>
      )}

      <div className="space-y-4">
        {q.data?.providers.map((p) => <ProviderCard key={p.id} p={p} />)}
      </div>
    </main>
  );
}
