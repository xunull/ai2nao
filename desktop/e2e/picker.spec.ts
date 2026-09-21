import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

/**
 * preload 的暴露面。
 *
 * 验的是**它有没有被加载**:路径对不对、CJS 格式对不对、`sandbox: true` 下能不能跑 ——
 * 这三件事错任何一件,`window.ai2nao` 就是 undefined。至于 `ipcRenderer.invoke` 能不能
 * 到 `ipcMain.handle`,那是 Electron 自己的事,不在这儿测;真打开对话框更不行 ——
 * 无人值守的测试不能弹一个等人点的窗口。
 *
 * 第二条断言同样要紧:暴露面**只有一个方法**。这个壳在此之前是零暴露面的
 * (webPreferences 里那条注释),开口之后能守的只剩「别再长」。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "..", "out", "main.js");

test("preload 把 pickDirectory 暴露给页面,且只暴露这一个", async () => {
  const app = await electron.launch({
    args: [MAIN],
    env: {
      ...process.env,
      // 与 smoke.spec 同一套隔离:不碰开发者真实的 daemon 记录,不自动起 daemon,
      // 端口指向一个没人用的。
      AI2NAO_RUN_DIR: mkdtempSync(join(tmpdir(), "ai2nao-pick-run-")),
      AI2NAO_SHELL_NO_AUTOSTART: "1",
      AI2NAO_SHELL_PORT: "8399",
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const shape = await page.evaluate(() => {
    const api = (globalThis as { ai2nao?: Record<string, unknown> }).ai2nao;
    return {
      keys: Object.keys(api ?? {}),
      pickType: typeof api?.pickDirectory,
    };
  });

  expect(shape.pickType).toBe("function");
  expect(shape.keys).toEqual(["pickDirectory"]);

  await app.close();
});
