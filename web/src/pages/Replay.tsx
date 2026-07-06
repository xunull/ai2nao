import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api";
import { SOURCE_COLORS, friendlyRepoName } from "../components/CommitBridgeList";

/**
 * 那天回放(桥 T2c)前端页 `/replay`。左队列(mixed 工作会话,最新在前,默认选中最近一段)
 * + 右工作区(该段按时间自上而下的交织时间线:message 小圆点 · commit 旗标卡)。
 * 关联是启发式(提交前对话窗口,时间+仓库邻近),**不代表因果**。
 *
 * 后端形状见 src/replay/{queries,routes}.ts:
 *   GET /api/replay/sessions?windowDays= → { ok, sessions: Card[](最新在前), skipped, windowDays }
 *   GET /api/replay/session?key=&windowDays= → { ok, session: Card, events: Ev[](时间升序) }
 */

// ── 后端事件/卡片形状(与 queries.ts 对齐) ──────────────────────────────
type ReplayCard = {
  startedAtMs: number;
  endedAtMs: number;
  firstEventKey: string;
  repoKeys: string[];
  commitCount: number;
  messageCount: number;
  truncated: boolean;
};
type MsgEvent = {
  atMs: number;
  type: "message";
  source: string;
  repoKey: string;
  id: string;
  cleanedText: string;
};
type CommitEvent = {
  atMs: number;
  type: "commit";
  source: string;
  repoKey: string;
  id: string;
  subject: string;
  added: number;
  deleted: number;
  filesChanged: number;
  matchedCount: number;
};
type Ev = MsgEvent | CommitEvent;

type SessionsResp = {
  ok: true;
  sessions: ReplayCard[];
  skipped: number;
  windowDays: number;
};
type SessionResp = { ok: true; session: ReplayCard; events: Ev[] };

// 窗口逐级放宽(90 → 180 → 365 天)。
const WINDOW_STEPS = [90, 180, 365] as const;
// gap 标签阈值:两个相邻事件间隔 ≥ 5 分钟才标注(否则视为同一波连续对话)。
const GAP_MIN_MS = 5 * 60 * 1000;
// 密集对话折叠阈值:连续 ≥4 条消息才折中间段(留首尾,codex#10 保节奏)。
const CLUSTER_MIN = 4;

// ── 时间/时长格式化(全部本地时区;数字用 tabular-nums) ──────────────────
const pad2 = (n: number) => String(n).padStart(2, "0");
/** 日期(zh-CN 长月 + 星期短名),如「7月5日周六」。 */
function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}
/** 本地时分「HH:MM」——手拼避免 locale 12h/前后缀漂移。 */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** 会话时长:37m / 1h18m / 8h。 */
function fmtDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return `${h}h${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}
/** gap 文案:59 分钟 / 1h18m(会话内 gap 必 ≤2h,超 2h 是切段线,不会出现在段内)。 */
function fmtGap(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return `${h}h${m}m`;
  if (h > 0) return `${h}h`;
  return `${m} 分钟`;
}
/** 长文本裁剪(时间线只放摘要;whitespace-pre-wrap 保留换行观感)。 */
function snippet(text: string, max = 160): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ── 时间线折叠单元 ───────────────────────────────────────────────────────
type Unit =
  | { kind: "msg"; ev: MsgEvent }
  | { kind: "cluster"; id: string; events: MsgEvent[] }
  | { kind: "commit"; ev: CommitEvent };

/**
 * 事件流 → 渲染单元。连续消息成「run」:run 长度 ≥ CLUSTER_MIN 时留首尾、把中间折成
 * 一个可展开簇(▸ +N 条对话);否则逐条展开。commit 各自成单元、并冲刷当前 run。
 */
function buildUnits(events: Ev[]): Unit[] {
  const units: Unit[] = [];
  let run: MsgEvent[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length >= CLUSTER_MIN) {
      const middle = run.slice(1, run.length - 1);
      units.push({ kind: "msg", ev: run[0] });
      units.push({ kind: "cluster", id: `cl-${middle[0].id}`, events: middle });
      units.push({ kind: "msg", ev: run[run.length - 1] });
    } else {
      for (const m of run) units.push({ kind: "msg", ev: m });
    }
    run = [];
  };
  for (const e of events) {
    if (e.type === "message") run.push(e);
    else {
      flush();
      units.push({ kind: "commit", ev: e });
    }
  }
  flush();
  return units;
}
/** 单元起点时刻(gap 计算用:下一单元的起点 − 上一单元的终点)。 */
const unitFirstMs = (u: Unit) => (u.kind === "cluster" ? u.events[0].atMs : u.ev.atMs);
/** 单元终点时刻。 */
const unitLastMs = (u: Unit) =>
  u.kind === "cluster" ? u.events[u.events.length - 1].atMs : u.ev.atMs;

// ── 展示原子 ─────────────────────────────────────────────────────────────
/** 跨仓库时每条事件挂一个小仓库徽标(codex#4:两仓库可区分,不暗示跨仓因果)。 */
function RepoTag({ repoKey }: { repoKey: string }) {
  return (
    <span
      className="shrink-0 rounded-sm border border-[var(--border)] px-1 text-[10px] text-[var(--fg-muted)]"
      title={repoKey}
    >
      {friendlyRepoName(repoKey)}
    </span>
  );
}

/** 一条人类对话:源色小圆点 + 摘要(保留换行) + 本地时刻。 */
function MessageRow({ ev, multiRepo }: { ev: MsgEvent; multiRepo: boolean }) {
  return (
    <div className="relative py-[5px]">
      <span
        className="absolute left-[-16px] top-[9px] h-2 w-2 rounded-full"
        style={{ backgroundColor: SOURCE_COLORS[ev.source] ?? "var(--fg-muted)" }}
        title={ev.source}
      />
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] text-[var(--fg)]">
          {snippet(ev.cleanedText)}
        </div>
        {multiRepo && <RepoTag repoKey={ev.repoKey} />}
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--fg-muted)]">
          {fmtClock(ev.atMs)}
        </span>
      </div>
    </div>
  );
}

/** 一个 commit:绿色左边旗标卡,主题 + 变更行数 + 匹配徽标(emerald pill / muted pill)。 */
function CommitCard({ ev, multiRepo }: { ev: CommitEvent; multiRepo: boolean }) {
  const matched = ev.matchedCount > 0;
  return (
    <div className="relative my-1.5 ml-[-4px] rounded-md border border-[var(--border)] border-l-[3px] border-l-[#16a34a] bg-[var(--surface-2)] px-2.5 py-2">
      <span
        className="absolute left-[-19px] top-[11px] h-3 w-3 rounded-sm bg-[#16a34a]"
        aria-hidden="true"
      />
      <div className="flex items-start gap-2">
        <div
          className="min-w-0 flex-1 text-[13px] font-semibold text-[var(--fg)]"
          title={ev.subject}
        >
          {ev.subject || "(无主题)"}
        </div>
        {multiRepo && <RepoTag repoKey={ev.repoKey} />}
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--fg-muted)]">
          {fmtClock(ev.atMs)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] tabular-nums">
        <span className="text-emerald-600" title={`${ev.filesChanged} 个文件`}>
          +{ev.added}
        </span>
        <span className="text-rose-600">−{ev.deleted}</span>
        <span
          className={`ml-auto rounded-full px-2 py-0.5 text-[11px] ${
            matched
              ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
              : "bg-[var(--surface-2)] text-[var(--fg-muted)] ring-1 ring-[var(--border)]"
          }`}
        >
          {matched ? `匹配 ${ev.matchedCount} 条对话` : "无匹配"}
        </span>
      </div>
    </div>
  );
}

/** 事件间的静默 gap 标注(斜体、克制)。会话内 gap 必 ≤2h,故无「睡觉大 gap」分隔线。 */
function GapLabel({ ms }: { ms: number }) {
  return (
    <div className="py-1 pl-0.5 text-[11px] italic text-[var(--fg-muted)]">
      聊 {fmtGap(ms)} →
    </div>
  );
}

/** 右侧竖向时间线:交织 message/commit,gap 标注,密集对话折叠(可展开)。 */
function Timeline({ events, multiRepo }: { events: Ev[]; multiRepo: boolean }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const units = useMemo(() => buildUnits(events), [events]);
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="relative pl-[18px]">
      {/* 竖轴 */}
      <span
        className="pointer-events-none absolute bottom-1 left-[5px] top-1 w-0.5 bg-[var(--border)]"
        aria-hidden="true"
      />
      {units.map((u, i) => {
        const gap = i > 0 ? unitFirstMs(u) - unitLastMs(units[i - 1]) : 0;
        const gapNode =
          gap >= GAP_MIN_MS ? <GapLabel key={`gap-${i}`} ms={gap} /> : null;

        if (u.kind === "commit") {
          return (
            <div key={`commit-${u.ev.id}`}>
              {gapNode}
              <CommitCard ev={u.ev} multiRepo={multiRepo} />
            </div>
          );
        }
        if (u.kind === "msg") {
          return (
            <div key={`msg-${u.ev.id}`}>
              {gapNode}
              <MessageRow ev={u.ev} multiRepo={multiRepo} />
            </div>
          );
        }
        // cluster
        const open = expanded.has(u.id);
        return (
          <div key={u.id}>
            {gapNode}
            {open ? (
              <div>
                <button
                  type="button"
                  onClick={() => toggle(u.id)}
                  className="py-0.5 pl-0.5 text-left text-xs hover:underline"
                  style={{ color: SOURCE_COLORS.codex }}
                >
                  ▾ 收起 {u.events.length} 条对话
                </button>
                {u.events.map((m) => (
                  <MessageRow key={`msg-${m.id}`} ev={m} multiRepo={multiRepo} />
                ))}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => toggle(u.id)}
                className="py-0.5 pl-0.5 text-left text-xs hover:underline"
                style={{ color: SOURCE_COLORS.codex }}
              >
                ▸ +{u.events.length} 条对话（展开）
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── 左队列卡片 ───────────────────────────────────────────────────────────
function SessionCardRow({
  card,
  selected,
  onSelect,
}: {
  card: ReplayCard;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`block w-full border-b border-[var(--border)] px-3 py-2.5 text-left last:border-b-0 ${
        selected
          ? "bg-blue-50 shadow-[inset_3px_0_0_#2563eb]"
          : "hover:bg-[var(--surface-2)]"
      }`}
    >
      <div className="text-[13px] font-semibold text-[var(--fg)]">
        {fmtDate(card.startedAtMs)}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--fg-muted)]">
        <span className="tabular-nums">
          {fmtClock(card.startedAtMs)}–{fmtClock(card.endedAtMs)} ·{" "}
          {fmtDuration(card.endedAtMs - card.startedAtMs)}
        </span>
        {card.repoKeys.map((rk) => (
          <span
            key={rk}
            className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-px text-[11px]"
            title={rk}
          >
            {friendlyRepoName(rk)}
          </span>
        ))}
        <span className="tabular-nums">
          {card.commitCount} commit · {card.messageCount} 对话
        </span>
      </div>
    </button>
  );
}

// ── 页面 ─────────────────────────────────────────────────────────────────
export function Replay() {
  const [windowDays, setWindowDays] = useState<number>(WINDOW_STEPS[0]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const sessionsQ = useQuery<SessionsResp>({
    queryKey: ["replay-sessions", windowDays],
    queryFn: () =>
      apiGet<SessionsResp>(`/api/replay/sessions?windowDays=${windowDays}`),
  });

  const sessions = sessionsQ.data?.sessions ?? [];

  // 默认选中最近一段(DESIGN.md:复杂页默认落到一个有价值对象,而非空白)。
  // 选中项失效(窗口变化/列表刷新)时回落到最新一段。
  useEffect(() => {
    if (sessions.length === 0) {
      if (selectedKey !== null) setSelectedKey(null);
      return;
    }
    if (!selectedKey || !sessions.some((s) => s.firstEventKey === selectedKey)) {
      setSelectedKey(sessions[0].firstEventKey);
    }
  }, [sessions, selectedKey]);

  const detailQ = useQuery<SessionResp>({
    queryKey: ["replay-session", selectedKey, windowDays],
    enabled: !!selectedKey,
    queryFn: () =>
      apiGet<SessionResp>(
        `/api/replay/session?key=${encodeURIComponent(selectedKey!)}&windowDays=${windowDays}`
      ),
  });

  const nextStep = WINDOW_STEPS.find((d) => d > windowDays);

  return (
    <main className="mx-auto max-w-[1400px] px-8 py-5">
      <header className="mb-4">
        <h1 className="text-xl font-semibold text-[var(--fg)]">
          对话 ↔ 提交{" "}
          <span className="text-sm font-normal text-[var(--fg-muted)]">· 那天回放</span>
        </h1>
        <p className="mt-1 text-xs text-[var(--fg-muted)]">
          关联 = 提交前的对话窗口(<strong>启发式</strong>,时间+仓库邻近,
          <strong>不代表因果</strong>)。
        </p>
        <p className="mt-1 text-xs text-[var(--fg-muted)]">
          {sessionsQ.isSuccess
            ? `窗口内 ${sessions.length} 段有对话产出的工作会话(mixed) · 最近 ${windowDays} 天 · 最新在前`
            : `最近 ${windowDays} 天 · mixed 工作会话`}
        </p>
      </header>

      {sessionsQ.isLoading ? (
        <div className="grid h-[calc(100vh-180px)] grid-cols-[360px_minmax(0,1fr)] gap-6">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 text-xs text-[var(--fg-muted)]">
            加载工作会话…
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 text-xs text-[var(--fg-muted)]">
            加载时间线…
          </div>
        </div>
      ) : sessionsQ.isError ? (
        <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
          加载失败：{(sessionsQ.error as Error).message}
        </div>
      ) : sessions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-2)] p-8 text-center text-sm text-[var(--fg-muted)]">
          <p>这个窗口没有『既有提交又有对话』的工作会话。</p>
          <p className="mt-1">换更大窗口,或先让 git commit / 对话同步。</p>
          {nextStep && (
            <button
              type="button"
              onClick={() => setWindowDays(nextStep)}
              className="mt-4 rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--fg)] hover:bg-[var(--surface)]"
            >
              加载更早窗口(最近 {nextStep} 天)
            </button>
          )}
        </div>
      ) : (
        <div className="grid h-[calc(100vh-180px)] grid-cols-[360px_minmax(0,1fr)] gap-6">
          {/* 左:会话队列 */}
          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
            <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs text-[var(--fg-muted)]">
              工作会话(mixed · gap&gt;2h 自动切)
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {sessions.map((card) => (
                <SessionCardRow
                  key={card.firstEventKey}
                  card={card}
                  selected={card.firstEventKey === selectedKey}
                  onSelect={() => setSelectedKey(card.firstEventKey)}
                />
              ))}
            </div>
            {nextStep && (
              <button
                type="button"
                onClick={() => setWindowDays(nextStep)}
                className="shrink-0 border-t border-[var(--border)] py-2 text-xs text-[var(--fg-muted)] hover:bg-[var(--surface-2)]"
              >
                加载更早窗口(最近 {nextStep} 天)
              </button>
            )}
          </div>

          {/* 右:回放工作区 */}
          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
            {detailQ.isLoading ? (
              <div className="p-4 text-xs text-[var(--fg-muted)]">加载时间线…</div>
            ) : detailQ.isError ? (
              <div className="m-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
                时间线加载失败：{(detailQ.error as Error).message}
              </div>
            ) : detailQ.data ? (
              <>
                <div className="shrink-0 border-b border-[var(--border)] px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-sm font-semibold text-[var(--fg)]">
                      {fmtDate(detailQ.data.session.startedAtMs)}
                    </span>
                    {detailQ.data.session.repoKeys.map((rk) => (
                      <span
                        key={rk}
                        className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-px text-[11px] text-[var(--fg-muted)]"
                        title={rk}
                      >
                        {friendlyRepoName(rk)}
                      </span>
                    ))}
                    <span className="text-xs tabular-nums text-[var(--fg-muted)]">
                      {fmtClock(detailQ.data.session.startedAtMs)}–
                      {fmtClock(detailQ.data.session.endedAtMs)} ·{" "}
                      {detailQ.data.session.commitCount} commit ·{" "}
                      {detailQ.data.session.messageCount} 对话
                      {detailQ.data.session.truncated ? " · 已截断" : ""}
                    </span>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                  <Timeline
                    key={selectedKey ?? "none"}
                    events={detailQ.data.events}
                    multiRepo={detailQ.data.session.repoKeys.length > 1}
                  />
                </div>
              </>
            ) : (
              <div className="p-4 text-xs text-[var(--fg-muted)]">选中一段查看回放。</div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
