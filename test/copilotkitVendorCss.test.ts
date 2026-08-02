import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * AI 对话页的 CopilotKit 样式表不能带 CSS 层叠层。
 *
 * ## 这条测试在防什么
 *
 * `web/public/vendor/copilotkit-v2.css` 是手工 vendored 的 Tailwind **v4** 产物,
 * 而应用自己用的是 Tailwind **v3.4.17**。两者的关键差别不是版本号,是 v4 把所有输出
 * 包进 `@layer`,v3 不包。
 *
 * CSS 层叠规则:**无层样式永远压过有层样式**,与优先级和源顺序都无关。于是 v3 的
 * preflight(`textarea{padding:0;border:0 solid #e5e7eb;font:inherit}`,无层)压掉了
 * CopilotKit 的每一条 `cpk:` 工具类(在 `@layer utilities` 里)。
 *
 * 实测(2026-08-02,同一条规则内容一字不差):
 *
 *   @layer utilities 里   padding-top = 0px
 *   无层                   padding-top = 12px
 *
 * 症状:输入框渲染成一个裸 textarea —— 没边框、没内距、placeholder 折行,用户看到的是
 * 「输入框没了 / 变成什么鬼样子了」。整块只有 CopilotKit 渲染的部分坏,应用自己的标记
 * 正常,因为坏的只是那份 vendored 样式表。
 *
 * ## 为什么盯着文件而不是盯着渲染
 *
 * 没有任何构建步骤生成这个文件 —— 全仓库只有 `web/src/pages/AiChat.tsx` 里一行
 * `<link rel="stylesheet" href="/vendor/copilotkit-v2.css">` 引用它。下一个人升级
 * CopilotKit 时多半是重新导出一份覆盖上去,而 Tailwind v4 默认就带 `@layer` ——
 * 那一刻这个 bug 会**一模一样地回来,而且没有任何东西会报错**。所以断言落在产物上。
 *
 * `@layer properties` 是故意留着的:它在 `*,:before,:after` 上定义 56 个 `--tw-*`
 * 变量,和 Tailwind v3 自己的同名变量撞车。把它拆出层反而会引入新问题,而它不影响
 * 这个 bug。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR_CSS = join(HERE, "..", "web", "public", "vendor", "copilotkit-v2.css");

describe("CopilotKit vendored stylesheet", () => {
  const css = readFileSync(VENDOR_CSS, "utf8");

  it("承载工具类和 reset 的三层不能是 @layer —— 否则被应用的 preflight 全压掉", () => {
    const layered = ["utilities", "base", "theme"].filter((name) =>
      css.includes(`@layer ${name}{`)
    );
    expect(layered).toEqual([]);
  });

  it("composer 用到的类确实在这份样式表里", () => {
    // 不是「有没有 @layer」的替身断言 —— 万一将来有人靠删内容来让上一条通过,这条会挡住。
    for (const cls of ["cpk\\:py-3", "cpk\\:pr-5", "cpk\\:w-full", "cpk\\:bg-transparent"]) {
      expect(css, `${cls} 不在 vendored 样式表里`).toContain(`.${cls}`);
    }
  });

  it("CopilotKit 的 reset 仍然被 [data-copilotkit] 限定作用域", () => {
    // 去掉 @layer base 之所以安全,全靠这一条:那 56 条 reset 每一条都带
    // [data-copilotkit]。哪天重新导出的版本不带这个限定,去层就会把 CopilotKit 的
    // preflight 泼到整个应用上 —— 那比现在的 bug 严重得多。
    const start = css.indexOf(".cpk\\:");
    const resetRegion = css.slice(0, start > 0 ? start : css.length);
    const bareUniversal = /(^|\})\s*\*\s*,\s*:before/.test(resetRegion);
    expect(bareUniversal, "reset 区出现了不受 [data-copilotkit] 限定的 * 选择器").toBe(false);
    expect(css).toContain("[data-copilotkit]");
  });
});
