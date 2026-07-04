import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api";

type Cell = { weekday: number; hour: number; count: number }; // weekday 0=周日
type HeatmapResp = {
  ok: true;
  cells: Cell[];
  maxCount: number;
  total: number;
  peak: Cell | null;
  generatedAt: string;
};

// 显示周一起:行 = weekday 值(1..6,0),对应「一二三四五六日」。
const ROW_WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"]; // 索引 = weekday 值
const HOURS = Array.from({ length: 24 }, (_, h) => h);

const CELL = 22;
const LEFT = 40; // 周几标签
const TOP = 18; // 整点标签

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 借 TagTimeHeatmap 的 5 档绿阶;maxCount=0 时防除零(全取最浅)。 */
function colorFor(count: number, maxCount: number): string {
  if (count === 0) return "#ebedf0";
  const ratio = count / Math.max(1, maxCount);
  if (ratio < 0.2) return "#c6e48b";
  if (ratio < 0.45) return "#7bc96f";
  if (ratio < 0.75) return "#239a3b";
  return "#196127";
}

function Heatmap({ data }: { data: HeatmapResp }) {
  const byKey = new Map<string, number>();
  for (const c of data.cells) byKey.set(`${c.weekday}-${c.hour}`, c.count);

  const width = LEFT + HOURS.length * CELL + 8;
  const height = TOP + ROW_WEEKDAYS.length * CELL + 8;

  const peakLine = data.peak
    ? `最活跃:周${WEEKDAY_CN[data.peak.weekday]} ${pad2(data.peak.hour)}:00 · ${data.peak.count} 条`
    : "还没有已索引的消息";

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--fg-muted)]">
        <span className="font-medium text-[var(--fg)]">{peakLine}</span>
        <span>累计 {data.total} 条</span>
        <span className="ml-auto flex items-center gap-1">
          少
          {["#ebedf0", "#c6e48b", "#7bc96f", "#239a3b", "#196127"].map((c) => (
            <span
              key={c}
              className="inline-block h-3 w-3 rounded-sm"
              style={{ background: c }}
            />
          ))}
          多
        </span>
      </div>

      {/* overflow-x-auto 兜底:24 列固定尺寸正常不溢出,极端窄容器下内部滚动,不给整页横滚 */}
      <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
        <svg width={width} height={height} role="img" aria-label="作息热力图(星期 × 小时)">
          {/* 整点标签(每 3 小时一个,避免拥挤) */}
          <g transform={`translate(${LEFT}, ${TOP - 6})`}>
            {HOURS.map((h) =>
              h % 3 === 0 ? (
                <text
                  key={h}
                  x={h * CELL + CELL / 2}
                  y={0}
                  fontSize="9"
                  fill="#6b7280"
                  textAnchor="middle"
                >
                  {h}
                </text>
              ) : null
            )}
          </g>
          {/* 周几标签 */}
          <g transform={`translate(0, ${TOP})`}>
            {ROW_WEEKDAYS.map((wd, i) => (
              <text
                key={wd}
                x={LEFT - 8}
                y={i * CELL + CELL / 2 + 4}
                fontSize="10"
                fill="#6b7280"
                textAnchor="end"
              >
                周{WEEKDAY_CN[wd]}
              </text>
            ))}
          </g>
          {/* 格子 */}
          <g transform={`translate(${LEFT}, ${TOP})`}>
            {ROW_WEEKDAYS.map((wd, i) =>
              HOURS.map((h) => {
                const count = byKey.get(`${wd}-${h}`) ?? 0;
                return (
                  <rect
                    key={`${wd}-${h}`}
                    x={h * CELL}
                    y={i * CELL}
                    width={CELL - 2}
                    height={CELL - 2}
                    rx={3}
                    fill={colorFor(count, data.maxCount)}
                  >
                    <title>
                      周{WEEKDAY_CN[wd]} {pad2(h)}:00 · {count} 条
                    </title>
                  </rect>
                );
              })
            )}
          </g>
        </svg>
      </div>

      <div className="mt-2 text-[10px] text-[var(--fg-muted)]">
        数据 = 已索引消息快照(按小时增量同步,非实时)· 更新于{" "}
        {new Date(data.generatedAt).toLocaleString("zh-CN", { hour12: false })}
      </div>
    </div>
  );
}

/** 「我的 AI 节律」自量化仪表盘:作息热力图(星期 × 小时)。 */
export function AiRhythm() {
  const q = useQuery<HeatmapResp>({
    queryKey: ["ai-rhythm-heatmap"],
    queryFn: () => apiGet<HeatmapResp>("/api/ai-rhythm/heatmap"),
  });

  return (
    <main className="mx-auto max-w-[900px] px-8 py-6">
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-[var(--fg)]">已索引消息节律</h1>
        <p className="mt-1 text-xs text-[var(--fg-muted)]">
          你对各 AI agent 说过的话(仅本人、已过滤注入)按「本地星期几 × 整点」的分布 —— 一眼看出你的作息节律。
          全源合计。数据是已索引消息的快照,非实时。
        </p>
      </header>

      {q.isLoading ? (
        <div className="text-xs text-[var(--fg-muted)]">加载热力图…</div>
      ) : q.isError ? (
        <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
          加载失败：{(q.error as Error).message}
        </div>
      ) : (
        <Heatmap data={q.data!} />
      )}
    </main>
  );
}
