import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { apiGet } from "../api";
import { Page } from "../components/Page";

type CrossEvent = {
  kind: "commit" | "visit" | "token" | "message";
  atMs: number;
  label: string;
  detail?: string;
};

type Span = {
  id: number;
  bundleId: string;
  appName: string | null;
  startMs: number;
  endMs: number;
  durationMs: number;
  partIndex: number;
  events: CrossEvent[];
};

type DayPayload = {
  localDay: string;
  totalMs: number;
  spanCount: number;
  spans: Span[];
  byBundle: { bundleId: string; appName: string | null; totalMs: number; spanCount: number }[];
  eventCounts: Record<CrossEvent["kind"], number>;
  unattributedEvents: number;
};

type StatusPayload = {
  status: string;
  message: string;
  action?: string;
  responsibleApp?: string;
  lastSuccessAt: string | null;
  spanCount: number;
};

type UnsupportedSource = { source: string; reason: string };

const KIND_LABEL: Record<CrossEvent["kind"], string> = {
  commit: "提交",
  visit: "浏览",
  token: "Token",
  message: "提问",
};

const KIND_COLOR: Record<CrossEvent["kind"], string> = {
  commit: "#22c55e",
  visit: "#38bdf8",
  token: "#f59e0b",
  message: "#a78bfa",
};

/** Stable colour per bundle so an app keeps its band across days. */
function hueOf(bundleId: string): number {
  let h = 0;
  for (let i = 0; i < bundleId.length; i++) h = (h * 31 + bundleId.charCodeAt(i)) % 360;
  return h;
}

const fmtHm = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const fmtDur = (ms: number): string => {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} 分钟`;
  return `${(m / 60).toFixed(1)} 小时`;
};

const todayLocal = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function Attention() {
  const [day, setDay] = useState(todayLocal);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const status = useQuery({
    queryKey: ["attention", "status"],
    queryFn: () =>
      apiGet<{ status: StatusPayload; unsupportedSources: UnsupportedSource[] }>(
        "/api/attention/status"
      ),
  });

  const days = useQuery({
    queryKey: ["attention", "days"],
    queryFn: () => apiGet<{ days: { day: string; spans: number; total_ms: number }[] }>(
      "/api/attention/days?limit=60"
    ),
  });

  const dayQ = useQuery({
    queryKey: ["attention", "day", day],
    queryFn: () => apiGet<{ day: DayPayload }>(`/api/attention/day?day=${day}`),
  });

  const data = dayQ.data?.day;
  const selected = useMemo(
    () => data?.spans.find((s) => s.id === selectedId) ?? null,
    [data, selectedId]
  );

  const st = status.data?.status;
  const blocked = st && st.status !== "ok" && (data?.spanCount ?? 0) === 0;

  return (
    <Page
      title="注意力"
      subtitle="这一天的时间落在哪些应用里，以及那些时段里具体发生了什么"
      fill
      actions={
        <select
          className="rounded border border-[var(--border)] bg-transparent px-2 py-1 text-sm"
          value={day}
          onChange={(e) => {
            setDay(e.target.value);
            setSelectedId(null);
          }}
        >
          <option value={day}>{day}</option>
          {(days.data?.days ?? [])
            .filter((d) => d.day !== day)
            .map((d) => (
              <option key={d.day} value={d.day}>
                {d.day} · {fmtDur(d.total_ms)}
              </option>
            ))}
        </select>
      }
      toolbar={
        data && data.spanCount > 0 ? (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-8 pb-3 text-sm text-[var(--muted)]">
            <span className="text-[var(--fg)]">{fmtDur(data.totalMs)}</span>
            <span>{data.spanCount} 段</span>
            {(Object.keys(KIND_LABEL) as CrossEvent["kind"][]).map((k) => (
              <span key={k} className="inline-flex items-center gap-1">
                <i
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: KIND_COLOR[k] }}
                />
                {KIND_LABEL[k]} {data.eventCounts[k]}
              </span>
            ))}
            {data.unattributedEvents > 0 && (
              <span
                title="这些事件落在所有前台时段之外 —— 屏幕关着时 agent 还在跑，或者系统没记录那段前台。不显示它会让交叉结果看起来比实际完整。"
                className="text-amber-500"
              >
                未归属 {data.unattributedEvents}
              </span>
            )}
          </div>
        ) : undefined
      }
    >
      {blocked ? (
        <StatusPanel status={st!} unsupported={status.data?.unsupportedSources ?? []} />
      ) : dayQ.isLoading ? (
        <p className="px-1 py-6 text-sm text-[var(--muted)]">读取中…</p>
      ) : !data || data.spanCount === 0 ? (
        <p className="px-1 py-6 text-sm text-[var(--muted)]">
          {day} 这天没有记录。可能那天没开机，也可能同步任务还没覆盖到这一天。
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 pt-4">
          <Timeline
            spans={data.spans}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(240px,1fr)_2fr] gap-4">
            <BundleRanking data={data} />
            <Evidence
              span={selected}
              unsupported={status.data?.unsupportedSources ?? []}
            />
          </div>
        </div>
      )}
    </Page>
  );
}

/**
 * One local day as a proportional strip.
 *
 * Widths are percentages of the day, never fixed pixels: the project forbids a
 * horizontal scrollbar, and 24 hours laid out at any fixed scale would need one
 * on every window narrower than the author's.
 */
function Timeline({
  spans,
  selectedId,
  onSelect,
}: {
  spans: Span[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const dayStart = useMemo(() => {
    const d = new Date(spans[0]!.startMs);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }, [spans]);
  const DAY = 86_400_000;

  return (
    <div>
      <div className="relative h-14 w-full overflow-hidden rounded border border-[var(--border)] bg-[var(--bg-subtle,rgba(127,127,127,0.06))]">
        {spans.map((s) => {
          const left = ((s.startMs - dayStart) / DAY) * 100;
          const width = Math.max((s.durationMs / DAY) * 100, 0.12);
          const hue = hueOf(s.bundleId);
          const active = s.id === selectedId;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s.id)}
              title={`${fmtHm(s.startMs)} ${s.appName ?? s.bundleId} · ${fmtDur(s.durationMs)}${s.events.length ? ` · ${s.events.length} 条证据` : ""}`}
              className="absolute top-0 h-full border-0 p-0 transition-opacity hover:opacity-100"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                background: `hsl(${hue} 60% 55%)`,
                opacity: active ? 1 : 0.62,
                outline: active ? "2px solid var(--fg)" : "none",
                outlineOffset: "-2px",
              }}
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-[var(--muted)]">
        {[0, 6, 12, 18, 24].map((h) => (
          <span key={h}>{String(h).padStart(2, "0")}:00</span>
        ))}
      </div>
    </div>
  );
}

function BundleRanking({ data }: { data: DayPayload }) {
  const top = data.byBundle.slice(0, 8);
  const rest = data.byBundle.slice(8);
  const restMs = rest.reduce((a, b) => a + b.totalMs, 0);
  const max = top[0]?.totalMs ?? 1;

  return (
    <section className="flex min-h-0 flex-col">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
        应用时长
      </h2>
      <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1 text-sm">
        {top.map((b) => (
          <li key={b.bundleId}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate" title={b.bundleId}>
                {b.appName ?? b.bundleId}
              </span>
              <span className="shrink-0 tabular-nums text-[var(--muted)]">
                {fmtDur(b.totalMs)}
              </span>
            </div>
            <div className="mt-0.5 h-1 w-full rounded bg-[var(--border)]">
              <div
                className="h-full rounded"
                style={{
                  width: `${(b.totalMs / max) * 100}%`,
                  background: `hsl(${hueOf(b.bundleId)} 60% 55%)`,
                }}
              />
            </div>
          </li>
        ))}
        {rest.length > 0 && (
          <li className="flex items-baseline justify-between gap-2 pt-1 text-[var(--muted)]">
            <span>其余 {rest.length} 个</span>
            <span className="tabular-nums">{fmtDur(restMs)}</span>
          </li>
        )}
      </ul>
    </section>
  );
}

function Evidence({
  span,
  unsupported,
}: {
  span: Span | null;
  unsupported: UnsupportedSource[];
}) {
  return (
    <section className="flex min-h-0 flex-col">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
        {span
          ? `${fmtHm(span.startMs)}–${fmtHm(span.endMs)} · ${span.appName ?? span.bundleId} · ${fmtDur(span.durationMs)}`
          : "交叉证据"}
      </h2>
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {!span ? (
          <p className="text-sm text-[var(--muted)]">
            点上面时间带里的任意一段，看那段时间里具体发生了什么。
          </p>
        ) : span.events.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            这一段里没有可交叉的事件。
            {unsupported.length > 0 && (
              <>
                {" "}
                注意 {unsupported.map((u) => u.source).join(" / ")} 暂时接不上，
                这不代表那段时间什么都没做。
              </>
            )}
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {span.events.map((e, i) => (
              <li key={i} className="flex gap-2">
                <span className="shrink-0 tabular-nums text-[var(--muted)]">
                  {fmtHm(e.atMs)}
                </span>
                <span
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: KIND_COLOR[e.kind] }}
                  title={KIND_LABEL[e.kind]}
                />
                <span className="min-w-0">
                  <span className="break-words">{e.label}</span>
                  {e.detail && (
                    <span className="ml-2 break-all text-xs text-[var(--muted)]">
                      {e.detail}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * Why the page is empty, and what to do about it.
 *
 * Four of the five states are reachable by default (the scheduler task is born
 * disabled and Full Disk Access starts ungranted), so this panel is the normal
 * first screen, not an error path.
 */
function StatusPanel({
  status,
  unsupported,
}: {
  status: StatusPayload;
  unsupported: UnsupportedSource[];
}) {
  return (
    <div className="max-w-2xl py-8">
      <p className="mb-1 text-xs uppercase tracking-wide text-[var(--muted)]">
        {status.status}
      </p>
      <p className="text-base">{status.message}</p>
      {status.action && (
        <p className="mt-3 rounded border border-[var(--border)] px-3 py-2 text-sm text-[var(--muted)]">
          {status.action}
        </p>
      )}
      {status.lastSuccessAt && (
        <p className="mt-3 text-xs text-[var(--muted)]">
          最后一次成功同步：{new Date(status.lastSuccessAt).toLocaleString()}
        </p>
      )}
      {unsupported.length > 0 && (
        <ul className="mt-6 space-y-1 text-xs text-[var(--muted)]">
          {unsupported.map((u) => (
            <li key={u.source}>
              <span className="text-[var(--fg)]">{u.source}</span>：{u.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
