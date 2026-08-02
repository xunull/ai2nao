import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { createApp } from "../src/serve/app.js";

/**
 * dist 根下的静态文件必须真的被送出去,而不是被 SPA 兜底吃掉。
 *
 * ## 这条测试在防什么
 *
 * 静态托管原来只挂在 `/assets/*` 上。但 Vite 把 `web/public/**` 原样拷进 dist 的
 * **根**下(这是 Vite 对 public 目录的定义),不进 assets/。于是那些文件全部落到 SPA
 * 兜底,拿到一份 index.html 和 `content-type: text/html`。
 *
 * 失败模式极其安静 —— HTTP **200**,浏览器不报错,只是那份样式表一条规则都没有:
 *
 *   GET /vendor/copilotkit-v2.css   磁盘 75831 字节
 *                                   返回 447 字节 text/html
 *
 * 实际后果:AI 对话页的输入框渲染成一个没有任何样式的裸 textarea(高 24px、无内距、
 * placeholder 折行),用户描述为「输入框没了」。
 *
 * 而且它**只在 daemon 下暴露**:Vite dev server 正确提供 public/,所以整个开发过程
 * 都看不见。是换到 Electron 应用(读 daemon)之后才炸出来的。
 *
 * 断言用 content-type 而不是状态码,因为坏的时候状态码也是 200 —— 状态码分不开这两种
 * 情况,这正是它当初没被发现的原因。
 */
function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-public-assets-"));
  return openDatabase(join(dir, "test.db"));
}

/** 一个形如构建产物的目录:index.html + public/ 拷过来的文件。 */
function fakeWebDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-webdist-public-"));
  const dist = join(dir, "web", "dist");
  mkdirSync(join(dist, "vendor"), { recursive: true });
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>spa</title>");
  writeFileSync(join(dist, "vendor", "vendored.css"), ".x{color:red}");
  writeFileSync(join(dist, "assets", "app.css"), ".y{color:blue}");
  writeFileSync(join(dist, "robots.txt"), "User-agent: *");
  return dist;
}

describe("dist 根下的静态文件", () => {
  const db = freshDb();
  const app = createApp({ db, staticRoot: fakeWebDist() });

  it("assets/ 之外的文件也要以自己的 content-type 送出", async () => {
    const res = await app.request("http://localhost/vendor/vendored.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(await res.text()).toBe(".x{color:red}");
  });

  it("dist 根下的裸文件同理", async () => {
    const res = await app.request("http://localhost/robots.txt");
    expect(await res.text()).toBe("User-agent: *");
  });

  it("assets/ 下的照旧", async () => {
    const res = await app.request("http://localhost/assets/app.css");
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(await res.text()).toBe(".y{color:blue}");
  });

  it("不存在的路径仍然落到 SPA,前端路由才不会 404", async () => {
    const res = await app.request("http://localhost/dashboard/tokens");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>spa</title>");
  });

  it("/api 下不存在的路径是 404,不能被 SPA 兜底吃掉", async () => {
    const res = await app.request("http://localhost/api/definitely-not-a-route");
    expect(res.status).toBe(404);
  });
});
