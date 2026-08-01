import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 打包出来的 `.app` 对用户自称什么。
 *
 * 这是 packageRoot.test.ts 开头记的那个 bug 的**第二次发作**:那次是
 * `ai2nao --version` 印 0.1.0 而 package.json 写着 0.4.0。桌面壳原样重演了一遍,
 * 因为它有自己的 package.json,而没有人让两边对齐:
 *
 *   About ai2nao-desktop      ← 菜单项,来自 app.getName()
 *   Quit ai2nao-desktop
 *   CFBundleShortVersionString = 0.1.0   ← 而内嵌的 daemon 报 0.4.0
 *
 * 两个字段各自被谁读走,是这里唯一需要记住的事:
 *
 *   build.productName  → electron-builder → CFBundleName  → **菜单标题**
 *   顶层 productName    → Electron 运行时  → app.getName() → **菜单项文字**
 *
 * 只配了前者(当时的状态),菜单标题写着 ai2nao 而菜单项写着 ai2nao-desktop ——
 * 同一个菜单里两个名字。所以两处都得有。
 *
 * 这个文件的存在理由是防漂移:版本号迟早还要涨,而没有人会记得桌面壳这一份。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

function readPkg(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO, rel), "utf8")) as Record<string, unknown>;
}

describe("桌面壳的身份不能是继承来的默认值", () => {
  it("顶层 productName 是 ai2nao —— app.getName() 读的是它,菜单项文字靠它", () => {
    // 少了这条,About / Hide / Quit 三处都会退回 name 字段(ai2nao-desktop)。
    expect(readPkg("desktop/package.json").productName).toBe("ai2nao");
  });

  it("build.productName 也是 ai2nao —— CFBundleName 靠它,菜单标题和 Finder 显示名靠它", () => {
    const build = readPkg("desktop/package.json").build as Record<string, unknown>;
    expect(build.productName).toBe("ai2nao");
  });

  it("桌面壳的版本号跟仓库根一致 —— 它打包的正是根仓库那份 daemon", () => {
    // `.app` 里的 daemon 由 desktop/build.mjs 从根仓库打包而来,版本号也是从根同步
    // 过去的。壳自己再报一个不同的数字,About 面板就会和 /api/health 对不上。
    expect(readPkg("desktop/package.json").version).toBe(readPkg("package.json").version);
  });
});
