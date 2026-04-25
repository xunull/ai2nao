import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve/app.js";
import { openDatabase } from "../src/store/open.js";

describe("software routes", () => {
  it("returns status and validates list query params", async () => {
    const base = join(tmpdir(), `ai2nao-software-api-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    const db = openDatabase(join(base, "idx.db"));
    try {
      db.prepare(
        `INSERT INTO brew_packages (
          kind, name, aliases_json, dependencies_json, first_seen_at, last_seen_at,
          inserted_at, updated_at
        ) VALUES ('formula', 'node', '[]', '[]', 'now', 'now', 'now', 'now')`
      ).run();
      const app = createApp({ db });
      const status = await app.request("http://x/api/brew/status");
      expect(status.status).toBe(200);

      const list = await app.request("http://x/api/brew/packages?kind=formula&limit=10");
      expect(list.status).toBe(200);
      const body = (await list.json()) as { total: number };
      expect(body.total).toBe(1);

      const badKind = await app.request("http://x/api/brew/packages?kind=nope");
      expect(badKind.status).toBe(400);

      const badLimit = await app.request("http://x/api/apps?limit=0");
      expect(badLimit.status).toBe(400);

      const malformedLimit = await app.request("http://x/api/apps?limit=1abc");
      expect(malformedLimit.status).toBe(400);

      const badOffset = await app.request("http://x/api/brew/packages?offset=1000001");
      expect(badOffset.status).toBe(400);

      const capped = await app.request("http://x/api/brew/packages?limit=1000");
      const cappedBody = (await capped.json()) as { limit: number };
      expect(cappedBody.limit).toBe(100);
    } finally {
      db.close();
    }
  });
});
