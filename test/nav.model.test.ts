import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NAV_GROUPS,
  PRIMARY_ITEMS,
  SETTINGS_ITEM,
  allNavDestinations,
  resolveNav,
} from "../web/src/components/navModel.js";

/**
 * 侧栏导航的模型层。
 *
 * 为什么值得单独测:改造前侧栏有 41 个一级入口,一屏只放得下约 15 个(实测内容高
 * 1638px / 可见 609px)。改造把其中 17 个降成页内 tab,一级入口降到 24 —— 而「降级」
 * 意味着一批路由不再有自己的侧栏行,只能通过父条目的 tab 到达。
 *
 * 这类改造最容易出的事故是**悄悄弄丢一个页面**:某条路由既不在侧栏里,也不在任何
 * tab 里,于是除了手输 URL 没有任何入口,而且没有任何东西会报错。下面
 * 「每条静态路由都能被导航到达」那条测试就是防这个的。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const APP_TSX = join(HERE, "..", "web", "src", "App.tsx");

/** 从 App.tsx 里抠出真实声明的路由,而不是手抄一份会漂移的清单。 */
function declaredStaticRoutes(): string[] {
  const src = readFileSync(APP_TSX, "utf8");
  // `/` 曾经被排除在外,因为那时它只是一句 `<Navigate to="/dashboard">`,不是目的地。
  // 现在它是「今天」这一页,既在路由表里也在侧栏常驻位上,必须参与死链和可达性检查。
  return [...src.matchAll(/<Route\s+path="([^"]+)"/g)]
    .map((m) => m[1] as string)
    .filter((p) => p !== "*" && !p.includes(":"));
}

describe("resolveNav — 路径落到哪个组、哪个条目", () => {
  it("条目自身的路径", () => {
    const m = resolveNav("/replay");
    expect(m.groupId).toBe("timeline");
    expect(m.item?.label).toBe("那天回放");
  });

  it("tab 的路径落到它的父条目,并带出整条 tab 列表", () => {
    const m = resolveNav("/dashboard/tokens-trend");
    expect(m.item?.to).toBe("/dashboard");
    // 「最近工作」是常驻条目(它是首页),不属于任何组 —— 但 tab 解析必须和组内条目
    // 一样工作,这正是常驻分支曾经漏掉的那一格。
    expect(m.groupId).toBeNull();
    expect(m.tabs.map((t) => t.label)).toEqual([
      "总览",
      "Token 排行",
      "Token 趋势",
      "产出效率",
      "对话宇宙",
    ]);
    expect(m.activeTab?.to).toBe("/dashboard/tokens-trend");
  });

  it("tab 不必是父条目的子路径", () => {
    // Chrome 下载是 /chrome-downloads,不在 /chrome-history 底下,但它是同一组视图。
    const m = resolveNav("/chrome-downloads");
    expect(m.item?.label).toBe("Chrome");
    expect(m.activeTab?.label).toBe("下载");
  });

  it("matchChildren 的条目吃掉自己的详情页", () => {
    expect(resolveNav("/repos/633/file").item?.label).toBe("仓库");
  });

  it("tab 的详情页归它的 tab", () => {
    // 会话详情页 /claude-code-history/s/<id> 必须保持父条目和 Claude tab 高亮,
    // 否则从列表点进一条会话,侧栏就失去了高亮。
    const m = resolveNav("/claude-code-history/s/abc123");
    expect(m.item?.label).toBe("AI 对话记录");
    expect(m.activeTab?.label).toBe("Claude");
  });

  it("前缀不算命中 —— 只有完整路径段才算", () => {
    // /dashboard-x 不该命中 /dashboard。
    expect(resolveNav("/dashboard-x").item).toBeNull();
  });

  it("不认识的路径给出空结果而不是抛错", () => {
    const m = resolveNav("/nope");
    expect(m.item).toBeNull();
    expect(m.groupId).toBeNull();
    expect(m.tabs).toEqual([]);
  });

  it("没有 tab 的条目返回空 tab 列表 —— 顶栏据此决定要不要出现", () => {
    expect(resolveNav("/providers").tabs).toEqual([]);
  });

  it("常驻条目也要能解析出来 —— 它们不在任何组里", () => {
    // 漏了这两条的后果:侧栏上「AI 对话」和「设置」永远不高亮。第一版就是这么写的
    // (只遍历 NAV_GROUPS),是 App.test.tsx 里一条既有用例抓出来的。
    const chat = resolveNav("/ai-chat");
    expect(chat.item?.label).toBe("AI 对话");
    expect(chat.groupId).toBeNull();
    expect(chat.tabs).toEqual([]);

    expect(resolveNav("/settings").item?.label).toBe("设置");
  });

  it("带 tab 的常驻条目,tab 也要能选中", () => {
    // 「最近工作」从组里提成常驻时踩到的洞:常驻分支原来只判 `pathname === item.to`
    // 并把 activeTab 写死成 null。当时常驻的两个条目都没有 tab,所以那是段死代码 ——
    // code review 也因此判它是死分支。直到一个带 5 个 tab 的条目搬进来,它就承重了。
    // 现在两条路径共用 matchItem。
    const m = resolveNav("/dashboard/cosmos");
    expect(m.item?.label).toBe("最近工作");
    expect(m.activeTab?.label).toBe("对话宇宙");
  });
});

describe("导航配置的完整性", () => {
  it("每条静态路由都能从导航到达", () => {
    // 这条是整个改造的安全网。/search 是 ⌘K 的结果页,故意不进导航。
    const reachable = new Set(allNavDestinations());
    const missing = declaredStaticRoutes().filter(
      (p) => p !== "/search" && !reachable.has(p)
    );
    expect(missing).toEqual([]);
  });

  it("导航里没有指向不存在路由的死链", () => {
    const declared = new Set(declaredStaticRoutes());
    expect(allNavDestinations().filter((d) => !declared.has(d))).toEqual([]);
  });

  it("没有一个路径出现两次", () => {
    const all = allNavDestinations();
    expect(all.length).toBe(new Set(all).size);
  });

  it("有 tab 的条目,第一个 tab 就是它自己", () => {
    // 点侧栏进来落在第一个 tab 上,而顶栏第一项必须是当前页 —— 否则会出现
    // 「侧栏高亮了这个条目,但顶栏没有任何 tab 是选中的」。
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        if (item.tabs === undefined) continue;
        expect(item.tabs[0]?.to, `${item.label} 的第一个 tab`).toBe(item.to);
      }
    }
  });

  it("图标不重复 —— 收起态下图标是唯一的区分手段", () => {
    // 改造前有 8 个字形被用了两次(BrainCircuit 同时是「AI 对话」和「LM Studio」,
    // Search 三处…),收起态下那些目的地在视觉上无法区分。
    const icons = [
      ...NAV_GROUPS.map((g) => g.icon),
      ...NAV_GROUPS.flatMap((g) => g.items.map((i) => i.icon)),
      ...PRIMARY_ITEMS.map((i) => i.icon),
      SETTINGS_ITEM.icon,
    ];
    expect(icons.length).toBe(new Set(icons).size);
  });

  it("一级入口数量压在一屏放得下的范围内", () => {
    // 手风琴最坏情况 = 6 个组头 + 最大一组。行高约 38px,可见高度 609px(800 窗口)。
    const biggest = Math.max(...NAV_GROUPS.map((g) => g.items.length));
    expect((NAV_GROUPS.length + biggest) * 38).toBeLessThan(609);
  });
});
