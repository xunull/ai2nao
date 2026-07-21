/**
 * AI 工具清单 API。`GET /api/ai-tools` 返回按 tool_key 折叠(F2)、再按 kind 分组的清单;
 * `POST /api/ai-tools/scan` 手动触发一次扫描。照 `src/software/routes.ts` 写法。
 */
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { getAiToolsStatus, listAiTools } from "./queries.js";
import { scanAiTools } from "./scan.js";
import type { AiToolKind, AiToolView } from "./types.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

const KIND_LABEL: Record<AiToolKind, string> = {
  "desktop-app": "桌面 app",
  cli: "命令行 CLI",
  "local-runtime": "本地运行时",
  "ide-extension": "IDE 插件",
};

export function registerAiToolsRoutes(app: Hono, db: Database.Database): void {
  app.get("/api/ai-tools/status", (c) => c.json(getAiToolsStatus(db)));

  app.get("/api/ai-tools", (c) => {
    const includeMissing = c.req.query("includeMissing") === "1";
    const tools = listAiTools(db, { includeMissing });
    const groups: { kind: AiToolKind; label: string; tools: AiToolView[] }[] = [];
    for (const t of tools) {
      let group = groups.find((g) => g.kind === t.kind);
      if (!group) {
        group = { kind: t.kind, label: KIND_LABEL[t.kind], tools: [] };
        groups.push(group);
      }
      group.tools.push(t);
    }
    return c.json({ groups, total: tools.length });
  });

  app.post("/api/ai-tools/scan", (c) => {
    try {
      const result = scanAiTools(db);
      if (!result.ok) return jsonErr(500, result.errorSummary ?? "ai-tools scan failed");
      return c.json(result);
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });
}
