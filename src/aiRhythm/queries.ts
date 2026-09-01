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
  kimi: number;
  /** 各分列之和(**不是** COUNT(*))—— 见 weeklySourceMix 的注释。 */
  total: number;
};
export type SourceTrend = { weeks: WeekMix[]; generatedAt: string };

/**
 * 使用迁移周趋势:按本地周分桶,统计各源的 is_human 消息数。
 * 坏时间戳守卫(strftime NULL → 剔除,同热力图口径)。
 *
 * **`total` 必须等于各分列之和,不能是 COUNT(*)。** 原来是 COUNT(*)(全源),
 * 而分列只有三个源 —— kimi 从入库起就没被画进这张卡,W34 那周漏掉 124/422 = 29%。
 * 因为是绝对值堆叠面积图,图上不会出现空洞,曲线只是矮一截,看着完全正常。
 *
 * `total` 不是死字段:`cards/sourceTrendSvg.ts:37` 拿它定 Y 轴上限、`:42` 算页脚
 * 「共 N 次」。口径错时那张 SVG 卡的柱子会系统性偏矮 —— 改口径必须同时改这两处的测试。
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
              SUM(source = 'kimi')     AS kimi,
              SUM(source IN ('claude','codex','opencode','kimi')) AS total
       FROM agent_user_messages
       WHERE is_human = 1
         AND strftime('%Y-W%W', event_at_utc, 'localtime') IS NOT NULL
       GROUP BY week
       HAVING total > 0
       ORDER BY week`
    )
    .all() as WeekMix[];

  const now = opts?.now ?? new Date();
  return { weeks, generatedAt: now.toISOString() };
}

export type PersonalRecords = {
  busiestDay: { day: string; count: number } | null; // day 'YYYY-MM-DD'
  peakHour: { hour: string; count: number } | null; // hour 'YYYY-MM-DD HH:00'
  total: number;
  firstDay: string | null;
  maxCharLen: number;
  generatedAt: string;
};

/**
 * 个人纪录/极值(奖杯架):最忙一天、一小时最多、总量+起始日、最大一次输入。
 * 全 MIN/MAX/COUNT;坏时间戳守卫;平局取最早(确定性)。
 */
export function personalRecords(
  db: Database.Database,
  opts?: { now?: Date }
): PersonalRecords {
  const busiestDay =
    (db
      .prepare(
        `SELECT date(event_at_utc, 'localtime') AS day, COUNT(*) AS count
         FROM agent_user_messages
         WHERE is_human = 1 AND date(event_at_utc, 'localtime') IS NOT NULL
         GROUP BY day ORDER BY count DESC, day ASC LIMIT 1`
      )
      .get() as { day: string; count: number } | undefined) ?? null;

  const peakHour =
    (db
      .prepare(
        `SELECT strftime('%Y-%m-%d %H:00', event_at_utc, 'localtime') AS hour, COUNT(*) AS count
         FROM agent_user_messages
         WHERE is_human = 1 AND strftime('%Y-%m-%d %H:00', event_at_utc, 'localtime') IS NOT NULL
         GROUP BY hour ORDER BY count DESC, hour ASC LIMIT 1`
      )
      .get() as { hour: string; count: number } | undefined) ?? null;

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              MIN(date(event_at_utc, 'localtime')) AS firstDay,
              MAX(char_len) AS maxCharLen
       FROM agent_user_messages WHERE is_human = 1`
    )
    .get() as { total: number; firstDay: string | null; maxCharLen: number | null };

  const now = opts?.now ?? new Date();
  return {
    busiestDay,
    peakHour,
    total: totals.total,
    firstDay: totals.firstDay,
    maxCharLen: totals.maxCharLen ?? 0,
    generatedAt: now.toISOString(),
  };
}

export type CalendarCell = { date: string; count: number; row: number };
export type ActivityCalendar = {
  /** [列][行],行 0=周日..6=周六;null=窗口外(超过今天的未来日)。 */
  weeks: (CalendarCell | null)[][];
  /** 月份标签:label 放在第 col 列顶上。 */
  monthLabels: { col: number; label: string }[];
  maxCount: number;
  total: number;
  activeDays: number;
  weekCount: number;
  generatedAt: string;
};

/** 日序号 → 'YYYY-MM-DD'(dayOrdinal 的逆;用 getUTC* 与 Date.UTC 编码对称)。 */
function ordinalToYmd(ord: number): string {
  const dt = new Date(ord * 86400000);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * GitHub 贡献图式活动日历(纯函数,便于测)。列=周(周日→周六),行=星期几;每格=某一天的
 * 消息数。窗口=最近 weeks 周,末列含今天,今天之后的未来日=null(不渲染)。
 */
export function buildActivityCalendar(
  counts: Map<string, number>,
  now: Date,
  weeks: number
): ActivityCalendar {
  const todayOrd = dayOrdinal(localYmd(now));
  const lastSunOrd = todayOrd - now.getDay(); // 本周周日(getDay:0=周日)
  const firstSunOrd = lastSunOrd - (weeks - 1) * 7;

  const weeksArr: (CalendarCell | null)[][] = [];
  const monthLabels: { col: number; label: string }[] = [];
  let maxCount = 0;
  let total = 0;
  let activeDays = 0;
  let prevMonth = -1;

  for (let col = 0; col < weeks; col++) {
    const colSunOrd = firstSunOrd + col * 7;
    const week: (CalendarCell | null)[] = [];
    for (let row = 0; row < 7; row++) {
      const ord = colSunOrd + row;
      if (ord > todayOrd) {
        week.push(null); // 未来日
        continue;
      }
      const date = ordinalToYmd(ord);
      const count = counts.get(date) ?? 0;
      if (count > maxCount) maxCount = count;
      if (count > 0) {
        total += count;
        activeDays++;
      }
      week.push({ date, count, row });
    }
    weeksArr.push(week);

    const firstDay = week.find((c): c is CalendarCell => c !== null);
    if (firstDay) {
      const month = Number(firstDay.date.slice(5, 7));
      if (month !== prevMonth) {
        monthLabels.push({ col, label: `${month}月` });
        prevMonth = month;
      }
    }
  }

  return {
    weeks: weeksArr,
    monthLabels,
    maxCount,
    total,
    activeDays,
    weekCount: weeks,
    generatedAt: now.toISOString(),
  };
}

/**
 * 活动日历:按本地日聚合 is_human 消息数,套 buildActivityCalendar 成 GitHub 式日历。
 * 坏时间戳守卫(date() NULL → 剔除,同热力图口径)。
 */
export function activityCalendar(
  db: Database.Database,
  opts?: { now?: Date; weeks?: number }
): ActivityCalendar {
  const rows = db
    .prepare(
      `SELECT date(event_at_utc, 'localtime') AS day, COUNT(*) AS count
       FROM agent_user_messages
       WHERE is_human = 1 AND date(event_at_utc, 'localtime') IS NOT NULL
       GROUP BY day`
    )
    .all() as { day: string; count: number }[];
  const counts = new Map(rows.map((r) => [r.day, r.count]));
  return buildActivityCalendar(counts, opts?.now ?? new Date(), opts?.weeks ?? 53);
}
