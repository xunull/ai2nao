import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildActivityCalendar } from "../src/aiRhythm/queries.js";
import { renderCalendarSvg } from "../src/cards/calendarSvg.js";
import { createApp } from "../src/serve/app.js";
import { openDatabase } from "../src/store/open.js";

/** 本地 Y-M-D(与 buildActivityCalendar 内部口径一致)。 */
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;

const NOW = new Date("2026-07-22T12:00:00"); // 本地某天(具体星期由 getDay() 决定)
const TODAY = ymd(NOW);

describe("buildActivityCalendar", () => {
  it("列=周数、每列 7 行;总数/活跃天/峰值正确", () => {
    const counts = new Map([
      [TODAY, 5],
      ["2026-07-20", 2],
    ]);
    const cal = buildActivityCalendar(counts, NOW, 4);

    expect(cal.weeks.length).toBe(4);
    expect(cal.weeks.every((w) => w.length === 7)).toBe(true);
    expect(cal.total).toBe(7);
    expect(cal.activeDays).toBe(2);
    expect(cal.maxCount).toBe(5);
    expect(cal.weekCount).toBe(4);
  });

  it("今天落在最后一列、行=本地 weekday;今天之后的未来日=null", () => {
    const cal = buildActivityCalendar(new Map([[TODAY, 5]]), NOW, 4);
    const lastCol = cal.weeks[3];
    const todayCell = lastCol[NOW.getDay()];
    expect(todayCell?.date).toBe(TODAY);
    expect(todayCell?.count).toBe(5);
    for (let r = NOW.getDay() + 1; r < 7; r++) {
      expect(lastCol[r]).toBeNull(); // 未来日
    }
  });

  it("空数据 → 合法结构、无活跃、maxCount 0", () => {
    const cal = buildActivityCalendar(new Map(), NOW, 6);
    expect(cal.total).toBe(0);
    expect(cal.activeDays).toBe(0);
    expect(cal.maxCount).toBe(0);
    expect(cal.monthLabels.length).toBeGreaterThan(0); // 至少标一个月份
  });
});

describe("renderCalendarSvg", () => {
  const rectCount = (svg: string) => (svg.match(/<rect/g) ?? []).length;

  it("合法 SVG;rect 数 = 窗口内天数 + 背景;峰值最深;footer 正确", () => {
    const cal = buildActivityCalendar(new Map([[TODAY, 5]]), NOW, 4);
    const svg = renderCalendarSvg(cal);
    const inWindow = cal.weeks.flat().filter(Boolean).length;

    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trim().endsWith("</svg>")).toBe(true);
    expect(rectCount(svg)).toBe(inWindow + 1); // +1 背景
    expect(svg).toContain("#216e39"); // count=5 是 max → 最深档
    expect(svg).toContain("共 5 次");
    expect(svg).toContain("活跃 1 天");
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("undefined");
  });

  it("空数据 → 合法 SVG、无 NaN、无深色格", () => {
    const svg = renderCalendarSvg(buildActivityCalendar(new Map(), NOW, 6));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("共 0 次");
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("#216e39");
  });

  it("确定性:同输入 → 同输出", () => {
    const cal = buildActivityCalendar(new Map([[TODAY, 3]]), NOW, 8);
    expect(renderCalendarSvg(cal)).toBe(renderCalendarSvg(cal));
  });
});

describe("GET /api/cards/calendar.svg", () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai2nao-cal-"));
    db = openDatabase(join(dir, "index.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("返回 image/svg+xml,body 是 SVG(空库不报错)", async () => {
    const app = createApp({ db });
    const res = await app.request("http://x/api/cards/calendar.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    const body = await res.text();
    expect(body.startsWith("<svg")).toBe(true);
    expect(body).toContain("共 0 次");
  });
});
