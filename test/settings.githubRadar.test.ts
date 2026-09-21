import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/serve/app.js";
import { readGithubRadarCwd } from "../src/github/config.js";
import { settingDto } from "../src/settings/settingApi.js";
import { resetSettingsForTest } from "../src/settings/store.js";
import { openDatabase } from "../src/store/open.js";

/**
 * 开源雷达的「当前工作目录」设置。
 *
 * 存在的理由:洞察重算要靠 git / TODO / 文档回答「你现在在做什么」,而它原来读的是
 * **进程 cwd** —— 打包的桌面版守护进程 cwd 是 `/`,扫出来必然是空。
 *
 * 留空是合法状态,**不回退到进程 cwd**:那会保持一个已知无效的行为。
 */

let dir: string;
let db: Database.Database;
let app: Hono;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai2nao-ghradar-"));
  process.env.AI2NAO_CONFIG_DB = join(dir, "config.db");
  resetSettingsForTest();
  db = openDatabase(join(dir, "idx.db"));
  app = createApp({ db });
});
afterEach(() => {
  db.close();
  resetSettingsForTest();
  rmSync(dir, { recursive: true, force: true });
});

const patch = (body: unknown) =>
  app.request("/api/settings/setting/github-radar", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("github-radar 设置", () => {
  it("存一个存在的目录,读回来是它", async () => {
    const p = join(dir, "proj");
    mkdirSync(p, { recursive: true });
    const res = await patch({ cwd: p });
    expect(res.status).toBe(200);
    expect(settingDto("github-radar").values).toEqual({ cwd: p });
    expect(readGithubRadarCwd()).toBe(p);
  });

  it("不存在的目录 400,且不落库", async () => {
    const res = await patch({ cwd: join(dir, "没有这个目录") });
    expect(res.status).toBe(400);
    expect(readGithubRadarCwd()).toBeNull();
  });

  it("文件不是目录 → 400", async () => {
    const f = join(dir, "a.txt");
    writeFileSync(f, "x", "utf8");
    expect((await patch({ cwd: f })).status).toBe(400);
  });

  it("相对路径 → 400", async () => {
    expect((await patch({ cwd: "relative/dir" })).status).toBe(400);
  });

  it("空串合法,表示不扫当前工作", async () => {
    const res = await patch({ cwd: "" });
    expect(res.status).toBe(200);
    // 空串落库,但读取侧给 null —— 调用方据此跳过扫描,而不是去扫进程 cwd
    expect(settingDto("github-radar").values).toEqual({ cwd: "" });
    expect(readGithubRadarCwd()).toBeNull();
  });

  it("没配过时读取侧是 null,不是进程 cwd", () => {
    expect(settingDto("github-radar").set).toBe(false);
    expect(readGithubRadarCwd()).toBeNull();
    expect(readGithubRadarCwd()).not.toBe(process.cwd());
  });

  it("不要求是 git 仓库 —— 当前工作还有 TODO 与文档两类来源", async () => {
    const p = join(dir, "not-a-repo");
    mkdirSync(p, { recursive: true });
    expect((await patch({ cwd: p })).status).toBe(200);
  });

  it("GET /api/settings 会把它一起列出来（注册表分派,不是写死一个）", async () => {
    const res = await app.request("/api/settings");
    const json = (await res.json()) as { settings: Record<string, unknown> };
    expect(Object.keys(json.settings).sort()).toEqual(["github-radar", "rag-corpus"]);
  });
});
