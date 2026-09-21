import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

/**
 * 三处填路径的地方都接上了目录选择器。
 *
 * 跑在真实 Electron 外壳里(preload 真的加载了),连到一个隔离的 daemon ——
 * 不碰开发者真实的 8787 与 ~/.ai2nao。对话框不真弹:只断言按钮在,
 * 点它会弹出一个等人点的窗口,无人值守的测试不能那么干。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "..", "out", "main.js");
const PORT = process.env.PICKER_E2E_PORT ?? "8796";

/**
 * 这条要一个跑着的 daemon 才有设置页可看,所以够不到就跳过 ——
 * 与 kimi / cherry 那些 realData 测试同一个做法:条件跳过,而不是在别人的机器上变红。
 * 本地验的时候:
 *   ai2nao serve --port 8796 --db <隔离库>   然后 npx playwright test e2e/pickerWiring.spec.ts
 */
async function daemonReachable(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/settings`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

test("扫描根、RAG 语料、雷达目录三处都有「选择」按钮", async () => {
  test.skip(!(await daemonReachable()), `127.0.0.1:${PORT} 上没有 daemon,跳过`);
  const app = await electron.launch({
    args: [MAIN],
    env: {
      ...process.env,
      AI2NAO_RUN_DIR: mkdtempSync(join(tmpdir(), "ai2nao-wiring-run-")),
      AI2NAO_SHELL_NO_AUTOSTART: "1",
      AI2NAO_SHELL_PORT: PORT,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.goto(`http://127.0.0.1:${PORT}/settings`);
  await page.waitForSelector("text=默认扫描根目录", { timeout: 20_000 });

  // 通用设置栏:扫描根目录
  const scan = page.locator("section", { hasText: "默认扫描根目录" }).first();
  await expect(scan.getByRole("button", { name: /选择/ })).toBeVisible();

  // 数据源栏:雷达目录
  await page.getByRole("button", { name: "数据源" }).first().click();
  const radar = page.locator("section", { hasText: "开源雷达 · 当前工作目录" }).first();
  await expect(radar.getByRole("button", { name: /选择目录/ })).toBeVisible();

  // RAG 栏:语料根目录
  await page.getByRole("button", { name: "RAG 知识库" }).first().click();
  // 锚点不能用「语料库」:上面「RAG 向量化」那个分区的说明里也有这三个字
  // (「语料根目录在下面『语料库』里管」),.first() 会选中它。
  const corpus = page.locator("section", { hasText: "ai2nao rag ingest 会扫描" }).first();
  await expect(corpus.getByRole("button", { name: /^选择$/ })).toBeVisible();

  await app.close();
});
