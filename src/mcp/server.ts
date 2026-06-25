/**
 * MCP server wiring for ai2nao — mounted on the existing Hono `serve` at /mcp.
 *
 * Transport: WebStandardStreamableHTTPServerTransport (fetch-native). The Hono
 * route is one line: `c => handler(c.req.raw)` returning a Response. We do NOT use
 * the Node req/res transport or @hono/mcp.
 *
 *   initialize (no session id) ──> new transport+server, onsessioninitialized stores it
 *   tools/list, tools/call (Mcp-Session-Id) ──> reuse the stored transport
 *   DELETE (Mcp-Session-Id) ──> onsessionclosed drops it
 *
 * enableJsonResponse: true → plain JSON responses (no SSE), simple to call and test.
 * The `transports` map is per-handler (per createApp), so test app instances stay isolated.
 *
 * All tools share ONE read-only db handle (better-sqlite3 is synchronous; concurrent
 * SELECTs are safe). The handle is owned + closed by the caller (runServe), not here.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerMcpTools } from "./tools.js";

const SERVER_INFO = { name: "ai2nao", version: "0.1.0" };

function buildServer(db: Database.Database): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerMcpTools(server, db);
  return server;
}

/** Returns a `(Request) => Promise<Response>` handler bound to one read-only db handle. */
export function createMcpHandler(db: Database.Database): (req: Request) => Promise<Response> {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

  return async (req: Request): Promise<Response> => {
    const sid = req.headers.get("mcp-session-id");
    const existing = sid ? transports.get(sid) : undefined;
    if (existing) return existing.handleRequest(req);

    // New session (the initialize request is session-id-less).
    const transport: WebStandardStreamableHTTPServerTransport =
      new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        transports.set(id, transport);
      },
      onsessionclosed: (id) => {
        transports.delete(id);
      },
    });
    const server = buildServer(db);
    await server.connect(transport);
    return transport.handleRequest(req);
  };
}
