import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "../api";

type BashSandboxMode = "off" | "best-effort" | "required";

type BashSandboxFilesystemPolicy = {
  allowWrite: string[];
  denyWrite: string[];
  denyRead: string[];
  allowRead: string[];
};

type BashSandboxNetworkPolicy = {
  allowedDomains: string[];
  deniedDomains: string[];
};

type BashSandboxConfig = {
  version: 1;
  mode: BashSandboxMode;
  filesystem: BashSandboxFilesystemPolicy;
  network: BashSandboxNetworkPolicy;
};

type BashSandboxStatus = {
  configPath: string;
  configured: boolean;
  config: BashSandboxConfig;
  effectivePolicy: {
    filesystem: BashSandboxFilesystemPolicy;
    network: BashSandboxNetworkPolicy;
  };
  dependencies: {
    supportedPlatform: boolean;
    ok: boolean;
    warnings: string[];
    errors: string[];
  };
  error: string | null;
};

type Draft = {
  mode: BashSandboxMode;
  allowWrite: string;
  denyWrite: string;
  denyRead: string;
  allowRead: string;
  allowedDomains: string;
  deniedDomains: string;
};

const MODE_LABELS: Record<BashSandboxMode, string> = {
  off: "关闭",
  "best-effort": "尽力沙箱",
  required: "强制沙箱",
};

const EMPTY_DRAFT: Draft = {
  mode: "off",
  allowWrite: "",
  denyWrite: "",
  denyRead: "",
  allowRead: "",
  allowedDomains: "",
  deniedDomains: "",
};

export function BashSandboxSettings() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [dirty, setDirty] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const statusQ = useQuery({
    queryKey: ["bash-sandbox-status"],
    queryFn: () => apiGet<BashSandboxStatus>("/api/bash-sandbox/status"),
  });

  useEffect(() => {
    if (!statusQ.data || dirty) return;
    setDraft(draftFromConfig(statusQ.data.config));
  }, [dirty, statusQ.data]);

  const save = useMutation<BashSandboxStatus, Error, BashSandboxConfig>({
    mutationFn: (config) => apiPost<BashSandboxStatus>("/api/bash-sandbox/config", config),
    onSuccess: async (status) => {
      await queryClient.invalidateQueries({ queryKey: ["bash-sandbox-status"] });
      setDraft(draftFromConfig(status.config));
      setDirty(false);
      setFormError(null);
    },
  });

  const parsedConfig = useMemo(() => configFromDraft(draft), [draft]);
  const pathCounts = useMemo(
    () => ({
      allowWrite: parsedConfig.filesystem.allowWrite.length,
      denyWrite: parsedConfig.filesystem.denyWrite.length,
      denyRead: parsedConfig.filesystem.denyRead.length,
      allowRead: parsedConfig.filesystem.allowRead.length,
      domains: parsedConfig.network.allowedDomains.length,
    }),
    [parsedConfig]
  );

  function updateDraft(next: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...next }));
    setDirty(true);
    setFormError(null);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const config = configFromDraft(draft);
    const validationError = validateConfig(config);
    if (validationError) {
      setFormError(validationError);
      return;
    }
    save.mutate(config);
  }

  function resetDraft() {
    if (!statusQ.data) return;
    setDraft(draftFromConfig(statusQ.data.config));
    setDirty(false);
    setFormError(null);
    save.reset();
  }

  const status = statusQ.data;
  const dependencyTone: Tone = !status ? "default" : status.dependencies.ok ? "ok" : "bad";

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-xl font-semibold">Shell 沙箱</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            配置 AI Shell 命令的 OS 级沙箱模式、文件系统边界和网络域名边界。
          </p>
        </div>
        <div className="grid min-w-[600px] grid-cols-4 gap-3">
          <Metric label="模式" value={MODE_LABELS[draft.mode]} tone={draft.mode === "required" ? "ok" : "default"} />
          <Metric label="写入路径" value={String(pathCounts.allowWrite)} />
          <Metric label="拒读路径" value={String(pathCounts.denyRead)} tone={pathCounts.denyRead > 0 ? "ok" : "warn"} />
          <Metric label="依赖" value={status ? (status.dependencies.ok ? "可用" : "不可用") : "..."} tone={dependencyTone} />
        </div>
      </header>

      {statusQ.isLoading ? (
        <div className="rounded border border-[var(--border)] bg-white px-4 py-8 text-sm text-[var(--muted)]">
          加载沙箱配置...
        </div>
      ) : statusQ.error ? (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {String(statusQ.error.message)}
        </div>
      ) : status ? (
        <form onSubmit={submit} className="grid grid-cols-[minmax(23rem,0.8fr)_minmax(42rem,1.4fr)] gap-5">
          <aside className="space-y-5">
            <section className="rounded border border-[var(--border)] bg-white">
              <div className="border-b border-[var(--border)] px-4 py-3">
                <div className="text-sm font-medium">运行模式</div>
                <div className="mt-1 break-all font-mono text-xs text-[var(--muted)]">{status.configPath}</div>
              </div>
              <div className="grid gap-3 p-4">
                <ModeOption
                  mode="off"
                  selected={draft.mode}
                  title="关闭"
                  body="命令仍走审批和规则系统，但不套 OS 沙箱。"
                  onSelect={(mode) => updateDraft({ mode })}
                />
                <ModeOption
                  mode="best-effort"
                  selected={draft.mode}
                  title="尽力沙箱"
                  body="依赖可用时套沙箱；不可用时继续执行并返回 debug 信息。"
                  onSelect={(mode) => updateDraft({ mode })}
                />
                <ModeOption
                  mode="required"
                  selected={draft.mode}
                  title="强制沙箱"
                  body="依赖不可用或包装失败时拒绝执行命令。"
                  onSelect={(mode) => updateDraft({ mode })}
                />
              </div>
            </section>

            <section className="rounded border border-[var(--border)] bg-white">
              <div className="border-b border-[var(--border)] px-4 py-3">
                <div className="text-sm font-medium">运行时依赖</div>
                <div className="mt-1 text-xs text-[var(--muted)]">
                  {status.dependencies.supportedPlatform ? "当前平台支持" : "当前平台不支持"}
                </div>
              </div>
              <div className="grid gap-3 p-4 text-sm">
                <StatusLine label="可用状态" value={status.dependencies.ok ? "可用" : "不可用"} tone={dependencyTone} />
                <StatusList label="错误" items={status.dependencies.errors} tone="bad" empty="无错误" />
                <StatusList label="警告" items={status.dependencies.warnings} tone="warn" empty="无警告" />
                {status.error ? (
                  <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    {status.error}
                  </div>
                ) : null}
              </div>
            </section>
          </aside>

          <main className="rounded border border-[var(--border)] bg-white">
            <div className="border-b border-[var(--border)] px-4 py-3">
              <div className="flex items-start justify-between gap-5">
                <div>
                  <div className="text-sm font-medium">策略</div>
                  <div className="mt-1 text-xs text-[var(--muted)]">
                    每行一个路径或域名；空列表表示该方向没有额外放行。
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={resetDraft}
                    disabled={!dirty || save.isPending}
                    className="h-9 rounded border border-[var(--border)] px-4 text-sm text-[var(--fg)] hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    还原
                  </button>
                  <button
                    type="submit"
                    disabled={save.isPending}
                    className="h-9 rounded bg-[var(--accent)] px-4 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {save.isPending ? "保存中..." : "保存配置"}
                  </button>
                </div>
              </div>
            </div>

            {formError ?? save.error ? (
              <div className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {formError ?? save.error?.message}
              </div>
            ) : null}
            {save.isSuccess && !dirty ? (
              <div className="border-b border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                配置已保存。
              </div>
            ) : null}

            <div className="grid gap-5 p-4">
              <section>
                <h2 className="text-sm font-medium">文件系统</h2>
                <div className="mt-3 grid grid-cols-2 gap-4">
                  <PolicyTextarea
                    label="允许写入"
                    value={draft.allowWrite}
                    placeholder="."
                    onChange={(value) => updateDraft({ allowWrite: value })}
                  />
                  <PolicyTextarea
                    label="拒绝写入"
                    value={draft.denyWrite}
                    placeholder=".env"
                    onChange={(value) => updateDraft({ denyWrite: value })}
                  />
                  <PolicyTextarea
                    label="拒绝读取"
                    value={draft.denyRead}
                    placeholder="~/.ssh"
                    onChange={(value) => updateDraft({ denyRead: value })}
                  />
                  <PolicyTextarea
                    label="允许读取"
                    value={draft.allowRead}
                    placeholder="."
                    onChange={(value) => updateDraft({ allowRead: value })}
                  />
                </div>
              </section>

              <section>
                <h2 className="text-sm font-medium">网络</h2>
                <div className="mt-3 grid grid-cols-2 gap-4">
                  <PolicyTextarea
                    label="允许域名"
                    value={draft.allowedDomains}
                    placeholder="api.github.com"
                    onChange={(value) => updateDraft({ allowedDomains: value })}
                  />
                  <PolicyTextarea
                    label="拒绝域名"
                    value={draft.deniedDomains}
                    placeholder="*.tracking.example"
                    onChange={(value) => updateDraft({ deniedDomains: value })}
                  />
                </div>
              </section>

              <section>
                <h2 className="text-sm font-medium">生效预览</h2>
                <pre className="mt-3 max-h-80 overflow-auto rounded border border-[var(--border)] bg-neutral-50 p-3 font-mono text-xs leading-5 text-[var(--fg)]">
                  {JSON.stringify(parsedConfig, null, 2)}
                </pre>
              </section>
            </div>
          </main>
        </form>
      ) : null}
    </div>
  );
}

function ModeOption({
  mode,
  selected,
  title,
  body,
  onSelect,
}: {
  mode: BashSandboxMode;
  selected: BashSandboxMode;
  title: string;
  body: string;
  onSelect: (mode: BashSandboxMode) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(mode)}
      className={
        "rounded border px-3 py-2 text-left hover:bg-blue-50 " +
        (selected === mode ? "border-[var(--accent)] bg-blue-50" : "border-[var(--border)] bg-white")
      }
    >
      <span className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-[var(--fg)]">{title}</span>
        <span className="font-mono text-xs text-[var(--muted)]">{mode}</span>
      </span>
      <span className="mt-1 block text-xs leading-5 text-[var(--muted)]">{body}</span>
    </button>
  );
}

function PolicyTextarea({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-xs text-[var(--muted)]">
      {label}
      <textarea
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="mt-1 min-h-32 w-full resize-y rounded border border-[var(--border)] px-3 py-2 font-mono text-xs leading-5 text-[var(--fg)]"
        placeholder={placeholder}
      />
    </label>
  );
}

function StatusLine({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded border border-[var(--border)] px-3 py-2">
      <span className="text-xs text-[var(--muted)]">{label}</span>
      <span className={toneClass(tone)}>{value}</span>
    </div>
  );
}

function StatusList({
  label,
  items,
  tone,
  empty,
}: {
  label: string;
  items: string[];
  tone: Tone;
  empty: string;
}) {
  return (
    <div className="rounded border border-[var(--border)] px-3 py-2">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      {items.length > 0 ? (
        <ul className={`mt-2 list-disc space-y-1 pl-4 text-xs ${toneClass(tone)}`}>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <div className="mt-2 text-xs text-[var(--muted)]">{empty}</div>
      )}
    </div>
  );
}

type Tone = "default" | "ok" | "warn" | "bad";

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded border border-[var(--border)] bg-white px-3 py-2">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className={`mt-1 truncate text-lg font-semibold ${toneClass(tone)}`}>{value}</div>
    </div>
  );
}

function toneClass(tone: Tone): string {
  if (tone === "ok") return "text-emerald-700";
  if (tone === "warn") return "text-amber-700";
  if (tone === "bad") return "text-red-700";
  return "text-[var(--fg)]";
}

function draftFromConfig(config: BashSandboxConfig): Draft {
  return {
    mode: config.mode,
    allowWrite: linesFromList(config.filesystem.allowWrite),
    denyWrite: linesFromList(config.filesystem.denyWrite),
    denyRead: linesFromList(config.filesystem.denyRead),
    allowRead: linesFromList(config.filesystem.allowRead),
    allowedDomains: linesFromList(config.network.allowedDomains),
    deniedDomains: linesFromList(config.network.deniedDomains),
  };
}

function configFromDraft(draft: Draft): BashSandboxConfig {
  return {
    version: 1,
    mode: draft.mode,
    filesystem: {
      allowWrite: listFromLines(draft.allowWrite),
      denyWrite: listFromLines(draft.denyWrite),
      denyRead: listFromLines(draft.denyRead),
      allowRead: listFromLines(draft.allowRead),
    },
    network: {
      allowedDomains: listFromLines(draft.allowedDomains),
      deniedDomains: listFromLines(draft.deniedDomains),
    },
  };
}

function validateConfig(config: BashSandboxConfig): string | null {
  if (config.mode !== "off" && config.filesystem.allowWrite.length === 0) {
    return "开启沙箱时至少保留一个允许写入路径。";
  }
  return null;
}

function listFromLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

function linesFromList(value: string[]): string {
  return value.join("\n");
}
