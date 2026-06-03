import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve/app.js";
import { openDatabase } from "../src/store/open.js";

function qs(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

describe("Cherry Studio history routes", () => {
  it("serves status, list, detail, and search for Markdown exports", async () => {
    const dbPath = join(tmpdir(), `ai2nao-cherry-route-${Date.now()}.db`);
    const db = openDatabase(dbPath);
    const root = join(tmpdir(), `ai2nao-cherry-route-root-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "topic.md"),
      "# Cherry 路由\n\n## User\n\nhello cherry\n---\n## Assistant\n\nroute search works",
      "utf8"
    );
    writeFileSync(
      join(root, "older.md"),
      "# Older Cherry\n\n## User\n\nolder",
      "utf8"
    );
    const app = createApp({ db });
    try {
      const query = qs({ exportRoot: root, cherryRoot: root });
      const status = await app.request(`http://x/api/cherry-studio-history/status?${query}`);
      expect(status.status).toBe(200);
      const statusJson = (await status.json()) as { exportRoot?: string; agentDbMissing: boolean };
      expect(statusJson.exportRoot).toBe(root);
      expect(statusJson.agentDbMissing).toBe(true);

      const list = await app.request(`http://x/api/cherry-studio-history/sessions?${query}&limit=50&offset=0`);
      expect(list.status).toBe(200);
      const listJson = (await list.json()) as {
        total: number;
        limit: number;
        offset: number;
        sessions: Array<{ id: string; title: string }>;
      };
      expect(listJson.total).toBe(2);
      expect(listJson.limit).toBe(50);
      expect(listJson.offset).toBe(0);
      const cherryRoute = listJson.sessions.find((s) => s.title === "Cherry 路由");
      expect(cherryRoute).toBeTruthy();

      const pageTwo = await app.request(`http://x/api/cherry-studio-history/sessions?${query}&limit=1&offset=1`);
      expect(pageTwo.status).toBe(200);
      const pageTwoJson = (await pageTwo.json()) as {
        total: number;
        limit: number;
        offset: number;
        sessions: Array<{ id: string; title: string }>;
      };
      expect(pageTwoJson.total).toBe(2);
      expect(pageTwoJson.limit).toBe(1);
      expect(pageTwoJson.offset).toBe(1);
      expect(pageTwoJson.sessions).toHaveLength(1);

      const id = encodeURIComponent(cherryRoute!.id);
      const detail = await app.request(`http://x/api/cherry-studio-history/sessions/${id}?${query}`);
      expect(detail.status).toBe(200);
      const detailJson = (await detail.json()) as { session: { messages: unknown[] } };
      expect(detailJson.session.messages).toHaveLength(2);

      const search = await app.request(
        `http://x/api/cherry-studio-history/search?${query}&q=${encodeURIComponent("route search")}`
      );
      expect(search.status).toBe(200);
      const searchJson = (await search.json()) as { results: unknown[] };
      expect(searchJson.results).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
