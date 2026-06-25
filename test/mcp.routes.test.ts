import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createApp } from "../src/serve/app.js";
import { openDatabase, openReadOnlyDatabase } from "../src/store/open.js";

const ACCEPT = "application/json, text/event-stream";

type Rpc = { jsonrpc: "2.0"; id?: number; method: string; params?: unknown };

async function rpc(app: ReturnType<typeof createApp>, body: Rpc, sid?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: ACCEPT,
  };
  if (sid) headers["mcp-session-id"] = sid;
  const res = await app.request("http://x/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    sid: res.headers.get("mcp-session-id"),
    json: text ? JSON.parse(text) : null,
  };
}

describe("MCP /mcp route", () => {
  let base: string;
  let writeDb: Database.Database;
  let mcpDb: Database.Database;

  beforeEach(() => {
    base = join(tmpdir(), `ai2nao-mcp-${Date.now()}-${Math.floor(performance.now())}`);
    mkdirSync(base, { recursive: true });
    const dbPath = join(base, "idx.db");
    writeDb = openDatabase(dbPath); // runs migrations
    mcpDb = openReadOnlyDatabase(dbPath);
  });

  afterEach(() => {
    writeDb.close();
    mcpDb.close();
  });

  it("is absent (404) when no mcpDb is supplied — protects the ~30 createApp({db}) callers", async () => {
    const app = createApp({ db: writeDb });
    const res = await app.request("http://x/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(404);
  });

  it("round-trips initialize -> tools/list -> tools/call over Streamable HTTP", async () => {
    const app = createApp({ db: writeDb, mcpDb });

    // 1) initialize — get a session id back
    const init = await rpc(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "1.0.0" },
      },
    });
    expect(init.status).toBe(200);
    expect(init.sid).toBeTruthy();
    expect(init.json.result.serverInfo.name).toBe("ai2nao");
    const sid = init.sid!;

    // 2) initialized notification (no id)
    await rpc(app, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);

    // 3) tools/list — our three v1 tools
    const list = await rpc(app, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
    const names = (list.json.result.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(["external_usage", "project_tokens", "time_spent"]);

    // 4) tools/call external_usage — returns structured JSON, no crash
    const call = await rpc(
      app,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "external_usage", arguments: {} } },
      sid
    );
    expect(call.status).toBe(200);
    const payload = JSON.parse(call.json.result.content[0].text);
    expect(payload).toHaveProperty("items");
    expect(payload).toHaveProperty("truncated");
  });

  it("project_tokens returns {found:false} (not empty) for an unknown project", async () => {
    const app = createApp({ db: writeDb, mcpDb });
    const init = await rpc(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "v", version: "1" } },
    });
    const sid = init.sid!;
    await rpc(app, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
    const call = await rpc(
      app,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "project_tokens", arguments: { project: "definitely-not-a-real-repo" } },
      },
      sid
    );
    const payload = JSON.parse(call.json.result.content[0].text);
    expect(payload.found).toBe(false);
    expect(Array.isArray(payload.candidates)).toBe(true);
  });

  it("the MCP db handle is read-only — a write throws", () => {
    expect(() => mcpDb.prepare("CREATE TABLE x (a)").run()).toThrow();
  });
});
