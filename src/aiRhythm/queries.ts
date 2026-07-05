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

export type StreakRhythm = {
  /** 当前连续活跃天数;grace:最近活跃日 = 今天或昨天才算活着,否则 0(已断)。 */
  currentStreak: number;
  /** 有史以来最长的一段连续活跃日。 */
  longestStreak: number;
  /** 今天(本地)是否已有记录。 */
  todayActive: boolean;
  /** 最近一个活跃日 'YYYY-MM-DD';空库 null。 */
  lastActiveDay: string | null;
  totalActiveDays: number;
  generatedAt: string;
};

/** 'YYYY-MM-DD' → 稳定的日序号。用 Date.UTC(纯字符串映射,恰为整数、与时区无关),只用于相邻判定。 */
function dayOrdinal(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

/** 本地日 'YYYY-MM-DD'(getFullYear/Month/Date 是本地时区,与 strftime 'localtime' 一致)。 */
function localYmd(dt: Date): string {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 连续天数纪录(Duolingo 式)。活跃日 = 本地日有 ≥1 条 is_human 消息(全源)。
 * - SQL 只取 DISTINCT 本地日(坏时间戳 strftime NULL 剔除,同热力图口径);连续逻辑放 TS。
 * - grace:当前连续只在最近活跃日 = 今天或昨天时算活着,否则 currentStreak=0。
 */
export function streakRhythm(
  db: Database.Database,
  opts?: { now?: Date }
): StreakRhythm {
  const days = (
    db
      .prepare(
        `SELECT DISTINCT strftime('%Y-%m-%d', event_at_utc, 'localtime') AS day
         FROM agent_user_messages
         WHERE is_human = 1
           AND strftime('%Y-%m-%d', event_at_utc, 'localtime') IS NOT NULL
         ORDER BY day`
      )
      .all() as { day: string }[]
  ).map((r) => r.day);

  const now = opts?.now ?? new Date();
  const ords = days.map(dayOrdinal); // 已按 day 升序

  // 历史最长:走一遍,相邻差 1 即连续。
  let longestStreak = 0;
  let run = 0;
  let prev: number | null = null;
  for (const o of ords) {
    run = prev !== null && o - prev === 1 ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
    prev = o;
  }

  // 当前连续:从末尾回溯,但只有最近活跃日 = 今天或昨天(grace)才算活着。
  const todayOrd = dayOrdinal(localYmd(now));
  const lastOrd = ords.length ? ords[ords.length - 1] : null;
  let currentStreak = 0;
  if (lastOrd !== null && (lastOrd === todayOrd || lastOrd === todayOrd - 1)) {
    currentStreak = 1;
    for (let i = ords.length - 2; i >= 0; i--) {
      if (ords[i] === ords[i + 1] - 1) currentStreak++;
      else break;
    }
  }

  return {
    currentStreak,
    longestStreak,
    todayActive: lastOrd === todayOrd,
    lastActiveDay: days.length ? days[days.length - 1] : null,
    totalActiveDays: days.length,
    generatedAt: now.toISOString(),
  };
}

export type CommandRank = { name: string; count: number };
export type CommandLeaderboard = {
  /** 按次数降序、平局 name 升序,取 top limit。 */
  commands: CommandRank[];
  /** 榜首次数(占比条标度);空库 0(前端防除零)。 */
  maxCount: number;
  /** 有效命令调用总数(路径守卫后)。 */
  totalCommands: number;
  distinctCommands: number;
  generatedAt: string;
};

/**
 * 命令名 = 去掉开头 '/' 后的首个空白前 token。
 * 路径守卫:token 含 '/'(如绝对路径 /tmp/a/b)→ null(不是命令);单 '/' → null。
 */
export function extractCommandName(cleaned: string): string | null {
  if (!cleaned.startsWith("/")) return null;
  const token = cleaned.slice(1).split(/\s/, 1)[0];
  if (!token || token.includes("/")) return null;
  return token;
}

/**
 * 命令 / 技能用量排行(纯排行:top N + 次数)。
 * cleaned_text LIKE '/%' 的 is_human 消息,TS 侧提名 + 路径守卫 + 计数。
 */
export function commandLeaderboard(
  db: Database.Database,
  opts?: { now?: Date; limit?: number }
): CommandLeaderboard {
  const limit = opts?.limit ?? 10;
  const rows = db
    .prepare(
      `SELECT cleaned_text AS text
       FROM agent_user_messages
       WHERE is_human = 1 AND cleaned_text LIKE '/%'`
    )
    .all() as { text: string }[];

  const tally = new Map<string, number>();
  let totalCommands = 0;
  for (const r of rows) {
    const name = extractCommandName(r.text);
    if (!name) continue;
    tally.set(name, (tally.get(name) ?? 0) + 1);
    totalCommands++;
  }

  const commands = [...tally.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);

  const now = opts?.now ?? new Date();
  return {
    commands,
    maxCount: commands.length ? commands[0].count : 0,
    totalCommands,
    distinctCommands: tally.size,
    generatedAt: now.toISOString(),
  };
}

export type WeekMix = {
  week: string; // 'YYYY-Www'(本地周,按字典序=时间序)
  claude: number;
  codex: number;
  opencode: number;
  total: number;
};
export type SourceTrend = { weeks: WeekMix[]; generatedAt: string };

/**
 * 三源迁移周趋势:按本地周分桶,统计 claude/codex/opencode 各自的 is_human 消息数。
 * 坏时间戳守卫(strftime NULL → 剔除,同热力图口径)。
 */
export function weeklySourceMix(
  db: Database.Database,
  opts?: { now?: Date }
): SourceTrend {
  const weeks = db
    .prepare(
      `SELECT strftime('%Y-W%W', event_at_utc, 'localtime') AS week,
              SUM(source = 'claude')   AS claude,
              SUM(source = 'codex')    AS codex,
              SUM(source = 'opencode') AS opencode,
              COUNT(*)                 AS total
       FROM agent_user_messages
       WHERE is_human = 1
         AND strftime('%Y-W%W', event_at_utc, 'localtime') IS NOT NULL
       GROUP BY week
       ORDER BY week`
    )
    .all() as WeekMix[];

  const now = opts?.now ?? new Date();
  return { weeks, generatedAt: now.toISOString() };
}
