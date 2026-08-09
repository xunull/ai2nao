process.env.TZ = "Asia/Shanghai";

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { createApp } from "../src/serve/app.js";
import { MAX_LEADS } from "../src/home/leads.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "home-r-"));
  return openDatabase(join(dir, "test.db"));
}

async function getLeads(db: Database.Database) {
  const app = createApp(db);
  const res = await app.request("/api/home/leads");
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/home/leads", () => {
  it("空库:200,契约形状完整,并给出兜底卡片", async () => {
    const db = freshDb();
    try {
      const { status, body } = await getLeads(db);
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.leads)).toBe(true);
      expect(Array.isArray(body.errors)).toBe(true);
      expect(typeof body.overflow).toBe("number");
      // 空库跑不出任何线索 → 首页该摆卡片,而不是一片「今天没有线索」的空白。
      expect(body.leads).toEqual([]);
      expect(body.fallbackCards).toEqual(["streak", "rhythm", "source-trend"]);
    } finally {
      db.close();
    }
  });

  it("数据源的表没了(schema drift):仍然 200,异常进 errors[],不是 500", async () => {
    const db = freshDb();
    try {
      // quota.low 读 provider_config / provider_usage。删掉一张,模拟真实的迁移半途或
      // 外部库结构漂移 —— 这正是 1A/T3A 那条决定要防的场景。
      db.exec("DROP TABLE provider_usage;");

      const { status, body } = await getLeads(db);
      expect(status).toBe(200); // ← 回归点:一个边缘探针不该把落地页打成白屏
      const errors = body.errors as { probeId: string; message: string }[];
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.probeId === "quota.low")).toBe(true);
      // 错误没有伪装成 Lead 去占版面。
      const leads = body.leads as { id: string }[];
      expect(leads.some((l) => l.id === "quota.low")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("返回的线索数量不超过上限(warning 除外,见 home.leads.test.ts)", async () => {
    const db = freshDb();
    try {
      const { body } = await getLeads(db);
      const leads = body.leads as unknown[];
      expect(leads.length).toBeLessThanOrEqual(MAX_LEADS);
    } finally {
      db.close();
    }
  });
});
