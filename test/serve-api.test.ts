import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve/app.js";
import { openDatabase, openReadOnlyDatabase } from "../src/store/open.js";
import { runScan } from "../src/scan/runScan.js";

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
    } finally {
      db.close();
    }
  });
});
