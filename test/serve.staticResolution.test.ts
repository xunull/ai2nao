import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { createApp, resolveWebDist } from "../src/serve/app.js";
import { packageRoot } from "../src/path/packageRoot.js";

/**
 * REGRESSION SUITE — this path had ZERO coverage while it was broken.
 *
 * `resolveWebDist()` was `join(process.cwd(), "web", "dist")`. That is only
 * correct when you happen to launch from the project directory. Anywhere else it
 * found nothing, and the failure was SILENT: `cli.ts` guards with
 * `existsSync(dist)`, flips `withStatic` to false, prints "API only." and starts
 * normally. So `ai2nao serve` from `/` gave you a working API and no UI, with no
 * error to explain it. Every npm-installed user hit this.
 *
 * The three states below are what the CLI can actually produce:
 *
 *   web/dist present, no --api-only   ──▶ staticRoot set   ──▶ GET / serves the SPA
 *   web/dist absent                   ──▶ staticRoot unset ──▶ GET / is 404 (api-only)
 *   --api-only (dist present or not)  ──▶ staticRoot unset ──▶ GET / is 404
 */

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-static-res-"));
  return openDatabase(join(dir, "test.db"));
}

/** A directory shaped like a built `web/dist`. */
function fakeWebDist(html: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-webdist-"));
  const dist = join(dir, "web", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), html);
  return dist;
}

describe("resolveWebDist — anchored to the install, not the working directory", () => {
  it("defaults to <packageRoot>/web/dist", () => {
    expect(resolveWebDist()).toBe(join(packageRoot(), "web", "dist"));
  });

  it("does NOT move when process.cwd() changes — the whole point of the fix", () => {
    const before = resolveWebDist();
    const elsewhere = mkdtempSync(join(tmpdir(), "ai2nao-cwd-"));
    const original = process.cwd();
    try {
      process.chdir(elsewhere);
      expect(resolveWebDist()).toBe(before);
      // And the old broken behaviour is genuinely gone: the result must not be
      // derived from wherever we happen to be standing.
      expect(resolveWebDist()).not.toBe(join(process.cwd(), "web", "dist"));
    } finally {
      process.chdir(original);
    }
  });

  it("still accepts an explicit root (callers may override)", () => {
    expect(resolveWebDist("/w/x/somewhere")).toBe(join("/w/x/somewhere", "web", "dist"));
  });
});

describe("createApp static serving — the three states the CLI can produce", () => {
  it("staticRoot present → GET / serves index.html", async () => {
    const app = createApp({ db: freshDb(), staticRoot: fakeWebDist("<h1>ai2nao</h1>") });
    const res = await app.fetch(new Request("http://127.0.0.1/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ai2nao");
  });

  it("staticRoot present → a deep SPA route also serves index.html (client-side routing)", async () => {
    const app = createApp({ db: freshDb(), staticRoot: fakeWebDist("<h1>ai2nao</h1>") });
    const res = await app.fetch(new Request("http://127.0.0.1/dashboard/tokens"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ai2nao");
  });

  it("staticRoot omitted (api-only) → GET / is 404, and the server still works", async () => {
    const app = createApp({ db: freshDb() });
    expect((await app.fetch(new Request("http://127.0.0.1/"))).status).toBe(404);
    // The API half must be unaffected — "no UI" is not "no server".
    expect((await app.fetch(new Request("http://127.0.0.1/api/status"))).status).toBe(200);
  });

  it("staticRoot points at a directory that does not exist → 404, not a crash", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "ai2nao-nodist-")), "web", "dist");
    const app = createApp({ db: freshDb(), staticRoot: missing });
    expect((await app.fetch(new Request("http://127.0.0.1/"))).status).toBe(404);
  });

  it("unknown /api routes stay 404 even with the SPA catch-all mounted", async () => {
    const app = createApp({ db: freshDb(), staticRoot: fakeWebDist("<h1>ai2nao</h1>") });
    const res = await app.fetch(new Request("http://127.0.0.1/api/definitely-not-a-route"));
    expect(res.status).toBe(404);
    // Must NOT be the SPA shell — that would turn every API typo into a 200 page.
    expect(await res.text()).not.toContain("ai2nao</h1>");
  });
});
