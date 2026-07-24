import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import {
  createKimiProvider,
  parseKimiUsages,
  type KimiResponse,
} from "../src/providers/kimi.js";
import {
  ensureProviderConfigs,
  listProviders,
  setProviderConfig,
} from "../src/providers/store.js";
import { syncProvider } from "../src/providers/sync.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-kimi-"));
  return openDatabase(join(dir, "test.db"));
}

/** ok/status/json/text stub for the injected fetch seam. */
function res(status: number, body: unknown): KimiResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// Real Kimi Code /coding/v1/usages shape (captured 2026-07-24, Coding-Plan key).
const KIMI_BODY = {
  user: { userId: "u1", region: "REGION_CN", membership: { level: "LEVEL_TRIAL" } },
  usage: { limit: "100", remaining: "90", resetTime: "2026-07-27T08:00:56.444238Z" },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", remaining: "40", resetTime: "2026-07-24T07:00:56.444238Z" },
    },
  ],
  parallel: { limit: "10" },
  authentication: { method: "METHOD_API_KEY", scope: "FEATURE_CODING" },
  subType: "TYPE_PURCHASE",
};

describe("parseKimiUsages", () => {
  it("maps usage + limits[] (string numbers, remaining→percent), keeps raw", () => {
    const snap = parseKimiUsages(KIMI_BODY);
    // one overall + one window
    expect(snap.items.map((i) => i.key)).toEqual(["overall", "5h"]);

    const overall = snap.items.find((i) => i.key === "overall")!;
    expect(overall.label).toBe("套餐总额");
    expect(overall.remainingPercent).toBe(90); // 90/100
    expect(overall.resetAt).toBe("2026-07-27T08:00:56.444Z");
    expect(overall.detail.kind).toBe("overall");

    const win = snap.items.find((i) => i.key === "5h")!;
    expect(win.label).toBe("5 小时窗口"); // 300 min = 5h
    expect(win.remainingPercent).toBe(40); // 40/100
    expect(win.detail.used).toBe(60); // limit - remaining
    expect(snap.raw).toBe(KIMI_BODY);
  });

  it("tolerates the flat data[] form (model_name 'all' = overall)", () => {
    const snap = parseKimiUsages({
      data: [
        { model_name: "all", limit: "1000", remaining: "500" },
        { model_name: "kimi", limit: "100", used: "30" },
      ],
    });
    expect(snap.items).toHaveLength(2);
    expect(snap.items.find((i) => i.key === "overall")!.remainingPercent).toBe(50);
    // used→remaining fallback: 100-30 = 70%
    expect(snap.items.find((i) => i.key === "kimi")!.remainingPercent).toBe(70);
  });

  it("limit 0 / empty → no NaN, drops empty blocks", () => {
    const snap = parseKimiUsages({
      usage: { limit: "0", remaining: "0" },
      limits: [{ detail: {} }, "junk"],
    });
    const overall = snap.items.find((i) => i.key === "overall")!;
    expect(overall.remainingPercent).toBeNull(); // limit 0 → null, not NaN
    expect(JSON.stringify(snap)).not.toContain("NaN");
    // the empty detail block is dropped
    expect(snap.items).toHaveLength(1);
  });

  it("garbage body → 0 items, not a crash", () => {
    expect(parseKimiUsages(null).items).toHaveLength(0);
    expect(parseKimiUsages({}).items).toHaveLength(0);
  });
});

describe("createKimiProvider (injected fetch, no network)", () => {
  it("200 → parses items", async () => {
    const src = createKimiProvider(async () => res(200, KIMI_BODY));
    const snap = await src.sync({ apiKey: "sk-kimi-x" });
    expect(snap.items.map((i) => i.key)).toEqual(["overall", "5h"]);
  });

  it("404 on /usages falls back to /usage", async () => {
    const urls: string[] = [];
    const src = createKimiProvider(async (url) => {
      urls.push(url);
      return url.endsWith("/usages") ? res(404, {}) : res(200, KIMI_BODY);
    });
    const snap = await src.sync({ apiKey: "sk-kimi-x" });
    expect(urls).toEqual([
      "https://api.kimi.com/coding/v1/usages",
      "https://api.kimi.com/coding/v1/usage",
    ]);
    expect(snap.items.length).toBeGreaterThan(0);
  });

  it("401 does NOT fall back; error hints at the coding-plan key; no key leak", async () => {
    const urls: string[] = [];
    const src = createKimiProvider(async (url) => {
      urls.push(url);
      return res(401, { code: "unauthenticated" });
    });
    await expect(src.sync({ apiKey: "sk-secret-leak" })).rejects.toThrow(/sk-kimi/);
    expect(urls).toEqual(["https://api.kimi.com/coding/v1/usages"]); // no fallback
    await src.sync({ apiKey: "sk-secret-leak" }).catch((e: Error) => {
      expect(e.message).not.toContain("sk-secret-leak");
    });
  });
});

describe("kimi through the generic store/sync", () => {
  it("registered provider syncs and stores items; key never exposed", async () => {
    const db = freshDb();
    ensureProviderConfigs(db, "2026-07-24T00:00:00Z");
    setProviderConfig(db, "kimi", { enabled: true, apiKey: "sk-kimi-secret" }, "2026-07-24T00:00:00Z");
    const src = createKimiProvider(async () => res(200, KIMI_BODY));
    const r = await syncProvider(db, "kimi", src);
    expect(r.status).toBe("success");
    expect(r.itemCount).toBe(2);
    const kimi = listProviders(db).find((p) => p.id === "kimi")!;
    expect(kimi.items).toHaveLength(2);
    expect(JSON.stringify(kimi)).not.toContain("sk-kimi-secret");
  });
});
