import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROBES } from "../src/home/leads.js";
import { ROUTE_PATHS, isKnownRoute } from "../web/src/routes.js";

/**
 * 深链正确性。
 *
 * 服务端的探针(src/home)和前端的路由表(web/src)分属两个 tsconfig,生产代码不能互相
 * import —— 根 tsconfig 的 include 只有 src/**。只有测试能同时看见两边,所以这条断言
 * 只可能写在这里。
 *
 * 第二条测试守的是 web/src/routes.ts 别变成「第二份路由表」:直接解析 App.tsx 的
 * `<Route path="...">`,两边集合必须完全相等。
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function routePathsDeclaredInApp(): string[] {
  const src = readFileSync(join(REPO_ROOT, "web/src/App.tsx"), "utf8");
  const found = [...src.matchAll(/<Route\s[^>]*?path="([^"]+)"/gs)].map((m) => m[1]);
  return [...new Set(found)];
}

describe("首页线索的深链", () => {
  it("每条探针的 href 都命中路由表", () => {
    expect(PROBES.length).toBeGreaterThan(0);
    // href 声明在探针上,所以**不用跑数据库**就能全量检查。早先那版是先 run() 再看返回的
    // lead.href —— 探针今天没话说就返回 null,循环一次都不进,那种测试是假绿。
    for (const probe of PROBES) {
      expect(isKnownRoute(probe.href), `${probe.id} 的 href ${probe.href} 不是真路由`).toBe(true);
    }
  });

  it("web/src/routes.ts 与 App.tsx 声明的路由完全一致(防第二份路由表)", () => {
    const declared = routePathsDeclaredInApp().sort();
    // 解析没抓到东西就说明正则失效了 —— 宁可红,也不要静默通过。
    expect(declared.length).toBeGreaterThan(40);
    expect(declared).toEqual([...ROUTE_PATHS].sort());
  });

  it("isKnownRoute:具体路径能匹配带参数的模式,段数不同不匹配", () => {
    expect(isKnownRoute("/repos/42")).toBe(true);
    expect(isKnownRoute("/repos/42/file")).toBe(true);
    expect(isKnownRoute("/repos/42/file?path=a.ts")).toBe(true);
    expect(isKnownRoute("/codex-history/s/abc-123")).toBe(true);
    expect(isKnownRoute("/dashboard/tokens-trend")).toBe(true);

    expect(isKnownRoute("/repos/42/file/extra")).toBe(false);
    expect(isKnownRoute("/nope")).toBe(false);
    expect(isKnownRoute("/dashboard/nope")).toBe(false);
    // 少一段不能靠 :param 蒙混过去
    expect(isKnownRoute("/repos")).toBe(true);
    expect(isKnownRoute("/atuin/directories/x")).toBe(false);
  });
});
