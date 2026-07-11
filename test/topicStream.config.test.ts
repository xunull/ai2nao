import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/open.js";
import { readTopicStreamConfig } from "../src/topicStream/config.js";
import {
  CHROME_SOURCE,
  getTopicStreamStatus,
  rebuildChromeTopicStream,
} from "../src/topicStream/rebuild.js";

function tmpBase(tag: string): string {
  const base = join(tmpdir(), `ai2nao-topiccfg-${tag}-${Date.now()}-${Math.random()}`);
  mkdirSync(base, { recursive: true });
  return base;
}

function writeConfig(base: string, obj: unknown): string {
  const p = join(base, "config.json");
  writeFileSync(p, JSON.stringify(obj), "utf8");
  return p;
}

function freshDb(base: string): Database.Database {
  return openDatabase(join(base, "idx.db"));
}

function insertVisit(db: Database.Database, id: number, url: string, day: string): void {
  db.prepare(
    `INSERT INTO chrome_history_urls (
      id, profile, source_id, url, title, visit_count, typed_count,
      last_visit_time, hidden, inserted_at
    ) VALUES (?, 'Default', 'legacy', ?, ?, 1, 0, ?, 0, 'now')`
  ).run(id, url, url, id);
  db.prepare(
    `INSERT INTO chrome_history_visits (
      id, profile, source_id, content_key, url_id, visit_time, from_visit,
      transition, segment_id, visit_duration, calendar_day, inserted_at
    ) VALUES (?, 'Default', 'legacy', ?, ?, ?, NULL, 0, NULL, 0, ?, 'now')`
  ).run(id, `legacy:${id}:${url}`, id, id, day);
}

function categoryOf(db: Database.Database): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT category, COUNT(*) AS c FROM topic_stream
       WHERE source = ? AND profile = 'Default' GROUP BY category`
    )
    .all(CHROME_SOURCE) as { category: string; c: number }[];
  return Object.fromEntries(rows.map((r) => [r.category, r.c]));
}

describe("topicStream config", () => {
  it("uses the default taxonomy when the config file is absent", () => {
    const res = readTopicStreamConfig(join(tmpBase("absent"), "nope.json"));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.exists).toBe(false);
      expect(res.categories.some((c) => c.name === "社区")).toBe(true);
    }
  });

  it("parses an override with domainSuffix + hostPrefix rules", () => {
    const base = tmpBase("override");
    const p = writeConfig(base, {
      topicStream: {
        categories: [
          {
            name: "自建",
            color: "#123456",
            rules: [
              { kind: "domainSuffix", value: "example-lab.test" },
              { kind: "hostPrefix", value: "192.168." },
            ],
          },
        ],
      },
    });
    const res = readTopicStreamConfig(p);
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Merge: user category first, dev defaults still present after it.
      expect(res.categories[0]).toMatchObject({ name: "自建", color: "#123456" });
      expect(res.categories.some((c) => c.name === "社区")).toBe(true);
    }
  });

  it("rejects unknown keys, bad rule kinds, and the reserved 其他 name", () => {
    const base = tmpBase("strict");
    const bad = writeConfig(base, { topicStream: { categories: [], bogus: 1 } });
    expect(readTopicStreamConfig(bad).ok).toBe(false);

    const badKind = writeConfig(base, {
      topicStream: { categories: [{ name: "X", rules: [{ kind: "regex", value: "y" }] }] },
    });
    expect(readTopicStreamConfig(badKind).ok).toBe(false);

    const reserved = writeConfig(base, {
      topicStream: { categories: [{ name: "其他", rules: [] }] },
    });
    expect(readTopicStreamConfig(reserved).ok).toBe(false);
  });

  it("classifies homelab visits via the config override and stamps the config hash", () => {
    const base = tmpBase("homelab");
    const cfgPath = writeConfig(base, {
      topicStream: {
        categories: [
          {
            name: "自建",
            rules: [
              { kind: "domainSuffix", value: "example-lab.test" },
              { kind: "hostPrefix", value: "192.168." },
            ],
          },
        ],
      },
    });
    const db = freshDb(base);
    try {
      insertVisit(db, 1, "http://192.168.10.36/", "2026-04-01");
      insertVisit(db, 2, "http://argocd.example-lab.test/", "2026-04-01");
      insertVisit(db, 3, "https://github.com/z", "2026-04-02"); // still 社区 from merged default
      const result = rebuildChromeTopicStream(db, "Default", cfgPath);
      expect(result.ok).toBe(true);
      expect(categoryOf(db)).toEqual({ 自建: 2, 社区: 1 });
      const cfg = readTopicStreamConfig(cfgPath);
      expect(cfg.ok && result.ruleVersion === cfg.hash).toBe(true);
      const status = getTopicStreamStatus(db, CHROME_SOURCE, "Default", cfgPath);
      expect(status.fresh).toBe(true);
    } finally {
      db.close();
    }
  });

  it("on config_error, preserves existing rows and records the error", () => {
    const base = tmpBase("cfgerr");
    const db = freshDb(base);
    try {
      insertVisit(db, 1, "https://github.com/a", "2026-04-01");
      // First: a good rebuild with the default taxonomy (no config file).
      const good = rebuildChromeTopicStream(db, "Default", join(base, "missing.json"));
      expect(good.ok).toBe(true);
      const before = categoryOf(db);
      expect(before).toEqual({ 社区: 1 });

      // Then: a broken config must NOT wipe the existing rows.
      const badPath = writeConfig(base, { topicStream: { categories: [{ name: "X", rules: "nope" }] } });
      const bad = rebuildChromeTopicStream(db, "Default", badPath);
      expect(bad.ok).toBe(false);
      expect(bad.error?.startsWith("config_error:")).toBe(true);
      expect(categoryOf(db)).toEqual(before); // rows intact
      const status = getTopicStreamStatus(db, CHROME_SOURCE, "Default", badPath);
      expect(status.fresh).toBe(false);
      expect(status.staleReasons).toContain("last_rebuild_error");
    } finally {
      db.close();
    }
  });
});
