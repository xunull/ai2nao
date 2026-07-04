/**
 * 「我的 AI 节律」自量化仪表盘读侧。数据源:agent_user_messages(仅 is_human)。
 * 设计:docs/my-ai-rhythm-dashboard-design.md。localtime 口径与全 app 一致。
 *
 * T1 只有作息热力图(weekday × hour,GitHub punch-card)。以后配菜卡(命令排行 /
 * 习惯曲线 / 个人纪录)也放本模块。
 */
import type Database from "better-sqlite3";

/** 一格:weekday 0=周日(SQLite %w),hour 0-23,count 该格 is_human 消息数。 */
export type RhythmCell = { weekday: number; hour: number; count: number };

export type RhythmHeatmap = {
  /** 仅非零格(前端 zero-fill 成 7×24)。weekday/hour 已是 number。 */
  cells: RhythmCell[];
  /** 配色标度用;空库为 0(前端据此防除零)。 */
  maxCount: number;
  total: number;
  /** 最活跃格;空库为 null。tie-break:count → 周一起最早 → hour 最早。 */
  peak: RhythmCell | null;
  /** 诚实新鲜度:数据是「已索引消息」的快照,非实时。 */
  generatedAt: string;
};

/** 周一起的序号(Mon=0..Sun=6),用于 peak 平局裁决。 */
function mondayIndex(weekday: number): number {
  return (weekday + 6) % 7;
}

/** 最活跃格:count 最大;平局取周一起最早、再 hour 最早(确定性,不靠 SQL 返回序)。 */
function pickPeak(cells: RhythmCell[]): RhythmCell | null {
  if (cells.length === 0) return null;
  let best = cells[0];
  for (const c of cells) {
    if (c.count > best.count) {
      best = c;
    } else if (c.count === best.count) {
      const ci = mondayIndex(c.weekday);
      const bi = mondayIndex(best.weekday);
      if (ci < bi || (ci === bi && c.hour < best.hour)) best = c;
    }
  }
  return best;
}

/**
 * 作息热力图:按「本地星期几 × 本地整点」聚合 is_human 消息数。
 * - CAST 成 INTEGER:strftime 返 TEXT("0"/"08"),不 CAST 会和前端 number key 错开。
 * - 坏时间戳过滤:event_at_utc 无 ISO CHECK,不可解析 → strftime NULL,WHERE 剔除。
 * - 全源、全时段(v1)。
 */
export function heatmapRhythm(
  db: Database.Database,
  opts?: { now?: Date }
): RhythmHeatmap {
  const cells = db
    .prepare(
      `SELECT CAST(strftime('%w', event_at_utc, 'localtime') AS INTEGER) AS weekday,
              CAST(strftime('%H', event_at_utc, 'localtime') AS INTEGER) AS hour,
              COUNT(*) AS count
       FROM agent_user_messages
       WHERE is_human = 1
         AND strftime('%w', event_at_utc, 'localtime') IS NOT NULL
       GROUP BY weekday, hour`
    )
    .all() as RhythmCell[];

  let maxCount = 0;
  let total = 0;
  for (const c of cells) {
    total += c.count;
    if (c.count > maxCount) maxCount = c.count;
  }

  const now = opts?.now ?? new Date();
  return {
    cells,
    maxCount,
    total,
    peak: pickPeak(cells),
    generatedAt: now.toISOString(),
  };
}
