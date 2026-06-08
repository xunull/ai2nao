import type { Hono } from "hono";
import { listProjectOpeners, openProject, ProjectOpenError, type ProjectOpenerDeps } from "./service.js";
import type { OpenProjectRequest } from "./types.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

export function registerProjectOpenerRoutes(app: Hono, deps: ProjectOpenerDeps = {}) {
  app.get("/api/project-openers", (c) => {
    return c.json({ ok: true, openers: listProjectOpeners() });
  });

  app.post("/api/project-openers/open", async (c) => {
    try {
      const body = (await c.req.json()) as Partial<OpenProjectRequest>;
      const result = await openProject(
        {
          opener: String(body.opener ?? "") as OpenProjectRequest["opener"],
          path: String(body.path ?? ""),
        },
        deps
      );
      return c.json(result);
    } catch (e) {
      if (e instanceof ProjectOpenError) return jsonErr(e.status, e.message);
      const message = e instanceof Error ? e.message : String(e);
      return jsonErr(500, message);
    }
  });
}
