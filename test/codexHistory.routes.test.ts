import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve/app.js";
import { openDatabase, openReadOnlyDatabase } from "../src/store/open.js";

describe("Codex history API", () => {
  it("returns fallback diagnostics without transcript text", async () => {
    const base = join(tmpdir(), `ai2nao-codex-api-${Date.now()}`);
    const codexRoot = join(base, "codex");
    const sessions = join(codexRoot, "sessions", "2026", "04", "26");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "rollout-2026-04-26T00-00-00-ffffffff-ffff-ffff-ffff-ffffffffffff.jsonl"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-04-26T00:00:00.000Z",
        payload: { type: "user_message", message: "private transcript text" },
      }),
      "utf8"
    );

    const dbPath = join(base, "idx.db");
    const dbw = openDatabase(dbPath);
    dbw.close();
    const db = openReadOnlyDatabase(dbPath);
    try {
      const app = createApp({ db });
      const res = await app.request(
        `http://x/api/codex-history/sessions?codexRoot=${encodeURIComponent(codexRoot)}`
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        source: string;
        diagnostics: { kind: string; message: string }[];
        sessions: { preview: string }[];
      };
      expect(json.source).toBe("fallback");
      expect(json.diagnostics[0].kind).toBe("state-db-unavailable");
      expect(JSON.stringify(json.diagnostics)).not.toContain("private transcript text");
      expect(json.sessions[0].preview).toContain("private transcript text");
    } finally {
      db.close();
    }
  });
});
