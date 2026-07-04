process.env.TZ = "Asia/Shanghai";

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { upsertUserMessagesBatch } from "../src/agentUserMessages/store.js";
import { createApp } from "../src/serve/app.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai-rhythm-r-"));
  return openDatabase(join(dir, "test.db"));
}

// codex#6:走 createApp 而非独立 Hono app —— 验证路由确实在 createApp 里注册了(不漏「忘挂载」)。
describe("GET /api/ai-rhythm/heatmap — createApp 集成", () => {
  it("已挂载 + 返回热力图 shape", async () => {
    const db = freshDb();
    upsertUserMessagesBatch(
      db,
      [
        {
          source: "claude",
          sourceSessionId: "s1",
          sourceMessageKey: "m1",
          project: null,
          eventAtUtc: "2026-07-08T02:00:00Z",
          rawText: "x",
          rawPayloadJson: '"x"',
          cleanedText: "x",
          isHuman: true,
          cleanerVersion: 1,
          parserVersion: 1,
          sourcePath: "/x",
        },
      ],
      "2026-07-08T00:00:00Z"
    );
    const res = await createApp({ db }).request("http://x/api/ai-rhythm/heatmap");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      cells: unknown[];
      maxCount: number;
      total: number;
      peak: unknown;
    };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.cells)).toBe(true);
    expect(body.maxCount).toBe(1);
    expect(body.peak).toEqual({ weekday: 3, hour: 10, count: 1 });
  });

  it("空库 → 200 + peak null", async () => {
    const db = freshDb();
    const res = await createApp({ db }).request("http://x/api/ai-rhythm/heatmap");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { peak: unknown; maxCount: number };
    expect(body.peak).toBeNull();
    expect(body.maxCount).toBe(0);
  });
});
