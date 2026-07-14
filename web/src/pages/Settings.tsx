import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Bell, Bot, Database, Folder, Layers, Plus, Sliders, X } from "lucide-react";
import { apiDelete, apiGet, apiPatch } from "../api";
import { TaxonomyEditor } from "./settings/TaxonomyEditor";

/** Where a credential is actually coming from — mirrors the server's precedence. */
type CredSource = "env" | "db" | "file" | null;

type Credential = {
  set: boolean;
  source: CredSource;
  label: string;
  /** Non-secret fields only. The server never sends the key itself. */
  values: Record<string, unknown> | null;
};

type CredName = "llm-chat" | "rag-embedding" | "web-search" | "github" | "feishu" | "minimax";

type SettingsRes = {
  scanRoots: string[];
  scanMaxDepth: number;
  scanMaxDocs: number;
  scanConcurrency: number;
  github: { set: boolean; source: CredSource };
  credentials: Record<CredName, Credential>;
};

function shortErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const CATEGORIES = [
  { id: "general", label: "通用", icon: Sliders },
  { id: "topics", label: "主题分类", icon: Layers },
  { id: "ai", label: "AI 与模型", icon: Bot },
  { id: "sources", label: "数据源", icon: Database },
  { id: "notify", label: "通知", icon: Bell },
] as const;

type CategoryId = (typeof CATEGORIES)[number]["id"];

export function Settings() {
  const qc = useQueryClient();
  const [active, setActive] = useState<CategoryId>("general");
  const q = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiGet<SettingsRes>("/api/settings"),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["settings"] });

  return (
    <div className="min-h-[70vh] max-w-5xl">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--fg)]">设置</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          密钥保存在 ~/.ai2nao/config.db（0600，仅本机）· 永不上传、永不回显
        </p>
      </header>

      {q.isError && (
        <div
          className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
          role="alert"
        >
          {shortErr(q.error)}
        </div>
      )}

      {q.data && (
        <div className="mt-5 flex gap-6">
          <nav aria-label="设置分类" className="w-40 shrink-0">
            <ul className="space-y-0.5">
              {CATEGORIES.map((c) => {
                const Icon = c.icon;
                const on = c.id === active;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      aria-current={on ? "page" : undefined}
                      onClick={() => setActive(c.id)}
                      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                        on
                          ? "bg-[var(--accent)]/10 font-medium text-[var(--accent)]"
                          : "text-[var(--fg)] hover:bg-[var(--bg)]"
                      }`}
                    >
                      <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                      {c.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="min-w-0 flex-1 space-y-4">
            {active === "general" && (
              <ScanRootsSection
                roots={q.data.scanRoots}
                maxDepth={q.data.scanMaxDepth}
                maxDocs={q.data.scanMaxDocs}
                concurrency={q.data.scanConcurrency}
                onChanged={refresh}
              />
            )}

            {active === "topics" && (
              <Section
                title="主题分类"
                hint="主题河流的分类词表。你的分类排在前面，没被你重名的内置分类会自动补上 —— 所以只需要写你的增量。"
              >
                <TaxonomyEditor />
              </Section>
            )}

            {active === "ai" && (
              <LlmChatSection cred={q.data.credentials["llm-chat"]} onChanged={refresh} />
            )}

            {active === "sources" && (
              <>
                <GithubTokenSection cred={q.data.credentials.github} onChanged={refresh} />
                <WebSearchSection cred={q.data.credentials["web-search"]} onChanged={refresh} />
                <RagEmbeddingSection
                  cred={q.data.credentials["rag-embedding"]}
                  onChanged={refresh}
                />
                {/* A footnote, not a form: MiniMax's key is edited on the
                    「外部平台」page (which now writes to the same config.db).
                    Giving it a full card would push this category past one
                    screen for no reason. */}
                <p className="px-1 text-xs text-[var(--muted)]">
                  MiniMax：{q.data.credentials.minimax.set ? "已配置 API key" : "未配置"} · 在
                  「外部平台」页管理（同样存进 config.db）
                </p>
              </>
            )}

            {active === "notify" && (
              <FeishuSection cred={q.data.credentials.feishu} onChanged={refresh} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-[var(--border)] bg-white p-4">
      <h2 className="text-sm font-semibold text-[var(--fg)]">{title}</h2>
      {hint && <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * One line saying where the value in effect actually comes from. `env` is the
 * one that matters: the form still saves, but the env var keeps winning — so
 * without this the user would edit a field, see "saved", and watch nothing
 * change.
 */
function SourceBadge({ cred, envVar }: { cred: Credential; envVar?: string }) {
  if (cred.source === "env") {
    return (
      <span className="text-xs text-amber-700">
        由 {envVar ?? "环境变量"} 接管 · 这里的设置暂不生效
      </span>
    );
  }
  if (cred.source === "file") {
    return (
      <span className="text-xs text-amber-700">
        仍在读旧的 JSON 文件 · 下次启动 serve 会自动迁进 config.db
      </span>
    );
  }
  if (cred.set) return <span className="text-xs text-emerald-700">已配置</span>;
  return <span className="text-xs text-[var(--muted)]">未配置</span>;
}

const inputCls =
  "h-9 w-full rounded-lg border border-[var(--border)] bg-white px-3 text-sm text-[var(--fg)] outline-none transition-colors placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)] disabled:bg-neutral-50 disabled:opacity-60";

const btnCls =
  "h-9 shrink-0 rounded-lg border border-[var(--border)] bg-white px-3 text-sm font-medium text-[var(--fg)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50";

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <label htmlFor={htmlFor} className="w-24 shrink-0 text-xs font-medium text-[var(--fg)]">
        {label}
      </label>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * The API merges a PATCH over the stored value, so a field we DON'T send keeps
 * its current value. That is what lets an empty key box mean "leave the saved
 * key alone" instead of "erase it".
 */
function useSaveCredential(name: CredName, onChanged: () => void) {
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      apiPatch<unknown>(`/api/settings/secret/${name}`, patch),
    onSuccess: onChanged,
  });
}

function useClearCredential(name: CredName, onChanged: () => void) {
  return useMutation({
    mutationFn: () => apiDelete<unknown>(`/api/settings/secret/${name}`),
    onSuccess: onChanged,
  });
}

function CredentialActions({
  cred,
  disabled,
  onSave,
  onClear,
  saving,
  error,
}: {
  cred: Credential;
  disabled?: boolean;
  onSave: () => void;
  onClear: () => void;
  saving: boolean;
  error: unknown;
}) {
  const [confirmClear, setConfirmClear] = useState(false);
  return (
    <>
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={onSave} disabled={disabled || saving} className={btnCls}>
          {saving ? "保存中…" : "保存"}
        </button>
        {cred.set && cred.source === "db" && (
          <button
            type="button"
            onClick={() => (confirmClear ? onClear() : setConfirmClear(true))}
            className="h-9 shrink-0 rounded-lg border border-red-200 bg-white px-3 text-sm font-medium text-red-700 transition-colors hover:bg-red-50"
          >
            {confirmClear ? "再点一次确认清除" : "清除"}
          </button>
        )}
      </div>
      {Boolean(error) && <p className="mt-2 text-xs text-red-700">{shortErr(error)}</p>}
    </>
  );
}

const LLM_PROVIDERS = [
  { id: "deepseek", label: "DeepSeek" },
  { id: "alibaba", label: "阿里云百炼" },
  { id: "moonshotai", label: "Moonshot" },
  { id: "openai", label: "OpenAI" },
  { id: "openai-compatible", label: "OpenAI 兼容" },
] as const;

function LlmChatSection({ cred, onChanged }: { cred: Credential; onChanged: () => void }) {
  const v = cred.values ?? {};
  const [provider, setProvider] = useState(String(v.provider ?? "deepseek"));
  const [baseURL, setBaseURL] = useState(String(v.baseURL ?? ""));
  const [model, setModel] = useState(String(v.model ?? ""));
  const [apiKey, setApiKey] = useState("");

  const save = useSaveCredential("llm-chat", onChanged);
  const clear = useClearCredential("llm-chat", onChanged);

  return (
    <Section
      title="AI 对话模型"
      hint="用于 AI 对话、工作回看叙事、主题命名。选「OpenAI 兼容」时必须填 Base URL。"
    >
      <div className="mb-3">
        <SourceBadge cred={cred} />
      </div>

      <div className="space-y-2.5">
        <Field label="服务商" htmlFor="llm-provider">
          <select
            id="llm-provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className={inputCls}
          >
            {LLM_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="模型" htmlFor="llm-model">
          <input
            id="llm-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="deepseek-chat"
            className={inputCls}
          />
        </Field>

        <Field label="Base URL" htmlFor="llm-base">
          <input
            id="llm-base"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder="留空用服务商默认值"
            className={`${inputCls} font-mono text-xs`}
          />
        </Field>

        <Field label="API Key" htmlFor="llm-key">
          <input
            id="llm-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={cred.set ? "已保存 · 留空则不改动" : "sk-…"}
            className={inputCls}
          />
        </Field>
      </div>

      <CredentialActions
        cred={cred}
        disabled={!model.trim()}
        saving={save.isPending}
        error={save.error}
        onSave={() =>
          save.mutate({
            provider,
            model: model.trim(),
            ...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
            // Omitted when blank → the server keeps the stored key.
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          })
        }
        onClear={() => clear.mutate()}
      />
    </Section>
  );
}

function GithubTokenSection({ cred, onChanged }: { cred: Credential; onChanged: () => void }) {
  const [token, setToken] = useState("");
  const save = useSaveCredential("github", onChanged);
  const clear = useClearCredential("github", onChanged);
  const envManaged = cred.source === "env";

  return (
    <Section title="GitHub Token" hint="用于 GitHub 镜像同步（repo / star / PR）。">
      <div className="mb-3">
        <SourceBadge cred={cred} envVar="GITHUB_TOKEN" />
      </div>
      <Field label="Token" htmlFor="gh-token">
        <input
          id="gh-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          disabled={envManaged}
          placeholder={cred.set ? "已保存 · 重新填写以替换" : "ghp_…"}
          className={inputCls}
        />
      </Field>
      <CredentialActions
        cred={cred}
        disabled={envManaged || !token.trim()}
        saving={save.isPending}
        error={save.error}
        onSave={() => save.mutate({ token: token.trim() })}
        onClear={() => clear.mutate()}
      />
    </Section>
  );
}

function WebSearchSection({ cred, onChanged }: { cred: Credential; onChanged: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const save = useSaveCredential("web-search", onChanged);
  const clear = useClearCredential("web-search", onChanged);
  const envManaged = cred.source === "env";

  return (
    <Section title="联网搜索（Brave）" hint="AI 对话里的 Web Search 工具。未配置则该工具关闭。">
      <div className="mb-3">
        <SourceBadge cred={cred} envVar="BRAVE_SEARCH_API_KEY" />
      </div>
      <Field label="API Key" htmlFor="brave-key">
        <input
          id="brave-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          disabled={envManaged}
          placeholder={cred.set ? "已保存 · 留空则不改动" : "BSA…"}
          className={inputCls}
        />
      </Field>
      <CredentialActions
        cred={cred}
        disabled={envManaged || !apiKey.trim()}
        saving={save.isPending}
        error={save.error}
        onSave={() => save.mutate({ provider: "brave", apiKey: apiKey.trim() })}
        onClear={() => clear.mutate()}
      />
    </Section>
  );
}

function RagEmbeddingSection({ cred, onChanged }: { cred: Credential; onChanged: () => void }) {
  const v = cred.values ?? {};
  const [baseURL, setBaseURL] = useState(String(v.baseURL ?? ""));
  const [model, setModel] = useState(String(v.model ?? ""));
  const [apiKey, setApiKey] = useState("");
  const save = useSaveCredential("rag-embedding", onChanged);
  const clear = useClearCredential("rag-embedding", onChanged);

  return (
    <Section
      title="RAG 向量化"
      hint="语料根目录仍在 ~/.ai2nao/rag.json —— 那不是密钥，没必要搬。这里只管 embedding。"
    >
      <div className="mb-3">
        <SourceBadge cred={cred} />
      </div>
      <div className="space-y-2.5">
        <Field label="模型" htmlFor="emb-model">
          <input
            id="emb-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="text-embedding-v4"
            className={inputCls}
          />
        </Field>
        <Field label="Base URL" htmlFor="emb-base">
          <input
            id="emb-base"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder="https://…/v1"
            className={`${inputCls} font-mono text-xs`}
          />
        </Field>
        <Field label="API Key" htmlFor="emb-key">
          <input
            id="emb-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={cred.set ? "已保存 · 留空则不改动" : "sk-…"}
            className={inputCls}
          />
        </Field>
      </div>
      <CredentialActions
        cred={cred}
        disabled={!model.trim() || !baseURL.trim()}
        saving={save.isPending}
        error={save.error}
        onSave={() =>
          save.mutate({
            enabled: true,
            model: model.trim(),
            baseURL: baseURL.trim(),
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          })
        }
        onClear={() => clear.mutate()}
      />
    </Section>
  );
}

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function FeishuSection({ cred, onChanged }: { cred: Credential; onChanged: () => void }) {
  const v = (cred.values ?? {}) as {
    daily?: { enabled?: boolean; atHour?: number };
    weekly?: { enabled?: boolean; atHour?: number; weekday?: number };
  };
  const [webhookUrl, setWebhookUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [dailyOn, setDailyOn] = useState(v.daily?.enabled !== false);
  const [dailyHour, setDailyHour] = useState(String(v.daily?.atHour ?? 21));
  const [weeklyOn, setWeeklyOn] = useState(v.weekly?.enabled !== false);
  const [weeklyHour, setWeeklyHour] = useState(String(v.weekly?.atHour ?? 9));
  const [weekday, setWeekday] = useState(String(v.weekly?.weekday ?? 1));

  const save = useSaveCredential("feishu", onChanged);
  const clear = useClearCredential("feishu", onChanged);

  return (
    <Section
      title="飞书推送"
      hint="日报每晚发当天回看，周报每周发上一个自然周。Webhook 是 ai2nao 唯一会把数据发出本机的地方。"
    >
      <div className="mb-3">
        <SourceBadge cred={cred} />
      </div>

      <div className="space-y-2.5">
        <Field label="Webhook" htmlFor="fs-hook">
          <input
            id="fs-hook"
            type="password"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder={
              cred.set ? "已保存 · 留空则不改动" : "https://open.feishu.cn/open-apis/bot/v2/hook/…"
            }
            className={inputCls}
          />
        </Field>
        <Field label="签名 secret" htmlFor="fs-secret">
          <input
            id="fs-secret"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={cred.set ? "已保存 · 留空则不改动" : "机器人开启签名校验时填"}
            className={inputCls}
          />
        </Field>

        <div className="flex items-center gap-3 border-t border-[var(--border)] pt-2.5">
          <label className="flex w-24 shrink-0 items-center gap-1.5 text-xs font-medium text-[var(--fg)]">
            <input
              type="checkbox"
              checked={dailyOn}
              onChange={(e) => setDailyOn(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            日报
          </label>
          <span className="text-xs text-[var(--muted)]">每天</span>
          <input
            type="number"
            min={0}
            max={23}
            aria-label="日报发送时刻"
            value={dailyHour}
            onChange={(e) => setDailyHour(e.target.value)}
            className="h-8 w-14 rounded-lg border border-[var(--border)] bg-white px-2 text-sm tabular-nums outline-none focus:border-[var(--accent)]"
          />
          <span className="text-xs text-[var(--muted)]">点</span>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex w-24 shrink-0 items-center gap-1.5 text-xs font-medium text-[var(--fg)]">
            <input
              type="checkbox"
              checked={weeklyOn}
              onChange={(e) => setWeeklyOn(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            周报
          </label>
          <span className="text-xs text-[var(--muted)]">每周</span>
          <select
            aria-label="周报发送星期"
            value={weekday}
            onChange={(e) => setWeekday(e.target.value)}
            className="h-8 rounded-lg border border-[var(--border)] bg-white px-2 text-sm outline-none focus:border-[var(--accent)]"
          >
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i + 1}>
                周{d}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={0}
            max={23}
            aria-label="周报发送时刻"
            value={weeklyHour}
            onChange={(e) => setWeeklyHour(e.target.value)}
            className="h-8 w-14 rounded-lg border border-[var(--border)] bg-white px-2 text-sm tabular-nums outline-none focus:border-[var(--accent)]"
          />
          <span className="text-xs text-[var(--muted)]">点</span>
        </div>
      </div>

      <CredentialActions
        cred={cred}
        // The webhook URL is the one thing this credential cannot exist without.
        disabled={!cred.set && !webhookUrl.trim()}
        saving={save.isPending}
        error={save.error}
        onSave={() =>
          save.mutate({
            feishu: {
              enabled: true,
              ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
              ...(secret.trim() ? { secret: secret.trim() } : {}),
            },
            daily: { enabled: dailyOn, atHour: Number(dailyHour) || 0 },
            weekly: {
              enabled: weeklyOn,
              atHour: Number(weeklyHour) || 0,
              weekday: Number(weekday) || 1,
            },
          })
        }
        onClear={() => clear.mutate()}
      />
    </Section>
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
            <li
              key={r}
              className="group flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-[var(--bg)]"
            >
              <Folder aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--muted)]" />
              <span
                className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--fg)]"
                title={r}
              >
                {r}
              </span>
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
          <label
            htmlFor="scan-depth"
            className="w-24 shrink-0 text-xs font-medium text-[var(--fg)]"
          >
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
          <span className="text-xs text-[var(--muted)]">
            篇（docs/ 下 markdown，超出按设计跳过，不算错误）。
          </span>
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
