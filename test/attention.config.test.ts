import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DatabaseCtor from "better-sqlite3";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bundleFilterOf,
  DEFAULT_ATTENTION_CONFIG,
  parseAttentionConfig,
  readAttentionConfig,
} from "../src/attention/config.js";
import { syncAttention } from "../src/attention/sync.js";
import { unixMsToAppleSeconds } from "../src/attention/time.js";
import { migrate } from "../src/store/migrations.js";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai2nao-attn-cfg-"));
  db = new DatabaseCtor(":memory:");
  migrate(db);
});
afterEach(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("parseAttentionConfig — 严格模式", () => {
  it("没有 attention 段时用默认值(全量)", () => {
    expect(parseAttentionConfig({}).config).toEqual(DEFAULT_ATTENTION_CONFIG);
    expect(parseAttentionConfig(null).config).toEqual(DEFAULT_ATTENTION_CONFIG);
  });

  it("拒绝未知字段，而不是当作没写", () => {
    // 拼错一个键就静默失效，意味着你以为设了 allowlist 其实在全量采集。
    // 对一个采「你在电脑前做的一切」的功能，那是最不能接受的失败方式。
    const r = parseAttentionConfig({ attention: { allowBundels: ["x"] } });
    expect(r.config).toBeNull();
    expect(r.issues[0]!.path).toBe("$.attention.allowBundels");
    expect(r.issues[0]!.message).toMatch(/unknown/);
  });

  it("拒绝非法的 mode", () => {
    const r = parseAttentionConfig({ attention: { mode: "whitelist" } });
    expect(r.config).toBeNull();
    expect(r.issues[0]!.message).toMatch(/"all" or "allowlist"/);
  });

  it("拒绝非数组的 bundle 列表和空字符串条目", () => {
    expect(parseAttentionConfig({ attention: { allowBundles: "a" } }).config).toBeNull();
    const r = parseAttentionConfig({ attention: { excludeBundles: ["ok", "  "] } });
    expect(r.config).toBeNull();
    expect(r.issues[0]!.path).toBe("$.attention.excludeBundles[1]");
  });

  it("拒绝负的 minDurationMs", () => {
    expect(parseAttentionConfig({ attention: { minDurationMs: -1 } }).config).toBeNull();
  });

  it("一个字段出错就整份不生效 —— 半套配置比不生效更难查", () => {
    const r = parseAttentionConfig({
      attention: { mode: "allowlist", allowBundles: ["a"], bogus: 1 },
    });
    expect(r.config).toBeNull();
  });

  it("完整合法配置照单接收", () => {
    const r = parseAttentionConfig({
      attention: {
        mode: "allowlist",
        allowBundles: ["com.a", " com.b "],
        excludeBundles: ["com.secret"],
        minDurationMs: 5000,
      },
    });
    expect(r.config).toEqual({
      mode: "allowlist",
      allowBundles: ["com.a", "com.b"],
      excludeBundles: ["com.secret"],
      minDurationMs: 5000,
    });
  });
});

describe("bundleFilterOf", () => {
  const seen = ["com.a", "com.b", "com.secret"];

  it("全量模式且无黑名单时不构造集合(= 不过滤)", () => {
    expect(bundleFilterOf(DEFAULT_ATTENTION_CONFIG, seen)).toBeUndefined();
  });

  it("全量模式下黑名单仍然生效", () => {
    const f = bundleFilterOf(
      { ...DEFAULT_ATTENTION_CONFIG, excludeBundles: ["com.secret"] },
      seen
    );
    expect(f!.has("com.a")).toBe(true);
    expect(f!.has("com.secret")).toBe(false);
  });

  it("白名单模式下黑名单优先", () => {
    const f = bundleFilterOf(
      {
        mode: "allowlist",
        allowBundles: ["com.a", "com.secret"],
        excludeBundles: ["com.secret"],
        minDurationMs: 0,
      },
      seen
    );
    expect(f!.has("com.a")).toBe(true);
    expect(f!.has("com.secret")).toBe(false);
  });
});

describe("readAttentionConfig", () => {
  it("文件不存在时用默认值", () => {
    const r = readAttentionConfig(join(dir, "nope.json"));
    expect(r.ok).toBe(true);
    expect(r.ok && r.exists).toBe(false);
  });

  it("非法 JSON 报错而不是回落默认", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{ not json");
    const r = readAttentionConfig(p);
    expect(r.ok).toBe(false);
  });
});

describe("syncAttention 接入配置", () => {
  function makeSource(rows: { bundle: string; startMs: number; endMs: number }[]): string {
    const p = join(dir, "kc.db");
    const src = new DatabaseCtor(p);
    src.exec(`
      CREATE TABLE ZOBJECT (
        Z_PK INTEGER PRIMARY KEY, ZSTREAMNAME TEXT, ZVALUESTRING TEXT,
        ZSTARTDATE REAL, ZENDDATE REAL, ZSECONDSFROMGMT INTEGER
      );
    `);
    const ins = src.prepare(
      `INSERT INTO ZOBJECT (ZSTREAMNAME, ZVALUESTRING, ZSTARTDATE, ZENDDATE, ZSECONDSFROMGMT)
       VALUES ('/app/usage', ?, ?, ?, 28800)`
    );
    for (const r of rows) {
      ins.run(r.bundle, unixMsToAppleSeconds(r.startMs), unixMsToAppleSeconds(r.endMs));
    }
    src.close();
    return p;
  }

  const t = new Date(2026, 7, 10, 9, 0, 0, 0).getTime();

  it("白名单模式只落白名单里的应用", () => {
    const p = makeSource([
      { bundle: "com.keep", startMs: t, endMs: t + 60_000 },
      { bundle: "com.drop", startMs: t + 60_000, endMs: t + 120_000 },
    ]);
    const r = syncAttention(db, {
      sourcePath: p,
      config: {
        mode: "allowlist",
        allowBundles: ["com.keep"],
        excludeBundles: [],
        minDurationMs: 0,
      },
    });
    expect(r.spansInserted).toBe(1);
    // 水位仍然越过被过滤的那一行，否则下次会反复重读它。
    expect(r.watermarkAfter).toBe(2);
  });

  it("全量模式下黑名单把敏感应用挡在库外", () => {
    const p = makeSource([
      { bundle: "com.work", startMs: t, endMs: t + 60_000 },
      { bundle: "com.private", startMs: t + 60_000, endMs: t + 120_000 },
    ]);
    const r = syncAttention(db, {
      sourcePath: p,
      config: {
        mode: "all",
        allowBundles: [],
        excludeBundles: ["com.private"],
        minDurationMs: 0,
      },
    });
    expect(r.spansInserted).toBe(1);
    const rows = db
      .prepare("SELECT bundle_id FROM attention_focus_spans")
      .all() as { bundle_id: string }[];
    expect(rows.map((x) => x.bundle_id)).toEqual(["com.work"]);
  });

  it("默认全量：不配置就什么都采", () => {
    const p = makeSource([
      { bundle: "com.a", startMs: t, endMs: t + 60_000 },
      { bundle: "com.b", startMs: t + 60_000, endMs: t + 120_000 },
    ]);
    const r = syncAttention(db, { sourcePath: p, config: DEFAULT_ATTENTION_CONFIG });
    expect(r.spansInserted).toBe(2);
  });
});
