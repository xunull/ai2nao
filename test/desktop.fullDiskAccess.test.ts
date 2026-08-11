import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 壳里那条「完全磁盘访问设置…」菜单项。
 *
 * 静态断言而不是跑起来测:main.ts 一 import 就拉起 electron,而这里真正会出错的
 * 只有两件事 —— URL scheme 写错(点了没反应,而且不报错),以及忘了平台守卫
 * (Windows/Linux 上出现一条点了必然无效的菜单项)。两者读源码就能钉死。
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const main = readFileSync(join(ROOT, "desktop/src/main.ts"), "utf8");

describe("桌面壳:完全磁盘访问引导", () => {
  it("用 macOS 的系统设置 URL scheme,指向 Privacy_AllFiles 那一页", () => {
    // 网页跳不了 x-apple.systempreferences:,浏览器会直接忽略。壳能开,
    // 这是注意力层唯一一处「壳能做而网页做不到」的事。
    expect(main).toContain(
      '"x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"'
    );
  });

  it("菜单项被 darwin 守卫包着", () => {
    // knowledgeC 只在 macOS 存在;别的平台上这条菜单点了必然无效。
    const idx = main.indexOf("完全磁盘访问设置");
    expect(idx).toBeGreaterThan(0);
    const before = main.slice(Math.max(0, idx - 600), idx);
    expect(before).toContain('process.platform === "darwin"');
  });

  it("挂在 daemonActions 上,所以托盘和应用菜单都有", () => {
    // 那个函数的注释写着「同一份模板生成两处,是让它们不可能漂移的唯一办法」。
    // 单独往应用菜单里塞会让托盘少一项,而托盘常常是用户唯一会去的地方。
    const fnStart = main.indexOf("function daemonActions");
    const fnEnd = main.indexOf("\n}", fnStart);
    expect(fnStart).toBeGreaterThan(0);
    const body = main.slice(fnStart, fnEnd);
    expect(body).toContain("完全磁盘访问设置");
  });

  it("说明了授权给壳为什么等于授权给真正读库的进程", () => {
    // daemon 用 ELECTRON_RUN_AS_NODE 跑,和壳是同一个可执行文件 —— 这不是显然的,
    // 而它正是「授给 .app 就够了」这个结论成立的原因。注释掉了这条,下一个人
    // 会以为要给 daemon 单独授权。
    const idx = main.indexOf("完全磁盘访问设置");
    const before = main.slice(Math.max(0, idx - 900), idx);
    expect(before).toMatch(/ELECTRON_RUN_AS_NODE|同一个可执行文件/);
  });
});

describe("桌面壳:签名方式决定授权是否跨构建保持", () => {
  const pkg = JSON.parse(
    readFileSync(join(ROOT, "desktop/package.json"), "utf8")
  ) as { build?: { mac?: Record<string, unknown>; appId?: string } };

  it("显式声明不签名 —— 这个选择有 TCC 后果，不是默认值", () => {
    // build.mac.identity = null 让 electron-builder 跳过签名，产物只带 linker 的
    // ad-hoc 签名。ad-hoc 下 TCC 用 cdhash 认应用；实测 cdhash 来自那个 33KB 的
    // Electron stub，而它在两次构建之间不变（我们的代码在 Resources/ 里，不参与）。
    // 所以改 JS 重新打包授权保持，升 Electron 才会失效。
    // 详见 docs/desktop-manual-checklist.md「完全磁盘访问：重新打包会不会让授权失效」。
    expect(pkg.build?.mac).toHaveProperty("identity");
    expect(pkg.build?.mac?.identity).toBeNull();
  });

  it("appId 与 Info.plist 身份一致(和签名 Identifier 是两回事)", () => {
    // 看 appId 会以为签名身份是 com.xunull.ai2nao；实际 codesign 的 Identifier
    // 是 Electron。别拿这个去推断 TCC 行为。
    expect(pkg.build?.appId).toBe("com.xunull.ai2nao");
  });
});
