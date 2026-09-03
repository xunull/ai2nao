import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Bell, BookOpen, Bot, Database, Folder, Layers, Plus, Sliders, X } from "lucide-react";
import { apiDelete, apiGet, apiPatch } from "../api";
import { TaxonomyEditor } from "./settings/TaxonomyEditor";
import { RagCorpusSection } from "./settings/RagCorpusSection";
// 与 /ai-chat 共用同一份 status 契约 —— 两处各抄一份就会悄悄漂开。
import type { LlmChatStatus } from "../aiChat/types";

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

/** A non-secret setting — same shape as Credential but `values` comes back
 * verbatim (nothing to redact). */
type Setting = {
  set: boolean;
  source: "db" | "file" | null;
  label: string;
  values: Record<string, unknown> | null;
};

type SettingsRes = {
  scanRoots: string[];
  scanMaxDepth: number;
  scanMaxDocs: number;
  scanConcurrency: number;
  replayGapMinutes: number;
  github: { set: boolean; source: CredSource };
  credentials: Record<CredName, Credential>;
  settings: { "rag-corpus": Setting };
};

function shortErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const CATEGORIES = [
  { id: "general", label: "通用", icon: Sliders },
  { id: "topics", label: "主题分类", icon: Layers },
  { id: "ai", label: "AI 与模型", icon: Bot },
  { id: "rag", label: "RAG 知识库", icon: BookOpen },
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
              <>
                <ScanRootsSection
                  roots={q.data.scanRoots}
                  maxDepth={q.data.scanMaxDepth}
                  maxDocs={q.data.scanMaxDocs}
                  concurrency={q.data.scanConcurrency}
                  onChanged={refresh}
                />
                <ReplayGapSection gapMinutes={q.data.replayGapMinutes} onChanged={refresh} />
              </>
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

            {active === "rag" && (
              <>
                {/* RAG's embedding form lives here now, MOVED (not copied) from
                    数据源 — two forms PATCHing the same rag-embedding credential
                    would fight. */}
                <RagEmbeddingSection
                  cred={q.data.credentials["rag-embedding"]}
                  onChanged={refresh}
                />
                <RagCorpusSection setting={q.data.settings["rag-corpus"]} onChanged={refresh} />
              </>
            )}

            {active === "sources" && (
              <>
                <GithubTokenSection cred={q.data.credentials.github} onChanged={refresh} />
                <WebSearchSection cred={q.data.credentials["web-search"]} onChanged={refresh} />
                {/* Footnotes, not forms: these credentials are edited elsewhere,
                    and a full card each would push this category past one screen. */}
                <p className="px-1 text-xs text-[var(--muted)]">
                  MiniMax：{q.data.credentials.minimax.set ? "已配置 API key" : "未配置"} · 在
                  「外部平台」页管理（同样存进 config.db）
                </p>
                <p className="px-1 text-xs text-[var(--muted)]">
                  RAG 向量化与语料库移到了左边「RAG 知识库」分类。
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

/**
 * **只是 id → 中文标签。清单本身由后端给**(`availableProviders`)。
 *
 * 以前这里是一份硬编码的服务商清单,后端加一家而这里忘了加,那家在下拉里
 * 压根不存在 —— 功能静默不可用,tsc 不管、测试全绿。现在漏一个标签的后果
 * 降级成「显示原始 id」,丑但可选可用。同形于 AiSessions 的 coverage.sources。
 */
const PROVIDER_LABELS: Record<string, string> = {
  deepseek: "DeepSeek",
  alibaba: "阿里云百炼",
  moonshotai: "Moonshot（Kimi）",
  openai: "OpenAI",
  "openai-compatible": "OpenAI 兼容",
  volcengine: "火山方舟",
  minimax: "MiniMax",
};

const CRED_SOURCE_TEXT: Record<string, string> = {
  config: "已配置",
  env: "环境变量",
  "none-needed": "无需 key",
  none: "未配 key",
};

function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id;
}

type ModelDraft = { model: string; label: string };

/** 一个厂商实例的可编辑副本。`hasKey` 来自后端脱敏(只有布尔,没有原文)。 */
type ProviderDraft = {
  id: string;
  provider: string;
  label: string;
  baseURL: string;
  enabled: boolean;
  models: ModelDraft[];
  hasKey: boolean;
  /** 用户这次新输入的 key。空 = 别动已存的那把。 */
  keyDraft: string;
};

type DefaultRef = { providerId: string; model: string } | null;

/**
 * 从后端(已脱敏的)凭据值里读出可编辑的厂商列表。
 *
 * 只认新形状:`parseLlmChatDocument` 已经在服务端把三种历史形状全部归一成
 * `providers{}`,前端不再需要认识旧形状。搬运必须在服务端做 —— 脱敏后前端
 * 手上根本没有密钥原文,搬不动它。
 */
function providersFromValues(v: Record<string, unknown>): ProviderDraft[] {
  const raw = v.providers;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>).flatMap(([id, val]) => {
    if (typeof val !== "object" || val === null) return [];
    const o = val as Record<string, unknown>;
    const provider = typeof o.provider === "string" ? o.provider : "openai-compatible";
    return [
      {
        id,
        provider,
        // 服务端存的默认名是 provider id(不本地化,那是前端的事)。
        // 这里把「没被用户改过」的那种升级成中文名 —— 否则左栏显示「DeepSeek」
        // 而名称框显示「deepseek」,同一屏两种写法。用户自起的名原样保留。
        label:
          typeof o.label === "string" && o.label !== provider ? o.label : providerLabel(provider),
        baseURL: typeof o.baseURL === "string" ? o.baseURL : "",
        enabled: o.enabled !== false,
        models: Array.isArray(o.models)
          ? (o.models as Record<string, unknown>[]).flatMap((m) =>
              m && typeof m.model === "string"
                ? [{ model: m.model, label: typeof m.label === "string" ? m.label : m.model }]
                : []
            )
          : [],
        hasKey: o.hasKey === true,
        keyDraft: "",
      },
    ];
  });
}

function defaultFromValues(v: Record<string, unknown>): DefaultRef {
  const d = v.defaultModel;
  if (typeof d !== "object" || d === null) return null;
  const o = d as Record<string, unknown>;
  return typeof o.providerId === "string" && typeof o.model === "string"
    ? { providerId: o.providerId, model: o.model }
    : null;
}

/** 新实例 id:优先用适配器 id,占用了就加后缀。id 不含冒号(视图 id 靠它切分)。 */
function newProviderId(provider: string, taken: string[]): string {
  if (!taken.includes(provider)) return provider;
  for (let i = 2; ; i += 1) {
    const id = `${provider}-${i}`;
    if (!taken.includes(id)) return id;
  }
}

function LlmChatSection({ cred, onChanged }: { cred: Credential; onChanged: () => void }) {
  const v = cred.values ?? {};
  const [drafts, setDrafts] = useState<ProviderDraft[]>(() => providersFromValues(v));
  const [defaultRef, setDefaultRef] = useState<DefaultRef>(() => defaultFromValues(v));
  /** providers 是 map:省略等于「别动」,所以删除必须显式发 null。 */
  const [deleted, setDeleted] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(
    () => providersFromValues(v)[0]?.id ?? null
  );

  const save = useSaveCredential("llm-chat", onChanged);
  const clear = useClearCredential("llm-chat", onChanged);

  // 服务商清单与可用性由后端给,前端不再自己维护 —— 后端加一家这里自动出现。
  const status = useQuery({
    queryKey: ["llm-chat-status"],
    queryFn: () => apiGet<LlmChatStatus>("/api/llm-chat/status"),
  });
  // 先兜底再 map:响应形状不能假设(旧后端、代理改写、测试桩都可能少字段),
  // 而这个区块崩了会连带整个设置页白屏 —— 一个可选的状态查询不该有这种爆炸半径。
  const adapters = Array.isArray(status.data?.availableProviders)
    ? status.data.availableProviders
    : [];
  /** 服务端对「这家到底有没有 key」的判断(含环境变量),比本地 hasKey 权威。 */
  const serverView = new Map(
    (Array.isArray(status.data?.providers) ? status.data.providers : []).map(
      (p) => [p.id, p] as const
    )
  );

  const selected = drafts.find((d) => d.id === selectedId) ?? null;

  const patchDraft = (id: string, next: Partial<ProviderDraft>) =>
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...next } : d)));

  const addProvider = () => {
    const adapter = adapters[0]?.id ?? "deepseek";
    const id = newProviderId(adapter, drafts.map((d) => d.id));
    setDrafts((prev) => [
      ...prev,
      {
        id,
        provider: adapter,
        label: providerLabel(adapter),
        baseURL: adapters[0]?.defaultBaseURL ?? "",
        enabled: true,
        models: [],
        hasKey: false,
        keyDraft: "",
      },
    ]);
    // 刚建出来时它还没有模型;左栏必须仍然看得见它,否则用户会以为没添加成功。
    setDeleted((prev) => prev.filter((x) => x !== id));
    setSelectedId(id);
  };

  const removeProvider = (id: string) => {
    setDrafts((prev) => prev.filter((d) => d.id !== id));
    setDeleted((prev) => (prev.includes(id) ? prev : [...prev, id]));
    if (selectedId === id) setSelectedId(null);
  };

  const addModel = (id: string) =>
    setDrafts((prev) =>
      prev.map((d) => (d.id === id ? { ...d, models: [...d.models, { model: "", label: "" }] } : d))
    );

  const patchModel = (id: string, idx: number, next: Partial<ModelDraft>) =>
    setDrafts((prev) =>
      prev.map((d) =>
        d.id === id
          ? { ...d, models: d.models.map((m, i) => (i === idx ? { ...m, ...next } : m)) }
          : d
      )
    );

  const removeModel = (id: string, idx: number) =>
    setDrafts((prev) =>
      prev.map((d) =>
        d.id === id ? { ...d, models: d.models.filter((_, i) => i !== idx) } : d
      )
    );

  /**
   * 默认项不能被删 —— 要先把默认设到别处。
   *
   * 删掉它会让 defaultModel 落空,而后端会回落到「第一个启用的实例的第一条」:
   * 每日摘要 / 话题命名 / 工作回顾就此静默换了一家模型,还在花另一家的钱。
   * 与 resolveLlmChatConfig 拒绝为「默认实例被关掉」回落是同一条原则。
   */
  const isDefaultModel = (providerId: string, model: string) =>
    defaultRef?.providerId === providerId && defaultRef.model === model;
  const holdsDefault = (d: ProviderDraft) =>
    defaultRef?.providerId === d.id && d.models.some((m) => m.model === defaultRef.model);

  /**
   * PATCH 的词汇表是 `providers.<id>.<字段>`。
   * mergePatch 对**对象**递归合并(省略即保留),对**数组**整体替换 ——
   * 所以 models 必须发完整数组(发一半等于删掉另一半),而删掉一整个厂商
   * 必须显式发 null(省略只会被当成「别动」)。
   */
  const onSave = () => {
    const providers: Record<string, unknown> = {};
    for (const d of drafts) {
      providers[d.id] = {
        provider: d.provider,
        label: d.label.trim() || providerLabel(d.provider),
        baseURL: d.baseURL.trim(),
        enabled: d.enabled,
        models: d.models
          .filter((m) => m.model.trim())
          .map((m) => ({ model: m.model.trim(), label: m.label.trim() || m.model.trim() })),
        // 只在用户真输入了才发:留空 = 别动已存的那把(前端拿不到原文,发空串就是清掉)。
        ...(d.keyDraft.trim() ? { apiKey: d.keyDraft.trim() } : {}),
      };
    }
    for (const id of deleted) providers[id] = null;
    save.mutate({ defaultModel: defaultRef, providers });
  };

  const incomplete = drafts.some((d) => !d.baseURL.trim());
  const defaultDisabled = status.data?.defaultDisabled === true;

  return (
    <Section
      title="AI 对话模型"
      hint="按服务商配置：一家一把密钥，底下挂多个模型。对话时随时切换。"
    >
      <div className="mb-3">
        <SourceBadge cred={cred} />
      </div>

      {defaultDisabled && (
        <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          默认模型所在的服务商已关闭。每日摘要、话题命名、工作回顾会停用，
          <strong>RAG 向量化会直接报错</strong>。请重新启用它，或把默认模型设到别家。
        </p>
      )}

      <div className="flex gap-3">
        {/* 左栏：厂商。含 0 模型的和已关闭的 —— 那两种状态恰恰最需要被看见。 */}
        <div className="w-48 shrink-0">
          <ul className="max-h-72 overflow-y-auto rounded-lg border border-neutral-200">
            {drafts.length === 0 ? (
              <li className="px-3 py-4 text-center text-xs text-[var(--muted)]">
                还没有服务商
              </li>
            ) : (
              drafts.map((d) => {
                const sv = serverView.get(d.id);
                const source = sv?.credentialSource ?? (d.hasKey ? "config" : "none");
                return (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(d.id)}
                      className={`w-full border-b border-neutral-100 px-3 py-2 text-left last:border-b-0 ${
                        selectedId === d.id ? "bg-neutral-100" : "hover:bg-neutral-50"
                      }`}
                    >
                      <span
                        className={`block truncate text-sm ${
                          d.enabled ? "text-[var(--fg)]" : "text-[var(--muted)] line-through"
                        }`}
                      >
                        {/* 迁移出来的实例名就是 provider id(如 "deepseek"),直接显示是个
                            生字符串。providerLabel 对未知值原样返回,所以用户自己起的
                            名字("我的代理")照常穿过去。 */}
                        {providerLabel(d.label) || d.id}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
                        <span
                          className={
                            source === "none" ? "text-amber-800" : "text-emerald-800"
                          }
                        >
                          {CRED_SOURCE_TEXT[source] ?? source}
                        </span>
                        <span>·</span>
                        <span>{d.models.length} 个模型</span>
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
          <button
            type="button"
            onClick={addProvider}
            className="mt-2 text-xs text-[var(--accent)] hover:underline"
          >
            + 添加服务商
          </button>
        </div>

        {/* 右栏：选中厂商的详情。 */}
        <div className="min-w-0 flex-1">
          {!selected ? (
            <p className="rounded-lg border border-dashed border-neutral-300 px-3 py-8 text-center text-xs text-[var(--muted)]">
              {drafts.length === 0 ? "点左边的「添加服务商」开始。" : "从左边选一个服务商。"}
            </p>
          ) : (
            <div className="space-y-2 rounded-lg border border-neutral-200 px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-1.5 text-xs text-[var(--fg)]">
                  <input
                    type="checkbox"
                    checked={selected.enabled}
                    onChange={(e) => patchDraft(selected.id, { enabled: e.target.checked })}
                  />
                  启用
                </label>
                {holdsDefault(selected) ? (
                  <span
                    className="text-xs text-[var(--muted)]"
                    title="默认模型在这家名下，先把默认设到别家再删"
                  >
                    含默认模型，不可删
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => removeProvider(selected.id)}
                    className="text-xs text-red-700 hover:underline"
                  >
                    删除这个服务商
                  </button>
                )}
              </div>

              <Field label="名称" htmlFor={`p-label-${selected.id}`}>
                <input
                  id={`p-label-${selected.id}`}
                  value={selected.label}
                  onChange={(e) => patchDraft(selected.id, { label: e.target.value })}
                  placeholder="显示用，可自定义"
                  className={inputCls}
                />
              </Field>

              <Field label="接口类型" htmlFor={`p-adapter-${selected.id}`}>
                <select
                  id={`p-adapter-${selected.id}`}
                  value={selected.provider}
                  onChange={(e) => {
                    const next = e.target.value;
                    const base = adapters.find((a) => a.id === next)?.defaultBaseURL ?? "";
                    // 换接口类型时预填地址,少一次手敲(火山那串 ark 路径没人记得住)。
                    patchDraft(selected.id, { provider: next, baseURL: base });
                  }}
                  className={inputCls}
                >
                  {adapters.map((a) => (
                    <option key={a.id} value={a.id}>
                      {providerLabel(a.id)}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Base URL" htmlFor={`p-base-${selected.id}`}>
                <input
                  id={`p-base-${selected.id}`}
                  value={selected.baseURL}
                  onChange={(e) => patchDraft(selected.id, { baseURL: e.target.value })}
                  placeholder="选接口类型时自动预填"
                  className={`${inputCls} font-mono text-xs`}
                />
              </Field>

              <Field label="API Key" htmlFor={`p-key-${selected.id}`}>
                <input
                  id={`p-key-${selected.id}`}
                  type="password"
                  value={selected.keyDraft}
                  onChange={(e) => patchDraft(selected.id, { keyDraft: e.target.value })}
                  placeholder={selected.hasKey ? "已保存 · 留空则不改动" : "sk-…"}
                  className={inputCls}
                />
              </Field>

              <div className="border-t border-neutral-100 pt-2">
                <h4 className="mb-1.5 text-xs font-medium text-[var(--fg)]">模型</h4>
                {selected.models.length === 0 ? (
                  <p className="text-xs text-[var(--muted)]">还没有模型。</p>
                ) : (
                  <ul className="space-y-1.5">
                    {selected.models.map((m, i) => {
                      const isDefault = isDefaultModel(selected.id, m.model);
                      return (
                        <li key={i} className="flex items-center gap-2">
                          <input
                            type="radio"
                            name="llm-default-model"
                            checked={isDefault}
                            disabled={!m.model.trim()}
                            onChange={() =>
                              setDefaultRef({ providerId: selected.id, model: m.model })
                            }
                            aria-label={`把「${m.label || m.model || "未命名"}」设为默认`}
                          />
                          <input
                            value={m.model}
                            onChange={(e) => patchModel(selected.id, i, { model: e.target.value })}
                            placeholder="deepseek-v4-flash"
                            aria-label="模型 ID"
                            className={`${inputCls} min-w-0 flex-1 font-mono text-xs`}
                          />
                          <input
                            value={m.label}
                            onChange={(e) => patchModel(selected.id, i, { label: e.target.value })}
                            placeholder="显示名（留空用模型 ID）"
                            aria-label="模型显示名"
                            className={`${inputCls} min-w-0 flex-1`}
                          />
                          {isDefault ? (
                            <span className="shrink-0 text-xs text-[var(--muted)]" title="它是默认模型，先把默认设到别的模型上再删">
                              默认项
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => removeModel(selected.id, i)}
                              aria-label={`删除模型「${m.label || m.model || "未命名"}」`}
                              className="shrink-0 text-xs text-red-700 hover:underline"
                            >
                              删除
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <button
                  type="button"
                  onClick={() => addModel(selected.id)}
                  className="mt-1.5 text-xs text-[var(--accent)] hover:underline"
                >
                  + 添加模型
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <CredentialActions
        cred={cred}
        disabled={incomplete || (drafts.length === 0 && deleted.length === 0)}
        saving={save.isPending}
        error={save.error}
        onSave={onSave}
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
      hint="向量化用的模型与 API Key。语料根目录在下面「语料库」里管。"
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

/**
 * 「那天回放」隔多久算两段工作。
 *
 * 只有一个数字，所以没有「保存」按钮 —— 失焦即提交，和上面几个扫描参数一致。越界的输入
 * 本地就弹回原值：服务端也会拒（400），但让一个必然失败的请求飞出去只换来一条红字。
 */
function ReplayGapSection({
  gapMinutes,
  onChanged,
}: {
  gapMinutes: number;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState(String(gapMinutes));

  const save = useMutation({
    mutationFn: (n: number) => apiPatch<SettingsRes>("/api/settings", { replayGapMinutes: n }),
    onSuccess: () => onChanged(),
  });

  return (
    <Section
      title="那天回放"
      hint="提交和对话按时间排成一条流，相邻两件事隔得够久就断成两段工作。"
    >
      <div className="flex items-center gap-2">
        <label htmlFor="replay-gap" className="w-24 shrink-0 text-xs font-medium text-[var(--fg)]">
          分段间隔
        </label>
        <input
          id="replay-gap"
          type="number"
          min={1}
          max={1440}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const n = Number(draft);
            if (Number.isInteger(n) && n >= 1 && n <= 1440 && n !== gapMinutes) save.mutate(n);
            else setDraft(String(gapMinutes));
          }}
          className="h-8 w-20 rounded-lg border border-[var(--border)] bg-white px-2 text-sm tabular-nums text-[var(--fg)] outline-none transition-colors focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
        />
        <span className="text-xs text-[var(--muted)]">
          分钟（默认 120 · 调小切得更碎，调大合并成整块）。
        </span>
        {save.isError && <span className="text-xs text-red-600">{shortErr(save.error)}</span>}
      </div>
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
