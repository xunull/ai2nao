import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { readLlmChatConfig } from "../llmChat/config.js";
import {
  emptyResponseToJson,
  inflightResponseToJson,
  latestResponseToJson,
  listResponseToJson,
  runResponseToJson,
} from "./json.js";
import {
  __resetInflightForTests,
  clearInflight,
  getInflight,
  setInflight,
} from "./inflight.js";
import {
  getLatestRecapRunByWindow,
  listRecapRunsByWindow,
} from "./queries.js";
import {
  generateRecap,
  type GenerateRecapResult,
  type WorkRecapRuntime,
} from "./service.js";
import {
  WORK_RECAP_WINDOWS,
  isWorkRecapWindow,
  type WorkRecapInflightResponse,
  type WorkRecapRun,
  type WorkRecapWindow,
} from "./types.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

function parseWindow(raw: string | undefined): WorkRecapWindow {
  const value = raw?.trim();
  if (!value || !isWorkRecapWindow(value)) {
    throw new Error(
      `window must be one of ${WORK_RECAP_WINDOWS.join(", ")}`
    );
  }
  return value;
}

function parseLimit(raw: string | undefined): number | undefined {
  if (!raw || !raw.trim()) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 200) {
    throw new Error("limit must be an integer in 1..200");
  }
  return n;
}

/**
 * In-flight tracking now lives in `./inflight.js` so the scheduled push task
 * shares the same guard as this HTTP route (otherwise the 21:00 tick and a
 * manual 「生成」 click would both issue an LLM call for the same window).
 * A second POST for the same window while one is running still returns 409.
 */
const inflight = {
  get: getInflight,
  set: setInflight,
  delete: clearInflight,
};

export { __resetInflightForTests };

export type RegisterWorkRecapOptions = {
  /** Override runtime construction (tests inject mock LLM + clock). */
  runtimeFactory?: (db: Database.Database) => WorkRecapRuntime;
  /** Override the generateRecap implementation (tests stub the whole pipeline). */
  generateImpl?: (
    windowKey: WorkRecapWindow,
    runtime: WorkRecapRuntime
  ) => Promise<GenerateRecapResult>;
};

function buildDefaultRuntime(
  db: Database.Database
): WorkRecapRuntime {
  return {
    db,
    llmConfig: readLlmChatConfig(),
  };
}

export function registerWorkRecapRoutes(
  app: Hono,
  db: Database.Database,
  options: RegisterWorkRecapOptions = {}
): void {
  const runtimeFactory =
    options.runtimeFactory ?? ((d: Database.Database) => buildDefaultRuntime(d));
  const generate = options.generateImpl ?? generateRecap;

  app.post("/api/work-recap/generate", async (c) => {
    let windowKey: WorkRecapWindow;
    try {
      windowKey = parseWindow(c.req.query("window"));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return jsonErr(400, message);
    }

    const existing = inflight.get(windowKey);
    if (existing) {
      const body: WorkRecapInflightResponse = {
        ok: false,
        inflight: true,
        windowKey,
        startedAt: existing.startedAt.toISOString(),
      };
      return c.json(inflightResponseToJson(body), 409);
    }

    const startedAt = new Date();
    const runtime = runtimeFactory(db);
    let resolvePromise: (run: WorkRecapRun) => void;
    let rejectPromise: (e: unknown) => void;
    const promise = new Promise<WorkRecapRun>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    inflight.set(windowKey, { startedAt, promise });

    try {
      const result = await generate(windowKey, runtime);
      if (result.kind === "empty") {
        // Empty does not insert a run; still resolve the promise gracefully
        // so any awaiters see a defined value (their request returned empty).
        resolvePromise!({
          id: -1,
          windowKey,
          generatedAt: startedAt,
          model: "empty",
          promptVersion: "empty",
          facts: {
            windowKey,
            windowStart: startedAt.toISOString(),
            windowEnd: startedAt.toISOString(),
            authorEmail: "",
            totalCommits: 0,
            projectCount: 0,
            projectShare: [],
            commitTypeCounts: {
              feat: 0,
              fix: 0,
              refactor: 0,
              docs: 0,
              chore: 0,
              test: 0,
              style: 0,
              perf: 0,
              build: 0,
              ci: 0,
              revert: 0,
              other: 0,
            },
            dailyCounts: [],
            reposScanned: 0,
            reposTotal: 0,
            scanTruncated: false,
            scanTruncatedReason: null,
            diagnostics: [],
            tokenFacts: { status: "absent" },
            topicDrift: { status: "absent" },
          },
          inference: {
            summary: "",
            workMode: "low_signal",
            workModeReason: "",
            nextUp: [],
            fragmentation: "low",
            degraded: true,
            degradeReason: "sparse_signal",
          },
        });
        return c.json(emptyResponseToJson(result.response));
      }
      resolvePromise!(result.run);
      return c.json(runResponseToJson({ ok: true, run: result.run }));
    } catch (e) {
      rejectPromise!(e);
      const message = e instanceof Error ? e.message : String(e);
      return jsonErr(500, message);
    } finally {
      inflight.delete(windowKey);
    }
  });

  app.get("/api/work-recap/latest", (c) => {
    try {
      const windowKey = parseWindow(c.req.query("window"));
      const run = getLatestRecapRunByWindow(db, windowKey);
      return c.json(latestResponseToJson({ ok: true, windowKey, run }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return jsonErr(400, message);
    }
  });

  app.get("/api/work-recap/list", (c) => {
    try {
      const windowKey = parseWindow(c.req.query("window"));
      const limit = parseLimit(c.req.query("limit"));
      const runs = listRecapRunsByWindow(db, windowKey, { limit });
      return c.json(listResponseToJson({ ok: true, windowKey, runs }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return jsonErr(400, message);
    }
  });
}
