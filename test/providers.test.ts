import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import {
  createMinimaxProvider,
  parseMinimaxRemains,
} from "../src/providers/minimax.js";
import {
  ensureProviderConfigs,
  listProviders,
  setProviderConfig,
} from "../src/providers/store.js";
import { syncProvider, syncEnabledProviders } from "../src/providers/sync.js";
import { listProviderSources } from "../src/providers/registry.js";
import type { ProviderUsageSource } from "../src/providers/types.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-providers-"));
  return openDatabase(join(dir, "test.db"));
}

// Real MiniMax /v1/token_plan/remains shape (captured 2026-06-19).
const MM_BODY = {
  model_remains: [
    {
      start_time: 1781834400000,
      end_time: 1781852400000,
      model_name: "general",
      current_interval_remaining_percent: 85,
      weekly_end_time: 1782057600000,
      current_weekly_remaining_percent: 100,
      current_interval_status: 1,
    },
    {
      model_name: "video",
      end_time: 1781884800000,
      current_interval_remaining_percent: 100,
      current_weekly_remaining_percent: 100,
    },
  ],
  base_resp: { status_code: 0, status_msg: "success" },
};

describe("parseMinimaxRemains", () => {
  it("maps per-model-group remaining percent + reset, keeps raw", () => {
    const snap = parseMinimaxRemains(MM_BODY);
    expect(snap.items).toHaveLength(2);
    const general = snap.items.find((i) => i.key === "general")!;
    expect(general.remainingPercent).toBe(85);
    expect(general.resetAt).toBe("2026-06-19T07:00:00.000Z");
    expect(general.detail.weeklyRemainingPercent).toBe(100);
    expect(snap.raw).toBe(MM_BODY);
  });

  it("throws on API error (status_code != 0) — e.g. invalid key", () => {
    expect(() =>
      parseMinimaxRemains({ base_resp: { status_code: 2049, status_msg: "invalid api key" } })
    ).toThrow(/invalid api key/);
  });

  it("empty / missing model_remains → 0 items (not a crash)", () => {
    expect(parseMinimaxRemains({ base_resp: { status_code: 0 } }).items).toHaveLength(0);
  });
});

describe("provider source via injected fetch (no network)", () => {
  it("createMinimaxProvider().sync parses an injected response", async () => {
    const src = createMinimaxProvider(async () => MM_BODY);
    const snap = await src.sync({ apiKey: "k" });
    expect(snap.items.map((i) => i.key)).toEqual(["general", "video"]);
  });
});

describe("store — API key is never exposed", () => {
  it("listProviders returns hasKey, never the key", () => {
    const db = freshDb();
    ensureProviderConfigs(db, "2026-06-19T00:00:00Z");
    setProviderConfig(db, "minimax", { enabled: true, apiKey: "super-secret-key" }, "2026-06-19T00:00:00Z");
    const list = listProviders(db);
    const mm = list.find((p) => p.id === "minimax")!;
    expect(mm.enabled).toBe(true);
    expect(mm.hasKey).toBe(true);
    // The key must not appear anywhere in the serialized view.
    expect(JSON.stringify(list)).not.toContain("super-secret-key");
    expect(mm).not.toHaveProperty("api_key");
  });

  it("clearing the key (empty string) sets hasKey false", () => {
    const db = freshDb();
    ensureProviderConfigs(db, "2026-06-19T00:00:00Z");
    setProviderConfig(db, "minimax", { apiKey: "k" }, "2026-06-19T00:00:00Z");
    setProviderConfig(db, "minimax", { apiKey: "" }, "2026-06-19T00:00:00Z");
    expect(listProviders(db).find((p) => p.id === "minimax")!.hasKey).toBe(false);
  });

  it("historyEnabled defaults off and toggles independently of enabled", () => {
    const db = freshDb();
    ensureProviderConfigs(db, "2026-06-19T00:00:00Z");
    const mm0 = listProviders(db).find((p) => p.id === "minimax")!;
    expect(mm0.historyEnabled).toBe(false);
    // Enabling the snapshot must NOT enable history scraping.
    setProviderConfig(db, "minimax", { enabled: true }, "2026-06-19T00:00:00Z");
    expect(
      listProviders(db).find((p) => p.id === "minimax")!.historyEnabled
    ).toBe(false);
    // Opt into history separately; enabling it must not disturb `enabled`/key.
    setProviderConfig(db, "minimax", { apiKey: "k" }, "2026-06-19T00:00:00Z");
    setProviderConfig(db, "minimax", { historyEnabled: true }, "2026-06-19T00:00:00Z");
    const mm1 = listProviders(db).find((p) => p.id === "minimax")!;
    expect(mm1.historyEnabled).toBe(true);
    expect(mm1.enabled).toBe(true);
    expect(mm1.hasKey).toBe(true);
  });
});

describe("syncProvider / syncEnabledProviders", () => {
  const fakeSource = (body: unknown): ProviderUsageSource => ({
    id: "minimax",
    label: "MiniMax",
    sync: async () => parseMinimaxRemains(body),
  });

  it("skips a disabled provider (no key needed, no call)", async () => {
    const db = freshDb();
    ensureProviderConfigs(db, "2026-06-19T00:00:00Z");
    const r = await syncProvider(db, "minimax", fakeSource(MM_BODY));
    expect(r.status).toBe("skipped");
  });

  it("enabled but no key → failed (clean, no crash)", async () => {
    const db = freshDb();
    ensureProviderConfigs(db, "2026-06-19T00:00:00Z");
    setProviderConfig(db, "minimax", { enabled: true }, "2026-06-19T00:00:00Z");
    const r = await syncProvider(db, "minimax", fakeSource(MM_BODY));
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/key/i);
  });

  it("enabled + key → success, stores items", async () => {
    const db = freshDb();
    ensureProviderConfigs(db, "2026-06-19T00:00:00Z");
    setProviderConfig(db, "minimax", { enabled: true, apiKey: "k" }, "2026-06-19T00:00:00Z");
    const r = await syncProvider(db, "minimax", fakeSource(MM_BODY));
    expect(r.status).toBe("success");
    expect(r.itemCount).toBe(2);
    const mm = listProviders(db).find((p) => p.id === "minimax")!;
    expect(mm.items).toHaveLength(2);
    expect(mm.lastStatus).toBe("success");
  });

  it("source error is recorded as failed; key scrubbed from the message", async () => {
    const db = freshDb();
    ensureProviderConfigs(db, "2026-06-19T00:00:00Z");
    setProviderConfig(db, "minimax", { enabled: true, apiKey: "leaky-key" }, "2026-06-19T00:00:00Z");
    const throwing: ProviderUsageSource = {
      id: "minimax",
      label: "MiniMax",
      sync: async () => {
        throw new Error("boom with leaky-key in it");
      },
    };
    const r = await syncProvider(db, "minimax", throwing);
    expect(r.status).toBe("failed");
    expect(r.error).not.toContain("leaky-key");
    expect(listProviders(db).find((p) => p.id === "minimax")!.lastError).not.toContain("leaky-key");
  });

  it("syncEnabledProviders aggregates status; all-disabled → skipped", async () => {
    const db = freshDb();
    const r = await syncEnabledProviders(db); // nothing enabled
    expect(r.status).toBe("skipped");
  });
});

/**
 * Guards the `requiresApiKey` contract added for the local-credential sources
 * (Claude / Codex). The key-requiring path must behave EXACTLY as before, and
 * the keyless path must not be short-circuited into "未配置 API key".
 */
describe("requiresApiKey contract", () => {
  it("registered key sources do not opt out (MiniMax / Kimi keep requiring a key)", () => {
    for (const id of ["minimax", "kimi"]) {
      const src = listProviderSources().find((s) => s.id === id)!;
      expect(src.requiresApiKey).not.toBe(false);
    }
  });

  it("omitting requiresApiKey still fails without a key (unchanged behaviour)", async () => {
    const db = freshDb();
    ensureProviderConfigs(db, "2026-07-26T00:00:00Z");
    setProviderConfig(db, "minimax", { enabled: true }, "2026-07-26T00:00:00Z");
    const src: ProviderUsageSource = {
      id: "minimax",
      label: "MiniMax",
      sync: async () => parseMinimaxRemains(MM_BODY),
    };
    const r = await syncProvider(db, "minimax", src);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/key/i);
  });

  it("the key still reaches a key-requiring source untouched", async () => {
    const db = freshDb();
    ensureProviderConfigs(db, "2026-07-26T00:00:00Z");
    setProviderConfig(db, "minimax", { enabled: true, apiKey: "k-123" }, "2026-07-26T00:00:00Z");
    let seen: string | null | undefined;
    const src: ProviderUsageSource = {
      id: "minimax",
      label: "MiniMax",
      sync: async (cfg) => {
        seen = cfg.apiKey;
        return parseMinimaxRemains(MM_BODY);
      },
    };
    expect((await syncProvider(db, "minimax", src)).status).toBe("success");
    expect(seen).toBe("k-123");
  });

  it("requiresApiKey:false syncs with no key configured and gets apiKey null", async () => {
    const db = freshDb();
    ensureProviderConfigs(db, "2026-07-26T00:00:00Z");
    setProviderConfig(db, "claude", { enabled: true }, "2026-07-26T00:00:00Z");
    let seen: string | null | undefined = "unset";
    const src: ProviderUsageSource = {
      id: "claude",
      label: "Claude",
      requiresApiKey: false,
      sync: async (cfg) => {
        seen = cfg.apiKey;
        return { items: [{ key: "5h", label: "5 小时用量", remainingPercent: 48, resetAt: null, detail: {} }], raw: {} };
      },
    };
    const r = await syncProvider(db, "claude", src);
    expect(r.status).toBe("success");
    expect(seen).toBeNull();
  });

  it("a keyless source that throws is recorded as failed, not masked as 'no key'", async () => {
    const db = freshDb();
    ensureProviderConfigs(db, "2026-07-26T00:00:00Z");
    setProviderConfig(db, "claude", { enabled: true }, "2026-07-26T00:00:00Z");
    const src: ProviderUsageSource = {
      id: "claude",
      label: "Claude",
      requiresApiKey: false,
      sync: async () => {
        throw new Error("未检测到 Claude Code 登录凭据");
      },
    };
    const r = await syncProvider(db, "claude", src);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/登录凭据/);
    expect(r.error).not.toMatch(/未配置 API key/);
  });
});
