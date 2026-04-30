import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDailySummaryCacheDatabase } from "../src/dailySummary/cache.js";
import { createApp } from "../src/serve/app.js";
import { openDatabase, openReadOnlyDatabase } from "../src/store/open.js";
import { runScan } from "../src/scan/runScan.js";
import { chromeWebkitUsToUnixMs } from "../src/chromeHistory/time.js";

describe("Hono read-only API", () => {
  it("GET /api/status and /api/repos", async () => {
    const base = join(tmpdir(), `ai2nao-api-${Date.now()}`);
    const repo = join(base, "proj");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(
      join(repo, ".git", "config"),
      '[remote "origin"]\n\turl = https://example.com/x.git\n',
      "utf8"
    );
    writeFileSync(join(repo, "package.json"), '{"name":"x"}', "utf8");

    const dbPath = join(base, "idx.db");
    const dbw = openDatabase(dbPath);
    runScan(dbw, [base], ["package.json"]);
    dbw.close();

    const db = openReadOnlyDatabase(dbPath);
    try {
      const app = createApp({ db });
      const st = await app.request("http://x/api/status");
      expect(st.status).toBe(200);
      const sj = (await st.json()) as { repos: number };
      expect(sj.repos).toBe(1);

      const lr = await app.request("http://x/api/repos?page=1&limit=10");
      expect(lr.status).toBe(200);
      const lj = (await lr.json()) as {
        repos: { id: number }[];
        total: number;
      };
      expect(lj.total).toBe(1);
      const id = lj.repos[0].id;

      const d = await app.request(`http://x/api/repos/${id}`);
      expect(d.status).toBe(200);
      const dj = (await d.json()) as { manifests: { rel_path: string }[] };
      expect(dj.manifests.some((m) => m.rel_path === "package.json")).toBe(
        true
      );

      const f = await app.request(
        `http://x/api/repos/${id}/manifest?path=${encodeURIComponent("package.json")}`
      );
      expect(f.status).toBe(200);

      const s = await app.request(
        "http://x/api/search?q=name&limit=5"
      );
      expect(s.status).toBe(200);

      const ch = await app.request("http://x/api/cursor-history/status");
      expect(ch.status).toBe(200);
      const chj = (await ch.json()) as {
        workspaceStorage: string;
        platform: string;
      };
      expect(chj.platform).toBe(process.platform);
      expect(chj.workspaceStorage.length).toBeGreaterThan(0);

      const llm = await app.request("http://x/api/llm-chat/status");
      expect(llm.status).toBe(200);
      const llmj = (await llm.json()) as { configured: boolean; configPath: string };
      expect(typeof llmj.configured).toBe("boolean");
      expect(llmj.configPath.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("GET /api/atuin/* with mock history.db", async () => {
    const base = join(tmpdir(), `ai2nao-atuin-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    const repo = join(base, "proj");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "package.json"), '{"name":"x"}', "utf8");

    const dbPath = join(base, "idx.db");
    const dbw = openDatabase(dbPath);
    runScan(dbw, [base], ["package.json"]);
    dbw.close();

    const atuinPath = join(base, "history.db");
    const aw = new Database(atuinPath);
    aw.exec(`
      CREATE TABLE history (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        duration INTEGER NOT NULL,
        exit INTEGER NOT NULL,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        session TEXT NOT NULL,
        hostname TEXT NOT NULL,
        author TEXT,
        intent TEXT,
        deleted_at INTEGER
      );
    `);
    const nowNs = Date.now() * 1_000_000;
    aw.prepare(
      `INSERT INTO history (id, timestamp, duration, exit, command, cwd, session, hostname)
       VALUES (?, ?, 0, 0, 'echo hi', '/tmp', 's', 'h')`
    ).run("id-1", nowNs);
    aw.close();

    const db = openReadOnlyDatabase(dbPath);
    const atuinDb = openReadOnlyDatabase(atuinPath);
    try {
      const app = createApp({
        db,
        atuin: { db: atuinDb, path: atuinPath },
      });
      const st = await app.request("http://x/api/atuin/status");
      expect(st.status).toBe(200);
      const sj = (await st.json()) as { enabled: boolean };
      expect(sj.enabled).toBe(true);

      const y = new Date().getFullYear();
      const mo = new Date().getMonth() + 1;
      const moRes = await app.request(
        `http://x/api/atuin/month?year=${y}&month=${mo}`
      );
      expect(moRes.status).toBe(200);
      const mj = (await moRes.json()) as {
        days: { day: string; count: number }[];
      };
      expect(mj.days.length).toBeGreaterThan(0);

      const dayStr = mj.days[0].day;
      const dRes = await app.request(
        `http://x/api/atuin/day?date=${encodeURIComponent(dayStr)}`
      );
      expect(dRes.status).toBe(200);
      const dj = (await dRes.json()) as { entries: { command: string }[] };
      expect(dj.entries.some((e) => e.command === "echo hi")).toBe(true);
    } finally {
      atuinDb.close();
      db.close();
    }
  });

  it("POST /api/daily-summary generates and caches a summary", async () => {
    const base = join(tmpdir(), `ai2nao-summary-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    const repo = join(base, "proj");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "proj",
        description: "A sample project for testing",
      }),
      "utf8"
    );

    const dbPath = join(base, "idx.db");
    const dbw = openDatabase(dbPath);
    runScan(dbw, [base], ["package.json"]);
    dbw.close();

    const atuinPath = join(base, "history.db");
    const aw = new Database(atuinPath);
    aw.exec(`
      CREATE TABLE history (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        duration INTEGER NOT NULL,
        exit INTEGER NOT NULL,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        session TEXT NOT NULL,
        hostname TEXT NOT NULL,
        author TEXT,
        intent TEXT,
        deleted_at INTEGER
      );
    `);
    const nowNs = Date.now() * 1_000_000;
    aw.prepare(
      `INSERT INTO history (id, timestamp, duration, exit, command, cwd, session, hostname)
       VALUES (?, ?, 0, 0, ?, ?, 's', 'h')`
    ).run("id-1", nowNs, "npm test", repo);
    aw.prepare(
      `INSERT INTO history (id, timestamp, duration, exit, command, cwd, session, hostname)
       VALUES (?, ?, 0, 0, ?, ?, 's', 'h')`
    ).run("id-2", nowNs + 1, "npm run build", repo);
    aw.prepare(
      `INSERT INTO history (id, timestamp, duration, exit, command, cwd, session, hostname)
       VALUES (?, ?, 0, 0, ?, ?, 's', 'h')`
    ).run("id-3", nowNs + 2, "git status", repo);
    aw.close();

    const db = openReadOnlyDatabase(dbPath);
    const atuinDb = openReadOnlyDatabase(atuinPath);
    const cacheDb = openDailySummaryCacheDatabase(join(base, "daily-summary.db"));
    let llmCalls = 0;
    try {
      const app = createApp({
        db,
        atuin: { db: atuinDb, path: atuinPath },
        dailySummary: {
          cacheDb,
          runtime: {
            enabled: true,
            cacheDbPath: join(base, "daily-summary.db"),
            llm: {
              baseUrl: "http://llm.test/v1",
              model: "fake-model",
              timeoutMs: 1_000,
              fetchImpl: async () => {
                llmCalls += 1;
                return new Response(
                  JSON.stringify({
                    choices: [
                      {
                        message: {
                          content: JSON.stringify({
                            summary: "Worked mainly in proj.",
                            nextUp: "Continue in proj tomorrow.",
                            workMode: "implementation",
                            primaryRepoLabel: "proj",
                          }),
                        },
                      },
                    ],
                  }),
                  {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                  }
                );
              },
            },
          },
        },
      });

      const dateStr = new Date().toISOString().slice(0, 10);
      const first = await app.request("http://x/api/daily-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: dateStr, refresh: false }),
      });
      expect(first.status).toBe(200);
      const firstJson = (await first.json()) as {
        summary: string;
        nextUp: string | null;
        meta: { fromCache: boolean; usedLlm: boolean };
        facts: { topRepoLabel: string | null };
      };
      expect(firstJson.summary).toContain("proj");
      expect(firstJson.nextUp).toContain("proj");
      expect(firstJson.meta.fromCache).toBe(false);
      expect(firstJson.meta.usedLlm).toBe(true);
      expect(firstJson.facts.topRepoLabel).toBe("proj");
      expect(llmCalls).toBe(1);

      const second = await app.request("http://x/api/daily-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: dateStr, refresh: false }),
      });
      expect(second.status).toBe(200);
      const secondJson = (await second.json()) as {
        meta: { fromCache: boolean };
      };
      expect(secondJson.meta.fromCache).toBe(true);
      expect(llmCalls).toBe(1);
    } finally {
      cacheDb.close();
      atuinDb.close();
      db.close();
    }
  });

  it("POST /api/downloads/scan and GET month/day", async () => {
    const base = join(tmpdir(), `ai2nao-dl-api-${Date.now()}`);
    const repo = join(base, "proj");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(
      join(repo, ".git", "config"),
      '[remote "origin"]\n\turl = https://example.com/x.git\n',
      "utf8"
    );
    writeFileSync(join(repo, "package.json"), '{"name":"x"}', "utf8");

    const dl = join(base, "fake-downloads");
    mkdirSync(dl, { recursive: true });
    writeFileSync(join(dl, "x.bin"), "x", "utf8");

    const dbPath = join(base, "idx.db");
    const dbw = openDatabase(dbPath);
    runScan(dbw, [base], ["package.json"]);
    dbw.close();

    const db = openDatabase(dbPath);
    try {
      const app = createApp({ db });
      const scan = await app.request("http://x/api/downloads/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roots: [dl] }),
      });
      expect(scan.status).toBe(200);
      const sj = (await scan.json()) as { inserted: number; skipped: number };
      expect(sj.inserted).toBe(1);
      expect(sj.skipped).toBe(0);

      const now = new Date();
      const y = now.getFullYear();
      const mo = now.getMonth() + 1;
      const moRes = await app.request(
        `http://x/api/downloads/month?year=${y}&month=${mo}`
      );
      expect(moRes.status).toBe(200);
      const mj = (await moRes.json()) as {
        days: { day: string; count: number }[];
      };
      expect(mj.days.some((d) => d.count >= 1)).toBe(true);
      const dayStr = mj.days.find((d) => d.count >= 1)?.day;
      expect(dayStr).toBeTruthy();
      const dRes = await app.request(
        `http://x/api/downloads/day?date=${encodeURIComponent(dayStr!)}`
      );
      expect(dRes.status).toBe(200);
      const dj = (await dRes.json()) as {
        entries: { rel_path: string }[];
      };
      expect(dj.entries.some((e) => e.rel_path === "x.bin")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("POST /api/huggingface/sync and GET status/models", async () => {
    const base = join(tmpdir(), `ai2nao-hf-api-${Date.now()}`);
    const root = join(base, "hub");
    const model = join(root, "models--org--repo");
    mkdirSync(join(model, "refs"), { recursive: true });
    mkdirSync(join(model, "blobs"), { recursive: true });
    mkdirSync(join(model, "snapshots", "abc123"), { recursive: true });
    writeFileSync(join(model, "refs", "main"), "abc123\n", "utf8");
    writeFileSync(join(model, "blobs", "blob-a"), "hello", "utf8");

    const db = openDatabase(join(base, "idx.db"));
    try {
      const app = createApp({ db });
      const sync = await app.request("http://x/api/huggingface/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root }),
      });
      expect(sync.status).toBe(200);

      const status = await app.request(
        `http://x/api/huggingface/status?root=${encodeURIComponent(root)}`
      );
      expect(status.status).toBe(200);
      const sj = (await status.json()) as { counts: { active: number; totalSizeBytes: number } };
      expect(sj.counts.active).toBe(1);
      expect(sj.counts.totalSizeBytes).toBe(5);

      const list = await app.request(
        `http://x/api/huggingface/models?root=${encodeURIComponent(root)}`
      );
      expect(list.status).toBe(200);
      const lj = (await list.json()) as { rows: { repo_id: string }[] };
      expect(lj.rows[0].repo_id).toBe("org/repo");

      const invalid = await app.request("http://x/api/huggingface/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: 123 }),
      });
      expect(invalid.status).toBe(400);
    } finally {
      db.close();
    }
  });

  it("POST /api/lmstudio/sync and GET status/models", async () => {
    const base = join(tmpdir(), `ai2nao-lm-api-${Date.now()}`);
    const root = join(base, "models");
    const model = join(root, "org", "repo-GGUF");
    mkdirSync(model, { recursive: true });
    writeFileSync(join(model, "repo-Q4_K_M.gguf"), "hello", "utf8");
    writeFileSync(join(model, "mmproj-repo.gguf"), "mm", "utf8");
    const db = openDatabase(join(base, "idx.db"));
    try {
      const app = createApp({ db });
      const sync = await app.request("http://x/api/lmstudio/sync", {
        method: "POST",
        body: JSON.stringify({ root }),
        headers: { "Content-Type": "application/json" },
      });
      expect(sync.status).toBe(200);
      const syncJson = (await sync.json()) as { inserted: number; modelsRoot: string };
      expect(syncJson.inserted).toBe(1);
      expect(syncJson.modelsRoot).toBe(root);

      const status = await app.request(`http://x/api/lmstudio/status?root=${encodeURIComponent(root)}`);
      expect(status.status).toBe(200);
      const statusJson = (await status.json()) as { counts: { active: number; totalSizeBytes: number } };
      expect(statusJson.counts.active).toBe(1);
      expect(statusJson.counts.totalSizeBytes).toBe(7);

      const models = await app.request(`http://x/api/lmstudio/models?root=${encodeURIComponent(root)}&format=gguf&q=org`);
      expect(models.status).toBe(200);
      const modelsJson = (await models.json()) as { rows: { model_key: string; files: { rel_path: string }[] }[] };
      expect(modelsJson.rows[0].model_key).toBe("org/repo-GGUF");
      expect(modelsJson.rows[0].files.some((f) => f.rel_path === "repo-Q4_K_M.gguf")).toBe(true);

      const invalid = await app.request("http://x/api/lmstudio/sync", {
        method: "POST",
        body: JSON.stringify({ root: 123 }),
        headers: { "Content-Type": "application/json" },
      });
      expect(invalid.status).toBe(400);
    } finally {
      db.close();
    }
  });

  it("POST /api/chrome-history/sync and GET month/day", async () => {
    const base = join(tmpdir(), `ai2nao-chrome-api-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    const repo = join(base, "proj");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "package.json"), '{"name":"x"}', "utf8");

    const chromeHist = join(base, "History");
    const hw = new Database(chromeHist);
    hw.exec(`
      CREATE TABLE urls (
        id INTEGER PRIMARY KEY,
        url LONGVARCHAR NOT NULL,
        title LONGVARCHAR,
        visit_count INTEGER DEFAULT 0 NOT NULL,
        typed_count INTEGER DEFAULT 0 NOT NULL,
        last_visit_time INTEGER DEFAULT 0 NOT NULL,
        hidden INTEGER DEFAULT 0 NOT NULL
      );
      CREATE TABLE visits (
        id INTEGER PRIMARY KEY,
        url INTEGER NOT NULL,
        visit_time INTEGER NOT NULL,
        from_visit INTEGER,
        transition INTEGER DEFAULT 0 NOT NULL,
        segment_id INTEGER,
        visit_duration INTEGER DEFAULT 0 NOT NULL
      );
      CREATE TABLE downloads (
        id INTEGER PRIMARY KEY,
        guid VARCHAR,
        current_path LONGVARCHAR,
        target_path LONGVARCHAR,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        received_bytes INTEGER,
        total_bytes INTEGER,
        state INTEGER,
        danger_type INTEGER,
        interrupt_reason INTEGER,
        mime_type VARCHAR,
        referrer VARCHAR,
        site_url LONGVARCHAR,
        tab_url LONGVARCHAR,
        tab_referrer_url LONGVARCHAR
      );
    `);
    const webkitEpochMs = Date.UTC(1601, 0, 1);
    const visitUs = Math.round((Date.now() - webkitEpochMs) * 1000);
    hw.prepare(
      `INSERT INTO urls (id, url, title, visit_count, typed_count, last_visit_time, hidden)
       VALUES (1, 'https://example.com/sync-test', 'Sync Test', 1, 0, ?, 0)`
    ).run(visitUs);
    hw.prepare(
      `INSERT INTO visits (id, url, visit_time, from_visit, transition, segment_id, visit_duration)
       VALUES (1, 1, ?, NULL, 805306368, NULL, 0)`
    ).run(visitUs);
    hw.prepare(
      `INSERT INTO downloads (
        id, guid, current_path, target_path, start_time, end_time,
        received_bytes, total_bytes, state, danger_type, interrupt_reason,
        mime_type, referrer, site_url, tab_url, tab_referrer_url
      ) VALUES (
        1, 'g-sync', '/tmp/sync-dl-test.bin', '/tmp/sync-dl-test.bin', ?, ?,
        12, 100, 1, 0, 0,
        'application/octet-stream', 'https://ref.example', 'https://site.example',
        'https://tab.example', ''
      )`
    ).run(visitUs, visitUs);
    hw.close();

    const dbPath = join(base, "idx.db");
    const dbw = openDatabase(dbPath);
    runScan(dbw, [base], ["package.json"]);
    dbw.close();

    const db = openDatabase(dbPath);
    try {
      const app = createApp({ db });
      const sync = await app.request("http://x/api/chrome-history/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: "Default",
          historyPath: chromeHist,
        }),
      });
      expect(sync.status).toBe(200);
      const sj = (await sync.json()) as {
        insertedVisits: number;
        insertedDownloads: number;
        skippedDownloads: number;
        errors: string[];
      };
      expect(sj.errors.length).toBe(0);
      expect(sj.insertedVisits).toBe(1);
      expect(sj.insertedDownloads).toBe(1);

      const visitLocal = new Date(chromeWebkitUsToUnixMs(visitUs));
      const dayStr = `${visitLocal.getFullYear()}-${String(visitLocal.getMonth() + 1).padStart(2, "0")}-${String(visitLocal.getDate()).padStart(2, "0")}`;
      const y = visitLocal.getFullYear();
      const m = visitLocal.getMonth() + 1;
      const moRes = await app.request(
        `http://x/api/chrome-history/month?year=${y}&month=${m}&profile=Default`
      );
      expect(moRes.status).toBe(200);
      const mj = (await moRes.json()) as {
        days: { day: string; count: number }[];
      };
      expect(mj.days.some((d) => d.day === dayStr && d.count >= 1)).toBe(
        true
      );

      const dRes = await app.request(
        `http://x/api/chrome-history/day?date=${encodeURIComponent(dayStr)}&profile=Default`
      );
      expect(dRes.status).toBe(200);
      const dj = (await dRes.json()) as {
        entries: { url: string; visit_time_unix_ms: number }[];
      };
      expect(dj.entries.some((e) => e.url.includes("sync-test"))).toBe(true);

      const dlDay = await app.request(
        `http://x/api/chrome-downloads/day?date=${encodeURIComponent(dayStr)}&profile=Default`
      );
      expect(dlDay.status).toBe(200);
      const dlj = (await dlDay.json()) as {
        entries: { target_path: string | null }[];
      };
      expect(
        dlj.entries.some((e) =>
          (e.target_path ?? "").includes("sync-dl-test")
        )
      ).toBe(true);
    } finally {
      db.close();
    }
  });
});
