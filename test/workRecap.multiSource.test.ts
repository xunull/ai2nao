import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/open.js";
import { computeFacts, isSparseFacts } from "../src/workRecap/facts.js";
import {
  gatherTopicDriftFacts,
  gatherTokenFacts,
} from "../src/workRecap/multiSourceFacts.js";
import { buildPrompt, PROMPT_VERSION } from "../src/workRecap/prompt.js";
import type { WorkRecapFacts } from "../src/workRecap/types.js";

function freshDb() {
  return openDatabase(
    join(tmpdir(), `ai2nao-wr-ms-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  );
}

let seq = 0;
function seedTopic(
  db: ReturnType<typeof openDatabase>,
  o: { source: string; profile: string; category: string; day: string }
) {
  db.prepare(
    `INSERT INTO topic_stream
       (source, profile, source_ref, session_id, category, calendar_day, event_time, weight, payload, inserted_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 1, '{}', 'now')`
  ).run(o.source, o.profile, `r${seq++}`, o.category, o.day, Date.parse(o.day + "T00:00:00Z"));
}

function baseFacts(): WorkRecapFacts {
  return computeFacts({
    commits: [],
    windowKey: "7d",
    windowStart: new Date("2026-07-01T00:00:00Z"),
    windowEnd: new Date("2026-07-08T00:00:00Z"),
    authorEmail: "x@example.com",
    reposScanned: 1,
    reposTotal: 1,
    scanTruncated: false,
    scanTruncatedReason: null,
    scanDiagnostics: [],
  });
}

describe("work-recap v2 — isSparseFacts (multi-source decouple)", () => {
  it("commit-sparse but token OK is NOT sparse (explore window)", () => {
    const f = baseFacts();
    expect(isSparseFacts(f)).toBe(true); // all absent
    f.tokenFacts = { status: "ok", data: {} as never };
    expect(isSparseFacts(f)).toBe(false);
  });
  it("commit-sparse + topic OK is NOT sparse", () => {
    const f = baseFacts();
    f.topicDrift = { status: "ok", data: {} as never };
    expect(isSparseFacts(f)).toBe(false);
  });
  it("commits present → not sparse regardless", () => {
    const f = baseFacts();
    f.totalCommits = 5;
    expect(isSparseFacts(f)).toBe(false);
  });
});

describe("work-recap v2 — gatherTopicDriftFacts", () => {
  const start = new Date("2026-07-01T00:00:00");
  const end = new Date("2026-07-07T00:00:00");

  it("de-weights chrome generic browsing; keeps git/conversation dev topics", () => {
    const db = freshDb();
    try {
      // chrome: mostly generic (搜索/其他) + one dev category
      for (let i = 0; i < 20; i++) seedTopic(db, { source: "chrome", profile: "Default", category: "搜索", day: "2026-07-02" });
      for (let i = 0; i < 3; i++) seedTopic(db, { source: "chrome", profile: "Default", category: "AI·ML", day: "2026-07-02" });
      for (let i = 0; i < 4; i++) seedTopic(db, { source: "git", profile: "-", category: "ai2nao", day: "2026-07-03" });
      const g = gatherTopicDriftFacts(db, start, end);
      expect(g.status).toBe("ok");
      const chrome = g.data!.bySource.find((s) => s.source === "chrome")!;
      // 搜索 is de-weighted → AI·ML surfaces as the top (generic excluded)
      expect(chrome.top.map((t) => t.name)).not.toContain("搜索");
      expect(chrome.top.map((t) => t.name)).toContain("AI·ML");
      const git = g.data!.bySource.find((s) => s.source === "git")!;
      expect(git.top[0]!.name).toBe("ai2nao");
    } finally {
      db.close();
    }
  });

  it("gates drift on volume: below threshold → drift null even if top shifts", () => {
    const db = freshDb();
    try {
      // conversation: only 6 events across 2 days, top shifts A→B — but below min-events
      for (let i = 0; i < 3; i++) seedTopic(db, { source: "conversation", profile: "-", category: "Git安全审计", day: "2026-07-02" });
      for (let i = 0; i < 3; i++) seedTopic(db, { source: "conversation", profile: "-", category: "开发咨询", day: "2026-07-05" });
      const g = gatherTopicDriftFacts(db, start, end);
      expect(g.status).toBe("ok");
      expect(g.data!.drift).toBeNull(); // 6 events < WORK_RECAP_DRIFT_MIN_EVENTS
    } finally {
      db.close();
    }
  });

  it("emits drift when volume clears threshold and top category shifts across buckets", () => {
    const db = freshDb();
    try {
      for (let i = 0; i < 20; i++) seedTopic(db, { source: "conversation", profile: "-", category: "Git安全审计", day: "2026-07-02" });
      for (let i = 0; i < 20; i++) seedTopic(db, { source: "conversation", profile: "-", category: "开发咨询", day: "2026-07-05" });
      const g = gatherTopicDriftFacts(db, start, end);
      expect(g.status).toBe("ok");
      expect(g.data!.drift).toEqual([{ source: "conversation", from: "Git安全审计", to: "开发咨询" }]);
    } finally {
      db.close();
    }
  });

  it("empty window → status empty (not error)", () => {
    const db = freshDb();
    try {
      const g = gatherTopicDriftFacts(db, start, end);
      expect(g.status).toBe("empty");
    } finally {
      db.close();
    }
  });
});

describe("work-recap v2 — gatherTokenFacts", () => {
  it("no token data → status empty, does not throw", () => {
    const db = freshDb();
    try {
      const g = gatherTokenFacts(db, new Date("2026-07-01"), new Date("2026-07-08"));
      expect(g.status).toBe("empty");
    } finally {
      db.close();
    }
  });
});

describe("work-recap v2 — buildPrompt", () => {
  it("prompt is version v2, includes token+topic facts before projects, hedges partial coverage, and suppresses null drift", () => {
    expect(PROMPT_VERSION).toBe("work-recap@v2");
    const f = baseFacts();
    f.tokenFacts = {
      status: "ok",
      data: {
        costUsd: 12.5,
        coverage: "partial",
        unpricedTokenCount: 100,
        priceSnapshotDate: "2026-07-01",
        headlineTokens: 1_000_000,
        dominantProvider: "claude",
        claudeShare: 0.9,
        codexShare: 0.1,
      },
    };
    f.topicDrift = {
      status: "ok",
      data: {
        bySource: [{ source: "conversation", events: 40, top: [{ name: "Git安全审计", count: 20, share: 0.5 }] }],
        drift: null,
      },
    };
    const out = buildPrompt({ facts: f, commits: [] });
    expect(out.prompt).toContain("Token/cost");
    expect(out.prompt).toContain("coverage=partial"); // hedge present
    expect(out.prompt).toContain("Git安全审计");
    expect(out.prompt).toContain("do not narrate a shift"); // drift null guidance
    // new facts appear before the Projects section (survive tail-truncation)
    expect(out.prompt.indexOf("Token/cost")).toBeLessThan(out.prompt.indexOf("Projects (top by commit count)"));
  });

  it("renders status labels for absent/empty fact groups", () => {
    const f = baseFacts(); // tokenFacts/topicDrift default to absent
    const out = buildPrompt({ facts: f, commits: [] });
    expect(out.prompt).toContain("Token/cost: (source not available)");
    expect(out.prompt).toContain("Topics: (source not available)");
  });
});
