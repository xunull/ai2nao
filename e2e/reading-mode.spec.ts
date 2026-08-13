import { test, expect, type Page } from "@playwright/test";

/**
 * 阅读模式开关的**位置**行为,只能在真实浏览器里验。
 *
 * vitest 用的 jsdom 没有排版引擎:所有元素高度恒为 0,虚拟列表算不出可视区,
 * 「切换后那条消息还在不在视口顶部」写成单测会永远绿 —— 因为没有任何东西真的有高度。
 * 纯计算部分(computeAnchorIndex)在 test/conversationFilter.test.ts 里单测,
 * 这里只管「算完之后真的滚到了没」。
 */

const SESSION_URL =
  "/claude-code-history/s/sess-e2e?projectId=proj-e2e";

/** 造一段高度参差的会话:真人消息、AI 长短不一的正文,中间夹大量会被滤掉的噪音。 */
function buildMessages(): unknown[] {
  const out: unknown[] = [];
  let t = Date.parse("2026-06-29T00:00:00.000Z");
  const stamp = () => new Date((t += 60_000)).toISOString();

  for (let round = 0; round < 40; round++) {
    out.push({
      id: `u-${round}`,
      role: "user",
      content: `第 ${round} 轮提问`,
      timestamp: stamp(),
    });
    // AI 正文长度刻意不均 —— 等高的话就测不出「估算行高 180 与真实高度不符」这个问题。
    const bulk = "内容".repeat(round % 7 === 0 ? 300 : 12);
    out.push({
      id: `a-${round}`,
      role: "assistant",
      content: `第 ${round} 轮回答开头。${bulk}`,
      timestamp: stamp(),
    });
    // 噪音:纯工具调用 / 工具结果 / 系统事件。阅读模式下全部消失。
    out.push({
      id: `tool-${round}`,
      role: "assistant",
      content: "",
      timestamp: stamp(),
      metadata: { readingHidden: "tool-only" },
    });
    out.push({
      id: `res-${round}`,
      role: "user",
      content: "",
      timestamp: stamp(),
      metadata: { readingHidden: "tool-only" },
    });
    out.push({
      id: `ev-${round}`,
      role: "assistant",
      content: "```json\n{\"snapshot\":true}\n```",
      timestamp: stamp(),
      metadata: {
        claudeAppendix: true,
        claudeEventType: "file-history-snapshot",
        readingHidden: "appendix",
      },
    });
  }
  return out;
}

async function mockSession(page: Page): Promise<void> {
  const all = buildMessages();
  await page.route("**/api/claude-code-history/**", async (route) => {
    const url = route.request().url();
    if (url.includes("meta=1")) {
      await route.fulfill({
        json: {
          ok: true,
          header: {
            messageCount: all.length,
            createdAt: "2026-06-29T00:00:00.000Z",
            lastUpdatedAt: "2026-06-29T05:00:00.000Z",
            firstUserText: "第 0 轮提问",
            title: "阅读模式 e2e 会话",
            preview: "第 0 轮提问",
            workspacePath: "/w/x/repo",
            warnings: [],
          },
        },
      });
      return;
    }
    const cursor = Number(new URL(url).searchParams.get("cursor") ?? 0);
    const limit = Number(new URL(url).searchParams.get("limit") ?? 50);
    const slice = all.slice(cursor, cursor + limit);
    const end = cursor + slice.length;
    await route.fulfill({
      json: {
        ok: true,
        messages: slice,
        nextCursor: end < all.length ? end : null,
        hasMore: end < all.length,
      },
    });
  });
}

/**
 * 当前视口里能看到的「第 N 轮」编号,按从上到下。
 *
 * 不断言「顶部那张卡完全相同」有两个原因:一是切换前顶部很可能正好是噪音卡(appendix /
 * 空消息),它切换后本就该消失、锚点顺移到其后第一条可见的;二是 D5 明确接受一张卡内的偏移。
 * 真正要守的是「原来在读的那一轮,切换后仍在眼前」。
 */
async function visibleRounds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll("article"))) {
      const r = el.getBoundingClientRect();
      if (r.bottom > 80 && r.top < window.innerHeight) {
        const m = (el.textContent ?? "").match(/第 (\d+) 轮/);
        if (m) out.push(m[1]);
      }
    }
    return out;
  });
}

test.describe("会话详情页 · 阅读模式开关", () => {
  test.beforeEach(async ({ page }) => {
    await mockSession(page);
  });

  test("打开开关后噪音消失,关闭后回来", async ({ page }) => {
    await page.goto(SESSION_URL);
    await expect(page.getByRole("heading", { name: "阅读模式 e2e 会话" })).toBeVisible();
    await expect(page.getByText("file-history-snapshot").first()).toBeVisible();

    await page.getByRole("switch", { name: "只看对话" }).click();
    await expect(page.getByText("file-history-snapshot")).toHaveCount(0);
    await expect(page.getByText("（空消息）")).toHaveCount(0);
    await expect(page.getByText("第 0 轮回答开头").first()).toBeVisible();

    await page.getByRole("switch", { name: "只看对话" }).click();
    await expect(page.getByText("file-history-snapshot").first()).toBeVisible();
  });

  test("读到中段按开关,视口顶部仍是同一条消息", async ({ page }) => {
    await page.goto(SESSION_URL);
    await expect(page.getByRole("heading", { name: "阅读模式 e2e 会话" })).toBeVisible();

    // 滚到会话中段,等虚拟列表稳定。
    const scroller = page.locator("div.overflow-y-auto").first();
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight / 3;
    });
    await page.waitForTimeout(400);

    const before = await visibleRounds(page);
    const anchor = before[0];
    expect(anchor, "滚动后视口里应至少有一轮对话").toBeDefined();

    /**
     * 容差 ±1 轮,对应设计里 R3 明确接受的「最多一张卡的偏移」:
     * scrollToIndex 只能定位到卡,定不到合并卡内的某一段;而 ROW_ESTIMATE(180)与真实卡高
     * 差距很大,锚点之上从未渲染过的行只能用估值。实测偏移约 535px ≈ 一张长卡。
     * 真正要守住的是「没跳回顶部、还在原地附近」——不是像素级复位。
     */
    const nearAnchor = (rounds: string[]) =>
      rounds.some((r) => Math.abs(Number(r) - Number(anchor)) <= 1);

    await page.getByRole("switch", { name: "只看对话" }).click();
    await page.waitForTimeout(1200);
    const afterOn = await visibleRounds(page);
    expect(
      nearAnchor(afterOn),
      `打开开关后应仍在第 ${anchor} 轮附近,实际视口: ${JSON.stringify(afterOn)}`
    ).toBe(true);

    // 再切回去 —— 反向也要锚定,否则开关只能单向用。
    await page.getByRole("switch", { name: "只看对话" }).click();
    await page.waitForTimeout(1200);
    const afterOff = await visibleRounds(page);
    expect(
      nearAnchor(afterOff),
      `关闭开关后应仍在第 ${anchor} 轮附近,实际视口: ${JSON.stringify(afterOff)}`
    ).toBe(true);
  });

  test("开关状态跨页面刷新保持", async ({ page }) => {
    await page.goto(SESSION_URL);
    await page.getByRole("switch", { name: "只看对话" }).click();
    await expect(page.getByText("file-history-snapshot")).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole("heading", { name: "阅读模式 e2e 会话" })).toBeVisible();
    await expect(page.getByRole("switch", { name: "只看对话" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    await expect(page.getByText("file-history-snapshot")).toHaveCount(0);
  });
});
