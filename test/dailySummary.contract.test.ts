import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AtuinEntry } from "../src/atuin/queries.js";
import { generateDailySummary } from "../src/dailySummary/service.js";
import { openDatabase } from "../src/store/open.js";
import { runScan } from "../src/scan/runScan.js";

function createIndexDb() {
  const base = join(tmpdir(), `ai2nao-contract-${Date.now()}-${Math.random()}`);
  const repo = join(base, "proj");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "proj", description: "contract test repo" }),
    "utf8"
  );
  const db = openDatabase(join(base, "idx.db"));
  runScan(db, [base], ["package.json"]);
  return { db, repo };
}

function makeEntry(repo: string, command: string): AtuinEntry {
  return {
    id: `${command}-${Date.now()}`,
    timestamp_ns: Date.now() * 1_000_000,
    duration: 0,
    exit: 0,
    command,
    cwd: repo,
    hostname: "h",
    session: "s",
  };
}

describe("daily summary LLM contract", () => {
  it("degrades on empty LLM response", async () => {
    const { db, repo } = createIndexDb();
    try {
      const payload = await generateDailySummary({
        date: "2026-04-07",
        indexDb: db,
        atuinEntries: [makeEntry(repo, "npm test"), makeEntry(repo, "npm run build"), makeEntry(repo, "git status")],
        cacheDb: null,
        runtime: {
          enabled: true,
          cacheDbPath: join(tmpdir(), "noop.db"),
          llm: {
            baseUrl: "http://llm.test/v1",
            model: "fake-model",
            timeoutMs: 1000,
            fetchImpl: async () =>
              new Response(
                JSON.stringify({ choices: [{ message: { content: "" } }] }),
                {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                }
              ),
          },
        },
      });
      expect(payload.degraded).toBe(true);
      expect(payload.degradeReason).toBe("llm_empty");
      expect(payload.meta.usedLlm).toBe(false);
    } finally {
      db.close();
    }
  });

  it("degrades on malformed LLM JSON", async () => {
    const { db, repo } = createIndexDb();
    try {
      const payload = await generateDailySummary({
        date: "2026-04-07",
        indexDb: db,
        atuinEntries: [makeEntry(repo, "npm test"), makeEntry(repo, "npm run build"), makeEntry(repo, "git status")],
        cacheDb: null,
        runtime: {
          enabled: true,
          cacheDbPath: join(tmpdir(), "noop.db"),
          llm: {
            baseUrl: "http://llm.test/v1",
            model: "fake-model",
            timeoutMs: 1000,
            fetchImpl: async () =>
              new Response(
                JSON.stringify({
                  choices: [{ message: { content: "{not json" } }],
                }),
                {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                }
              ),
          },
        },
      });
      expect(payload.degraded).toBe(true);
      expect(payload.degradeReason).toBe("llm_malformed");
    } finally {
      db.close();
    }
  });

  it("degrades on timeout", async () => {
    const { db, repo } = createIndexDb();
    try {
      const payload = await generateDailySummary({
        date: "2026-04-07",
        indexDb: db,
        atuinEntries: [makeEntry(repo, "npm test"), makeEntry(repo, "npm run build"), makeEntry(repo, "git status")],
        cacheDb: null,
        runtime: {
          enabled: true,
          cacheDbPath: join(tmpdir(), "noop.db"),
          llm: {
            baseUrl: "http://llm.test/v1",
            model: "fake-model",
            timeoutMs: 1,
            fetchImpl: async (_input, init) =>
              new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () =>
                  reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
                );
              }),
          },
        },
      });
      expect(payload.degraded).toBe(true);
      expect(payload.degradeReason).toBe("llm_timeout");
    } finally {
      db.close();
    }
  });

  it("degrades when text conflicts with deterministic facts", async () => {
    const { db, repo } = createIndexDb();
    try {
      const payload = await generateDailySummary({
        date: "2026-04-07",
        indexDb: db,
        atuinEntries: [makeEntry(repo, "npm test"), makeEntry(repo, "npm run build"), makeEntry(repo, "git status")],
        cacheDb: null,
        runtime: {
          enabled: true,
          cacheDbPath: join(tmpdir(), "noop.db"),
          llm: {
            baseUrl: "http://llm.test/v1",
            model: "fake-model",
            timeoutMs: 1000,
            fetchImpl: async () =>
              new Response(
                JSON.stringify({
                  choices: [
                    {
                      message: {
                        content: JSON.stringify({
                          summary: "Worked mainly in another-repo.",
                          nextUp: "Continue there tomorrow.",
                          workMode: "implementation",
                          primaryRepoLabel: "another-repo",
                        }),
                      },
                    },
                  ],
                }),
                {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                }
              ),
          },
        },
      });
      expect(payload.degraded).toBe(true);
      expect(payload.degradeReason).toBe("text_fact_conflict");
      expect(payload.summary).toContain("Main focus appears to be proj");
    } finally {
      db.close();
    }
  });
});

