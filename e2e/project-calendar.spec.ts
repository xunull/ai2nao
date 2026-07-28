import { test, expect, type Page } from "@playwright/test";

/**
 * 项目活动日历的两条端到端路径 —— 单测覆盖不到的那两条:
 *   1. 布局铁律:单日 15 个项目时,整页不出垂直滚动条、任何情况下不出横向滚动条,
 *      卡片区在自己的容器里滚。这是改样式最容易静默退化的地方。
 *   2. 同步链路:点「立即同步」→ 进度推进 → 水位从「不完整」变成「已同步」。
 */

const TODAY = "2026-07-28";
// gitleaks:全部假路径。
const LONG_SLUG =
  "-w-x-some-really-long-vendor-namespace-ai-gateway-new-api-service";

function project(i: number) {
  return {
    key: `-w-x-proj-${i}`,
    name: `project-${i}`,
    path: `/w/x/proj-${i}`,
    messageCount: 40 - i,
    bySource: [
      { source: "claude", count: 30 - i },
      { source: "codex", count: 10 },
    ],
    firstAtMs: Date.parse("2026-07-28T01:12:00Z"),
    lastAtMs: Date.parse("2026-07-28T15:40:00Z"),
    firstHumanText: `第 ${i} 个项目当天的第一句话，写长一点好验证 truncate 行为不出横向滚动条`,
    commits: [
      { hash: `c${i}a`, subject: `feat: 第 ${i} 个项目的提交主题写得非常非常长用来测试截断`, atMs: 1 },
      { hash: `c${i}b`, subject: "fix: 第二个", atMs: 2 },
      { hash: `c${i}c`, subject: "chore: 第三个", atMs: 3 },
      { hash: `c${i}d`, subject: "docs: 第四个", atMs: 4 },
    ],
  };
}

type SyncState = { synced: boolean };

async function mockCalendar(
  page: Page,
  opts: { projectCount: number; sync: SyncState }
) {
  const projects = Array.from({ length: opts.projectCount }, (_, i) => project(i));
  // 一个超长 slug 且归不到仓库 —— 专门用来撑横向宽度。
  projects.push({
    ...project(99),
    key: LONG_SLUG,
    name: LONG_SLUG,
    path: null as unknown as string,
  });

  await page.route("**/api/project-calendar/month**", (route) =>
    route.fulfill({
      json: {
        ok: true,
        year: 2026,
        month: 7,
        days: [
          {
            day: TODAY,
            projectCount: projects.length,
            messageCount: 900,
            commitCount: 40,
            commitOnlyProjectCount: 2,
          },
        ],
        serverToday: TODAY,
        dataStartDay: "2026-04-24",
      },
    })
  );

  await page.route("**/api/project-calendar/day**", (route) =>
    route.fulfill({
      json: {
        ok: true,
        date: TODAY,
        projectCount: projects.length,
        messageCount: 900,
        commitCount: 40,
        projects,
        commitOnlyProjects: [
          {
            key: "-w-y-gstack",
            name: "gstack",
            path: "/w/y/gstack",
            commits: [{ hash: "z1", subject: "只提交没对话", atMs: 1 }],
          },
        ],
      },
    })
  );

  await page.route("**/api/project-calendar/sync-status**", (route) =>
    route.fulfill({
      json: {
        ok: true,
        coverage: opts.sync.synced
          ? {
              totalRepos: 796,
              scannedRepos: 796,
              okCount: 796,
              failedCount: 0,
              neverScanned: 0,
              lastScanAt: "2026-07-28T10:00:00.000Z",
              cutoffDay: TODAY,
            }
          : {
              totalRepos: 796,
              scannedRepos: 774,
              okCount: 758,
              failedCount: 16,
              neverScanned: 22,
              lastScanAt: "2026-07-06T03:12:39.648Z",
              cutoffDay: "2026-07-06",
            },
        progress: {
          running: false,
          done: opts.sync.synced ? 796 : 0,
          total: 796,
          startedAt: null,
          finishedAt: null,
          lastStatus: opts.sync.synced ? "success" : null,
          errorSummary: null,
        },
      },
    })
  );

  await page.route("**/api/project-calendar/sync-commits", async (route) => {
    opts.sync.synced = true;
    await route.fulfill({ json: { ok: true } });
  });
}

test("单日 15 个项目:不出横向滚动条,日历 sticky 不跑掉,垂直滚动交给 main", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockCalendar(page, { projectCount: 15, sync: { synced: false } });

  await page.goto("/project-calendar");
  await expect(page.getByRole("heading", { name: "项目活动日历" })).toBeVisible();
  await expect(page.getByText("project-0")).toBeVisible();

  const cards = page.getByTestId("project-calendar-cards");
  await expect(cards).toBeVisible();

  // ① 任何地方都不出横向滚动条 —— 长 slug 和长 commit subject 必须 truncate。
  //    这是项目铁律,也是最容易被一次样式改动静默破坏的地方。
  const docScrollsX = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1
  );
  expect(docScrollsX).toBe(false);

  const cardsScrollX = await cards.evaluate(
    (el) => el.scrollWidth > el.clientWidth + 1
  );
  expect(cardsScrollX).toBe(false);

  // ② 垂直滚动由 Layout 的 <main> 承担(全站一致),document 本身永不滚。
  const main = page.locator("#main-content");
  const mainScrolls = await main.evaluate(
    (el) => el.scrollHeight > el.clientHeight
  );
  expect(mainScrolls).toBe(true);

  const docScrollsY = await page.evaluate(
    () =>
      document.documentElement.scrollHeight >
      document.documentElement.clientHeight + 1
  );
  expect(docScrollsY).toBe(false);

  // ③ 滚到底之后日历仍然可见(sticky 生效),不用滚回去才能换日期。
  await main.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(page.getByRole("grid")).toBeInViewport();
});

test("提交同步:点按钮 → 水位从「不完整」变成已同步,提交栏不再显示未同步", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockCalendar(page, { projectCount: 3, sync: { synced: false } });

  await page.goto("/project-calendar");

  // 初始:水位落后,提交栏说「未同步」而不是「0 个提交」
  await expect(page.getByText(/上次扫描 2026-07-06/)).toBeVisible();
  await expect(page.getByText("22 从未扫描", { exact: false })).toBeVisible();
  await expect(page.getByText(/提交未同步/).first()).toBeVisible();

  await page.getByRole("button", { name: "立即同步" }).click();

  // 同步后:水位推到今天,提交栏显示真实数字
  await expect(page.getByText(new RegExp(`上次扫描 ${TODAY}`))).toBeVisible();
  await expect(page.getByText(/提交未同步/)).toHaveCount(0);
  await expect(page.getByText("4 个提交").first()).toBeVisible();
});

test("「仅有提交、无对话」折叠区能展开", async ({ page }) => {
  await mockCalendar(page, { projectCount: 2, sync: { synced: false } });

  await page.goto("/project-calendar");

  const toggle = page.getByRole("button", { name: /仅有提交、无对话/ });
  await expect(toggle).toBeVisible();
  await expect(page.getByText("gstack")).toHaveCount(0);

  await toggle.click();
  await expect(page.getByText("gstack")).toBeVisible();
});
