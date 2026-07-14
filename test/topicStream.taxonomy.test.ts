import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTopicTaxonomy, setTopicTaxonomy } from "../src/appConfig/index.js";
import { createApp } from "../src/serve/app.js";
import { openDatabase } from "../src/store/open.js";
import { DEFAULT_TAXONOMY, OTHER_CATEGORY } from "../src/topicStream/classify.js";
import { readTopicStreamConfig, resolveTopicStreamConfig } from "../src/topicStream/config.js";

let base: string;
let db: Database.Database;
let app: Hono;
let configPath: string;

const MINE = {
  name: "自建·Homelab",
  color: "#5ec8a0",
  rules: [{ kind: "domainSuffix", value: "truenas.com" }],
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ai2nao-tax-"));
  db = openDatabase(join(base, "idx.db"));
  app = createApp({ db });
  configPath = join(base, "config.json");
});

afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

const get = () => app.request("/api/topics/taxonomy").then((r) => r.json());
const save = (body: unknown) =>
  app.request("/api/topics/taxonomy", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("taxonomy storage", () => {
  it("stores ONLY the user's own categories, and merges the built-ins on read", () => {
    setTopicTaxonomy(db, [MINE], 45);

    // Stored: just mine. Freezing the merged list here would cut the user off
    // from any future update to the built-in taxonomy.
    expect(getTopicTaxonomy(db)!.categories).toEqual([MINE]);

    const cfg = resolveTopicStreamConfig(db, configPath);
    expect(cfg.ok).toBe(true);
    if (!cfg.ok) return;
    expect(cfg.categories[0]).toEqual(MINE); // user first — their rules win ties
    expect(cfg.categories.length).toBe(1 + DEFAULT_TAXONOMY.length);
    expect(cfg.gapMinutes).toBe(45);
  });

  it("reusing a built-in's name overrides it instead of duplicating it", () => {
    const override = { name: DEFAULT_TAXONOMY[0].name, color: "#123456", rules: [] };
    setTopicTaxonomy(db, [override], 30);

    const cfg = resolveTopicStreamConfig(db, configPath);
    if (!cfg.ok) throw new Error("expected ok");
    const hits = cfg.categories.filter((c) => c.name === override.name);
    expect(hits).toHaveLength(1);
    expect(hits[0].color).toBe("#123456");
    // Empty rules is how you neutralise a built-in: it stays listed but matches nothing.
    expect(hits[0].rules).toEqual([]);
  });

  it("db out-ranks config.json, and config.json is never touched", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ topicStream: { categories: [{ name: "从文件来", color: "#ff0000", rules: [] }] } })
    );
    // Before any save, the file is what's in effect.
    const before = resolveTopicStreamConfig(db, configPath);
    if (!before.ok) throw new Error("expected ok");
    expect(before.categories[0].name).toBe("从文件来");

    setTopicTaxonomy(db, [MINE], 30);
    const after = resolveTopicStreamConfig(db, configPath);
    if (!after.ok) throw new Error("expected ok");
    expect(after.categories[0].name).toBe(MINE.name);

    // The file still says what it always said — nothing renamed it or rewrote it,
    // so a user who reverts the db row gets their hand-tuned file back intact.
    const file = readTopicStreamConfig(configPath);
    if (!file.ok) throw new Error("expected ok");
    expect(file.categories[0].name).toBe("从文件来");
  });

  it("a malformed stored row degrades to config.json rather than wiping the taxonomy", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ topicStream: { categories: [{ name: "从文件来", color: "#ff0000", rules: [] }] } })
    );
    db.prepare(
      "INSERT INTO app_config (key, value, updated_at) VALUES ('topicStream.categories', ?, ?)"
    ).run(JSON.stringify([{ name: "", color: "nope" }]), new Date().toISOString());

    expect(getTopicTaxonomy(db)).toBeNull();
    const cfg = resolveTopicStreamConfig(db, configPath);
    if (!cfg.ok) throw new Error("expected ok");
    expect(cfg.categories[0].name).toBe("从文件来");
  });

  it("editing the taxonomy changes the hash — which is what makes the river say 需要重建", () => {
    const a = resolveTopicStreamConfig(db, configPath);
    setTopicTaxonomy(db, [MINE], 30);
    const b = resolveTopicStreamConfig(db, configPath);
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(b.hash).not.toBe(a.hash);
  });
});

describe("taxonomy API", () => {
  it("GET splits the user's own from the built-ins", async () => {
    const body = await get();
    expect(body.source).toBe("default");
    expect(body.own).toEqual([]);
    expect(body.builtin.length).toBe(DEFAULT_TAXONOMY.length);
    expect(body.otherCategory).toBe(OTHER_CATEGORY);
  });

  it("PATCH saves, and the saved category drops out of the built-in list when it overrides one", async () => {
    const res = await save({ categories: [MINE], gapMinutes: 45 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("db");
    expect(body.own).toEqual([MINE]);
    expect(body.gapMinutes).toBe(45);
    expect(body.builtin.length).toBe(DEFAULT_TAXONOMY.length); // MINE is not a built-in name

    const override = await save({
      categories: [{ name: DEFAULT_TAXONOMY[0].name, color: "#123456", rules: [] }],
      gapMinutes: 30,
    });
    expect((await override.json()).builtin.length).toBe(DEFAULT_TAXONOMY.length - 1);
  });

  it("rejects 「其他」 as a category name — it is the bucket for everything unmatched", async () => {
    const res = await save({
      categories: [{ name: OTHER_CATEGORY, color: "#123456", rules: [] }],
      gapMinutes: 30,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a bad color, a bad rule kind, and duplicate names", async () => {
    expect(
      (await save({ categories: [{ name: "x", color: "red", rules: [] }], gapMinutes: 30 })).status
    ).toBe(400);
    expect(
      (
        await save({
          categories: [{ name: "x", color: "#112233", rules: [{ kind: "nope", value: "a" }] }],
          gapMinutes: 30,
        })
      ).status
    ).toBe(400);
    expect(
      (
        await save({
          categories: [
            { name: "x", color: "#112233", rules: [] },
            { name: "x", color: "#445566", rules: [] },
          ],
          gapMinutes: 30,
        })
      ).status
    ).toBe(400);
  });

  it("DELETE forgets the stored taxonomy and falls back", async () => {
    await save({ categories: [MINE], gapMinutes: 45 });
    expect((await get()).source).toBe("db");

    const del = await app.request("/api/topics/taxonomy", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await get()).source).toBe("default");
    expect(getTopicTaxonomy(db)).toBeNull();
  });
});
