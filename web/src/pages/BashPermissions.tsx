import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "../api";

type BashPermissionBehavior = "allow" | "ask" | "deny";
type BashPermissionRuleType = "exact" | "prefix" | "wildcard";
type BashPermissionRuleScopeType = "global" | "directory";

type BashPermissionRule = {
  id: string;
  behavior: BashPermissionBehavior;
  ruleType: BashPermissionRuleType;
  ruleContent: string;
  scopeType: BashPermissionRuleScopeType;
  scopeValue: string;
  source: "user" | "suggested" | "remote" | "system";
  note: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  useCount: number;
};

type BashPermissionRulesRes = {
  rules: BashPermissionRule[];
};

type BashPermissionRuleRes = {
  rule: BashPermissionRule;
};

type BehaviorFilter = BashPermissionBehavior | "all";

type RuleGroup = {
  key: string;
  label: string;
  scopeType: BashPermissionRuleScopeType;
  scopeValue: string;
  rules: BashPermissionRule[];
};

type RuleFormDraft = {
  behavior: BashPermissionBehavior;
  ruleType: BashPermissionRuleType;
  ruleContent: string;
  scopeType: BashPermissionRuleScopeType;
  scopeValue: string;
  note: string;
};

type EditorState =
  | { mode: "create"; draft: RuleFormDraft }
  | { mode: "edit"; rule: BashPermissionRule; draft: RuleFormDraft };

const BEHAVIOR_LABELS: Record<BehaviorFilter, string> = {
  allow: "允许",
  ask: "询问",
  deny: "拒绝",
  all: "全部",
};

const TYPE_LABELS: Record<BashPermissionRuleType, string> = {
  exact: "精确",
  prefix: "前缀",
  wildcard: "通配",
};

const EMPTY_DRAFT: RuleFormDraft = {
  behavior: "allow",
  ruleType: "exact",
  ruleContent: "",
  scopeType: "directory",
  scopeValue: "",
  note: "",
};

export function BashPermissions() {
  const queryClient = useQueryClient();
  const [behavior, setBehavior] = useState<BehaviorFilter>("allow");
  const [q, setQ] = useState("");
  const [selectedGroupKey, setSelectedGroupKey] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const rulesQ = useQuery({
    queryKey: ["bash-permission-rules", behavior],
    queryFn: () =>
      apiGet<BashPermissionRulesRes>(
        `/api/bash-permission-rules${behavior === "all" ? "" : `?behavior=${behavior}`}`
      ),
  });

  const saveRule = useMutation<BashPermissionRuleRes, Error, { id?: string; draft: RuleFormDraft }>({
    mutationFn: ({ id, draft }) => {
      const payload = rulePayloadFromDraft(draft);
      return id
        ? apiPatch<BashPermissionRuleRes>(`/api/bash-permission-rules/${id}`, payload)
        : apiPost<BashPermissionRuleRes>("/api/bash-permission-rules", payload);
    },
    onSuccess: async ({ rule }) => {
      const nextBehavior = behavior === "all" ? "all" : rule.behavior;
      if (nextBehavior !== behavior) setBehavior(nextBehavior);
      await queryClient.invalidateQueries({ queryKey: ["bash-permission-rules"] });
      setSelectedGroupKey(groupKeyForRule(rule));
      setEditor(null);
      setFormError(null);
    },
  });

  const revoke = useMutation<{ ok: true }, Error, string>({
    mutationFn: (id: string) => apiDelete<{ ok: true }>(`/api/bash-permission-rules/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["bash-permission-rules"] });
    },
  });

  const filteredRules = useMemo(() => {
    const query = q.trim().toLowerCase();
    const rules = rulesQ.data?.rules ?? [];
    if (!query) return rules;
    return rules.filter((rule) =>
      [
        rule.scopeType,
        rule.scopeValue,
        rule.behavior,
        rule.ruleType,
        rule.ruleContent,
        rule.source,
        rule.note ?? "",
      ]
        .join("\n")
        .toLowerCase()
        .includes(query)
    );
  }, [q, rulesQ.data?.rules]);

  const groups = useMemo(() => groupRules(filteredRules), [filteredRules]);
  const selectedGroup = groups.find((group) => group.key === selectedGroupKey) ?? groups[0] ?? null;
  const allRules = rulesQ.data?.rules ?? [];
  const directoryRuleCount = allRules.filter((rule) => rule.scopeType === "directory").length;
  const globalRuleCount = allRules.filter((rule) => rule.scopeType === "global").length;

  useEffect(() => {
    if (groups.length === 0) {
      setSelectedGroupKey("");
      return;
    }
    if (!groups.some((group) => group.key === selectedGroupKey)) {
      setSelectedGroupKey(groups[0]!.key);
    }
  }, [groups, selectedGroupKey]);

  function startCreate() {
    setFormError(null);
    saveRule.reset();
    setEditor({ mode: "create", draft: draftFromGroup(selectedGroup) });
  }

  function startEdit(rule: BashPermissionRule) {
    setFormError(null);
    saveRule.reset();
    setEditor({ mode: "edit", rule, draft: draftFromRule(rule) });
  }

  function cancelEdit() {
    setEditor(null);
    setFormError(null);
    saveRule.reset();
  }

  function updateDraft(next: Partial<RuleFormDraft>) {
    setEditor((current) => (current ? { ...current, draft: { ...current.draft, ...next } } : current));
  }

  function submitRule(event: FormEvent) {
    event.preventDefault();
    if (!editor) return;
    const validationError = validateDraft(editor.draft);
    if (validationError) {
      setFormError(validationError);
      return;
    }
    setFormError(null);
    saveRule.mutate({
      id: editor.mode === "edit" ? editor.rule.id : undefined,
      draft: editor.draft,
    });
  }

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-xl font-semibold">Shell 权限</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            查看和管理 AI Shell 已记住的目录级执行规则；撤销规则后，后续命令会重新进入审批。
          </p>
        </div>
        <div className="grid min-w-[520px] grid-cols-4 gap-3">
          <Metric label="规则" value={String(allRules.length)} />
          <Metric label="目录规则" value={String(directoryRuleCount)} />
          <Metric label="全局规则" value={String(globalRuleCount)} tone={globalRuleCount > 0 ? "warn" : "default"} />
          <Metric label="目录" value={String(groups.filter((group) => group.scopeType === "directory").length)} />
        </div>
      </header>

      <section className="grid grid-cols-[minmax(20rem,0.75fr)_minmax(38rem,1.45fr)] gap-5">
        <aside className="rounded border border-[var(--border)] bg-white">
          <div className="border-b border-[var(--border)] px-4 py-3">
            <div className="grid grid-cols-[1fr_140px] gap-3">
              <label className="min-w-0 text-xs text-[var(--muted)]">
                搜索目录或命令
                <input
                  value={q}
                  onChange={(event) => setQ(event.currentTarget.value)}
                  className="mt-1 h-9 w-full rounded border border-[var(--border)] px-3 text-sm text-[var(--fg)]"
                  placeholder="/Users/you 或 npm run"
                />
              </label>
              <label className="text-xs text-[var(--muted)]">
                类型
                <select
                  value={behavior}
                  onChange={(event) => {
                    setBehavior(event.currentTarget.value as BehaviorFilter);
                    setSelectedGroupKey("");
                  }}
                  className="mt-1 h-9 w-full rounded border border-[var(--border)] px-3 text-sm text-[var(--fg)]"
                >
                  <option value="allow">允许</option>
                  <option value="ask">询问</option>
                  <option value="deny">拒绝</option>
                  <option value="all">全部</option>
                </select>
              </label>
            </div>
          </div>
          <GroupList
            groups={groups}
            selectedGroupKey={selectedGroup?.key ?? ""}
            isLoading={rulesQ.isLoading}
            error={rulesQ.error}
            onSelect={(key) => {
              setSelectedGroupKey(key);
              setEditor(null);
            }}
          />
        </aside>

        <main className="rounded border border-[var(--border)] bg-white">
          <div className="border-b border-[var(--border)] px-4 py-3">
            <div className="flex items-start justify-between gap-5">
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  {editor
                    ? editor.mode === "create"
                      ? "新建 Shell 权限规则"
                      : "编辑 Shell 权限规则"
                    : selectedGroup
                      ? selectedGroup.label
                      : "没有匹配的权限规则"}
                </div>
                <div className="mt-1 break-all font-mono text-xs text-[var(--muted)]">
                  {editor
                    ? "规则会参与后续 Shell 命令的 allow / ask / deny 判断"
                    : selectedGroup
                      ? selectedGroup.scopeType === "directory"
                        ? selectedGroup.scopeValue
                        : "全局规则会在所有目录下参与匹配"
                      : "调整筛选条件或先新建一条规则"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <div className="rounded border border-[var(--border)] px-3 py-2 text-right text-xs">
                  <div className="text-[var(--muted)]">当前筛选</div>
                  <div className="mt-1 font-medium text-[var(--fg)]">{BEHAVIOR_LABELS[behavior]}</div>
                </div>
                <button
                  type="button"
                  onClick={startCreate}
                  className="h-10 rounded bg-[var(--accent)] px-4 text-sm font-medium text-white hover:opacity-90"
                >
                  新建规则
                </button>
              </div>
            </div>
          </div>

          {revoke.isError ? (
            <div className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {String(revoke.error.message)}
            </div>
          ) : null}

          {editor ? (
            <RuleForm
              editor={editor}
              error={formError ?? (saveRule.error ? saveRule.error.message : null)}
              isSaving={saveRule.isPending}
              onCancel={cancelEdit}
              onChange={updateDraft}
              onSubmit={submitRule}
            />
          ) : (
            <RuleTable
              rules={selectedGroup?.rules ?? []}
              deletingId={revoke.isPending ? revoke.variables ?? null : null}
              onEdit={startEdit}
              onRevoke={(id) => revoke.mutate(id)}
            />
          )}
        </main>
      </section>
    </div>
  );
}

function RuleForm({
  editor,
  error,
  isSaving,
  onCancel,
  onChange,
  onSubmit,
}: {
  editor: EditorState;
  error: string | null;
  isSaving: boolean;
  onCancel: () => void;
  onChange: (next: Partial<RuleFormDraft>) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const draft = editor.draft;
  return (
    <form onSubmit={onSubmit} className="grid gap-4 px-4 py-4">
      {error ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-3">
        <label className="text-xs text-[var(--muted)]">
          规则行为
          <select
            value={draft.behavior}
            onChange={(event) => onChange({ behavior: event.currentTarget.value as BashPermissionBehavior })}
            className="mt-1 h-9 w-full rounded border border-[var(--border)] px-3 text-sm text-[var(--fg)]"
          >
            <option value="allow">允许执行</option>
            <option value="ask">总是询问</option>
            <option value="deny">拒绝执行</option>
          </select>
        </label>
        <label className="text-xs text-[var(--muted)]">
          匹配方式
          <select
            value={draft.ruleType}
            onChange={(event) => onChange({ ruleType: event.currentTarget.value as BashPermissionRuleType })}
            className="mt-1 h-9 w-full rounded border border-[var(--border)] px-3 text-sm text-[var(--fg)]"
          >
            <option value="exact">精确命令</option>
            <option value="prefix">命令前缀</option>
            <option value="wildcard">通配表达式</option>
          </select>
        </label>
        <label className="text-xs text-[var(--muted)]">
          作用域
          <select
            value={draft.scopeType}
            onChange={(event) =>
              onChange({
                scopeType: event.currentTarget.value as BashPermissionRuleScopeType,
                scopeValue: event.currentTarget.value === "global" ? "" : draft.scopeValue,
              })
            }
            className="mt-1 h-9 w-full rounded border border-[var(--border)] px-3 text-sm text-[var(--fg)]"
          >
            <option value="directory">目录级</option>
            <option value="global">全局</option>
          </select>
        </label>
      </div>

      <label className="text-xs text-[var(--muted)]">
        命令规则
        <input
          value={draft.ruleContent}
          onChange={(event) => onChange({ ruleContent: event.currentTarget.value })}
          className="mt-1 h-10 w-full rounded border border-[var(--border)] px-3 font-mono text-sm text-[var(--fg)]"
          placeholder="npm run:* 或 git status --short"
        />
      </label>

      {draft.scopeType === "directory" ? (
        <label className="text-xs text-[var(--muted)]">
          目录
          <input
            value={draft.scopeValue}
            onChange={(event) => onChange({ scopeValue: event.currentTarget.value })}
            className="mt-1 h-10 w-full rounded border border-[var(--border)] px-3 font-mono text-sm text-[var(--fg)]"
            placeholder="/Users/you/project"
          />
        </label>
      ) : null}

      <label className="text-xs text-[var(--muted)]">
        备注
        <textarea
          value={draft.note}
          onChange={(event) => onChange({ note: event.currentTarget.value })}
          className="mt-1 min-h-20 w-full rounded border border-[var(--border)] px-3 py-2 text-sm text-[var(--fg)]"
          placeholder="可选，用来说明为什么保留这条规则"
        />
      </label>

      <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-4">
        <button
          type="button"
          onClick={onCancel}
          className="h-9 rounded border border-[var(--border)] px-4 text-sm text-[var(--fg)] hover:bg-neutral-50"
        >
          取消
        </button>
        <button
          type="submit"
          disabled={isSaving}
          className="h-9 rounded bg-[var(--accent)] px-4 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? "保存中..." : "保存规则"}
        </button>
      </div>
    </form>
  );
}

function groupRules(rules: BashPermissionRule[]): RuleGroup[] {
  const map = new Map<string, RuleGroup>();
  for (const rule of rules) {
    const key = groupKeyForRule(rule);
    const existing = map.get(key);
    if (existing) {
      existing.rules.push(rule);
      continue;
    }
    map.set(key, {
      key,
      label: rule.scopeType === "directory" ? rule.scopeValue || "(目录未记录)" : "全局",
      scopeType: rule.scopeType,
      scopeValue: rule.scopeValue,
      rules: [rule],
    });
  }
  return [...map.values()]
    .map((group) => ({
      ...group,
      rules: [...group.rules].sort(compareRules),
    }))
    .sort(compareGroups);
}

function compareGroups(a: RuleGroup, b: RuleGroup): number {
  if (a.scopeType !== b.scopeType) return a.scopeType === "directory" ? -1 : 1;
  return a.label.localeCompare(b.label);
}

function compareRules(a: BashPermissionRule, b: BashPermissionRule): number {
  const behaviorRank: Record<BashPermissionBehavior, number> = { allow: 0, ask: 1, deny: 2 };
  const typeRank: Record<BashPermissionRuleType, number> = { prefix: 0, exact: 1, wildcard: 2 };
  return (
    behaviorRank[a.behavior] - behaviorRank[b.behavior] ||
    typeRank[a.ruleType] - typeRank[b.ruleType] ||
    a.ruleContent.localeCompare(b.ruleContent)
  );
}

function GroupList({
  groups,
  selectedGroupKey,
  isLoading,
  error,
  onSelect,
}: {
  groups: RuleGroup[];
  selectedGroupKey: string;
  isLoading: boolean;
  error: unknown;
  onSelect: (key: string) => void;
}) {
  if (isLoading) return <div className="px-4 py-8 text-sm text-[var(--muted)]">加载规则...</div>;
  if (error) {
    return (
      <div className="px-4 py-8 text-sm text-red-700">
        {String((error as Error).message)}
      </div>
    );
  }
  if (groups.length === 0) {
    return <div className="px-4 py-8 text-sm text-[var(--muted)]">暂无匹配的 Shell 权限规则。</div>;
  }
  return (
    <div className="max-h-[44rem] overflow-auto">
      {groups.map((group) => (
        <button
          key={group.key}
          type="button"
          onClick={() => onSelect(group.key)}
          className={
            "grid w-full grid-cols-[1fr_auto] gap-3 border-b border-[var(--border)] px-4 py-3 text-left hover:bg-blue-50 " +
            (selectedGroupKey === group.key ? "bg-blue-50" : "")
          }
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-[var(--fg)]" title={group.label}>
              {group.label}
            </span>
            <span className="mt-1 block text-xs text-[var(--muted)]">
              {group.scopeType === "directory" ? "目录级" : "全局"}
            </span>
          </span>
          <span className="font-mono text-sm text-[var(--muted)]">{group.rules.length}</span>
        </button>
      ))}
    </div>
  );
}

function RuleTable({
  rules,
  deletingId,
  onEdit,
  onRevoke,
}: {
  rules: BashPermissionRule[];
  deletingId: string | null;
  onEdit: (rule: BashPermissionRule) => void;
  onRevoke: (id: string) => void;
}) {
  if (rules.length === 0) {
    return (
      <div className="px-4 py-12 text-sm text-[var(--muted)]">
        当前目录没有匹配的规则。
      </div>
    );
  }
  return (
    <div className="max-h-[44rem] overflow-auto">
      <table className="w-full table-fixed text-sm">
        <thead className="sticky top-0 bg-neutral-50 text-left text-xs text-[var(--muted)]">
          <tr>
            <th className="w-[35%] px-4 py-2 font-medium">命令规则</th>
            <th className="w-[10%] px-3 py-2 font-medium">行为</th>
            <th className="w-[10%] px-3 py-2 font-medium">匹配</th>
            <th className="w-[10%] px-3 py-2 font-medium">来源</th>
            <th className="w-[8%] px-3 py-2 font-medium">使用</th>
            <th className="w-[13%] px-3 py-2 font-medium">最近使用</th>
            <th className="w-[14%] px-3 py-2 font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.id} className="border-t border-[var(--border)] align-top">
              <td className="break-words px-4 py-3 font-mono text-xs text-[var(--fg)]">
                {rule.ruleContent}
                {rule.note ? (
                  <div className="mt-2 font-sans text-xs text-[var(--muted)]">{rule.note}</div>
                ) : null}
              </td>
              <td className="px-3 py-3">
                <BehaviorBadge behavior={rule.behavior} />
              </td>
              <td className="px-3 py-3">{TYPE_LABELS[rule.ruleType]}</td>
              <td className="px-3 py-3">{rule.source}</td>
              <td className="px-3 py-3 font-mono">{rule.useCount}</td>
              <td className="px-3 py-3 text-xs">{formatDate(rule.lastUsedAt)}</td>
              <td className="px-3 py-3">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onEdit(rule)}
                    className="rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--fg)] hover:bg-neutral-50"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => onRevoke(rule.id)}
                    disabled={deletingId === rule.id}
                    className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {deletingId === rule.id ? "撤销中..." : "撤销规则"}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BehaviorBadge({ behavior }: { behavior: BashPermissionBehavior }) {
  const className =
    behavior === "allow"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : behavior === "deny"
        ? "border-red-200 bg-red-50 text-red-800"
        : "border-amber-200 bg-amber-50 text-amber-800";
  return (
    <span className={`inline-flex min-h-7 items-center rounded border px-2 text-xs ${className}`}>
      {BEHAVIOR_LABELS[behavior]}
    </span>
  );
}

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "warn";
}) {
  const toneClass = tone === "warn" ? "text-amber-700" : "text-[var(--fg)]";
  return (
    <div className="rounded border border-[var(--border)] bg-white px-3 py-2">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className={`mt-1 truncate text-lg font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function draftFromRule(rule: BashPermissionRule): RuleFormDraft {
  return {
    behavior: rule.behavior,
    ruleType: rule.ruleType,
    ruleContent: rule.ruleContent,
    scopeType: rule.scopeType,
    scopeValue: rule.scopeValue,
    note: rule.note ?? "",
  };
}

function draftFromGroup(group: RuleGroup | null): RuleFormDraft {
  if (!group) return EMPTY_DRAFT;
  return {
    ...EMPTY_DRAFT,
    scopeType: group.scopeType,
    scopeValue: group.scopeValue,
  };
}

function rulePayloadFromDraft(draft: RuleFormDraft) {
  return {
    behavior: draft.behavior,
    ruleType: draft.ruleType,
    ruleContent: draft.ruleContent.trim(),
    scopeType: draft.scopeType,
    scopeValue: draft.scopeType === "directory" ? draft.scopeValue.trim() : "",
    note: draft.note.trim() || null,
  };
}

function validateDraft(draft: RuleFormDraft): string | null {
  if (!draft.ruleContent.trim()) return "命令规则不能为空。";
  if (draft.scopeType === "directory" && !draft.scopeValue.trim()) return "目录级规则必须填写目录。";
  return null;
}

function groupKeyForRule(rule: Pick<BashPermissionRule, "scopeType" | "scopeValue">): string {
  return rule.scopeType === "directory" ? `directory:${rule.scopeValue}` : "global:";
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}
