import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/open.js";
import { createApp } from "../src/serve/app.js";
import {
  isInjectedNoise,
  scrubPaths,
  kmeans,
  nearestCentroid,
  tfidfLabels,
  aggregateConversationSessions,
  rebuildConversationTopicStream,
  conversationLegend,
  type Embedder,
} from "../src/topicStream/conversation.js";

function freshDb() {
  return openDatabase(
    join(tmpdir(), `ai2nao-conv-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  );
}

/** Deterministic fake embedder: keyword → one of 4 near-orthogonal base vectors. */
const fakeEmbedder: Embedder = async (texts) =>
  texts.map((t) => {
    const v = new Float32Array(8);
    if (/rust/i.test(t)) v[0] = 1;
    else if (/react/i.test(t)) v[1] = 1;
    else if (/sql/i.test(t)) v[2] = 1;
    else if (/xyzzy/i.test(t)) v[3] = 1; // orthogonal outlier (far-drift)
    else v[4] = 1;
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) & 0xffff;
    v[7] = (h % 100) / 5000; // tiny jitter so points aren't identical
    return { dim: 8, vector: v };
  });

let msgSeq = 0;
function seedMessage(
  db: ReturnType<typeof openDatabase>,
  o: { source: string; session: string; text: string; at: string; isHuman?: number }
) {
  db.prepare(
    `INSERT INTO agent_user_messages
       (source, source_session_id, source_message_key, event_at_utc,
        raw_text, raw_payload_json, cleaned_text, is_human, char_len,
        cleaner_version, parser_version, source_seen_at, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, 1, 1, 'now', 'now', 'now')`
  ).run(
    o.source,
    o.session,
    `m${msgSeq++}`,
    o.at,
    o.text,
    o.text,
    o.isHuman ?? 1,
    o.text.length
  );
}

/** Seed N sessions per keyword topic, one human message each. */
function seedTopics(
  db: ReturnType<typeof openDatabase>,
  topics: { kw: string; n: number }[]
) {
  let day = 1;
  for (const { kw, n } of topics) {
    for (let i = 0; i < n; i++) {
      seedMessage(db, {
        source: "claude",
        session: `${kw}-${i}`,
        text: `${kw} question about ${kw} internals and ${kw} usage details here`,
        at: `2026-07-${String(day).padStart(2, "0")}T0${i % 9}:00:00Z`,
      });
      day = (day % 28) + 1;
    }
  }
}

describe("conversation adapter — pure helpers", () => {
  it("drops injected boilerplate, keeps real questions", () => {
    expect(isInjectedNoise("(Re-invocation of /gstack-office-hours — ...)")).toBe(true);
    expect(isInjectedNoise("# AGENTS.md instructions for /Users/x/repo")).toBe(true);
    expect(isInjectedNoise('--- {"type": "permission-mode", "x": 1}')).toBe(true);
    expect(isInjectedNoise("Your tool call was malformed and could not be parsed.")).toBe(true);
    expect(isInjectedNoise("django 用 python-dotenv 是最佳实践么")).toBe(false);
  });

  it("scrubs home paths", () => {
    expect(scrubPaths("see /Users/alice/repo/x.ts and /home/bob/y")).toBe(
      "see /Users/*/repo/x.ts and /home/*/y"
    );
  });

  it("kmeans is deterministic for a fixed seed", () => {
    const vecs = Array.from({ length: 20 }, (_, i) => {
      const v = new Float32Array(4);
      v[i % 3] = 1;
      v[3] = i / 1000;
      return v;
    });
    const a = kmeans(vecs, 3, 42);
    const b = kmeans(vecs, 3, 42);
    expect(a.assign).toEqual(b.assign);
    expect(a.centroids.length).toBe(3);
  });

  it("nearestCentroid: aligned ≈ 0 distance, orthogonal ≈ 1", () => {
    const cx = new Float32Array([1, 0, 0]);
    const cy = new Float32Array([0, 1, 0]);
    const aligned = nearestCentroid(new Float32Array([1, 0, 0]), [cx, cy]);
    expect(aligned.cluster).toBe(0);
    expect(aligned.dist).toBeLessThan(0.01);
    const ortho = nearestCentroid(new Float32Array([0, 0, 1]), [cx, cy]);
    expect(ortho.dist).toBeGreaterThan(0.9);
  });

  it("tfidfLabels picks distinctive terms per cluster", () => {
    const labels = tfidfLabels([
      ["rust borrow checker", "rust lifetimes"],
      ["react hooks", "react component"],
    ]);
    expect(labels[0]).toContain("rust");
    expect(labels[1]).toContain("react");
  });
});

describe("conversation adapter — aggregation", () => {
  it("groups human messages, drops noise, floors short text, uses MIN(event_at_utc)", () => {
    const db = freshDb();
    try {
      // two real messages (later time first to prove MIN wins) + one injected noise
      seedMessage(db, {
        source: "claude",
        session: "s1",
        text: "how do I configure django settings with env vars properly",
        at: "2026-07-05T10:00:00Z",
      });
      seedMessage(db, {
        source: "claude",
        session: "s1",
        text: "and where is the .env file parsed in this project",
        at: "2026-07-05T09:00:00Z",
      });
      seedMessage(db, {
        source: "claude",
        session: "s1",
        text: "(Re-invocation of /gstack-office-hours — noise)",
        at: "2026-07-05T11:00:00Z",
      });
      // too-short session → dropped
      seedMessage(db, { source: "codex", session: "s2", text: "hi", at: "2026-07-06T00:00:00Z" });

      const sessions = aggregateConversationSessions(db);
      expect(sessions.map((s) => s.key)).toEqual(["claude:s1"]);
      const s1 = sessions[0]!;
      expect(s1.msgCount).toBe(2); // noise dropped
      expect(s1.text).not.toContain("Re-invocation");
      expect(s1.eventTime).toBe(Date.parse("2026-07-05T09:00:00Z"));
    } finally {
      db.close();
    }
  });
});

describe("conversation adapter — rebuild", () => {
  it("reports cold_start below the floor and writes no rows", async () => {
    const db = freshDb();
    try {
      seedTopics(db, [{ kw: "rust", n: 3 }]);
      const r = await rebuildConversationTopicStream(db, {
        embedder: fakeEmbedder,
        coldFloor: 10,
        k: 3,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("cold_start");
      const rows = (db.prepare("SELECT COUNT(*) c FROM topic_stream WHERE source='conversation'").get() as { c: number }).c;
      expect(rows).toBe(0);
    } finally {
      db.close();
    }
  });

  it("builds a frozen codebook, bands the sessions, and is stable across rebuilds", async () => {
    const db = freshDb();
    try {
      seedTopics(db, [
        { kw: "rust", n: 4 },
        { kw: "react", n: 4 },
        { kw: "sql", n: 4 },
      ]);
      const r1 = await rebuildConversationTopicStream(db, { embedder: fakeEmbedder, coldFloor: 6, k: 3 });
      expect(r1.ok).toBe(true);
      expect(r1.derivedCount).toBe(12);

      const cats1 = db
        .prepare("SELECT session_id, category FROM topic_stream WHERE source='conversation' ORDER BY session_id")
        .all() as { session_id: string; category: string }[];
      // rust/react/sql sessions land in 3 distinct non-其他 bands
      const bands = new Set(cats1.map((r) => r.category));
      expect(bands.size).toBe(3);
      expect(bands.has("其他")).toBe(false);

      const codebook = (db.prepare("SELECT COUNT(*) c FROM topic_codebook WHERE rule_version='cluster-v1'").get() as { c: number }).c;
      expect(codebook).toBe(3);

      // second rebuild uses the FROZEN codebook → identical session→band map
      const r2 = await rebuildConversationTopicStream(db, { embedder: fakeEmbedder, coldFloor: 6, k: 3 });
      expect(r2.ok).toBe(true);
      const cats2 = db
        .prepare("SELECT session_id, category FROM topic_stream WHERE source='conversation' ORDER BY session_id")
        .all() as { session_id: string; category: string }[];
      expect(cats2).toEqual(cats1);
    } finally {
      db.close();
    }
  });

  it("routes a far-drift session (dist > τ) into 其他 against the frozen codebook", async () => {
    const db = freshDb();
    try {
      seedTopics(db, [
        { kw: "rust", n: 4 },
        { kw: "react", n: 4 },
        { kw: "sql", n: 4 },
      ]);
      await rebuildConversationTopicStream(db, { embedder: fakeEmbedder, coldFloor: 6, k: 3 });
      // add an orthogonal outlier, rebuild WITHOUT reclustering
      seedMessage(db, {
        source: "claude",
        session: "outlier",
        text: "xyzzy totally unrelated new topic xyzzy that no cluster covers",
        at: "2026-07-20T00:00:00Z",
      });
      const r = await rebuildConversationTopicStream(db, { embedder: fakeEmbedder, coldFloor: 6, k: 3 });
      expect(r.ok).toBe(true);
      const cat = (db
        .prepare("SELECT category FROM topic_stream WHERE source='conversation' AND session_id='claude:outlier'")
        .get() as { category: string }).category;
      expect(cat).toBe("其他");
    } finally {
      db.close();
    }
  });

  it("no embedder + no cache → no_vectors (does not throw)", async () => {
    const db = freshDb();
    try {
      seedTopics(db, [{ kw: "rust", n: 8 }]);
      const r = await rebuildConversationTopicStream(db, {
        cfg: null,
        coldFloor: 6,
        k: 3,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("no_vectors");
    } finally {
      db.close();
    }
  });
});

describe("conversation adapter — legend + route", () => {
  it("conversationLegend returns codebook labels keyed by cluster_id, 其他 last", async () => {
    const db = freshDb();
    try {
      seedTopics(db, [
        { kw: "rust", n: 4 },
        { kw: "react", n: 4 },
        { kw: "sql", n: 4 },
      ]);
      await rebuildConversationTopicStream(db, { embedder: fakeEmbedder, coldFloor: 6, k: 3 });
      const legend = conversationLegend(db);
      expect(legend.length).toBe(4); // 3 clusters + 其他
      expect(legend[legend.length - 1]).toEqual({ name: "其他", color: "#8a8f98" });
      // every non-其他 entry has a color
      for (const e of legend.slice(0, -1)) expect(e.color).toMatch(/^#/);
    } finally {
      db.close();
    }
  });

  it("GET /api/topics/categories?source=conversation returns the codebook legend", async () => {
    const db = freshDb();
    try {
      seedTopics(db, [
        { kw: "rust", n: 4 },
        { kw: "react", n: 4 },
        { kw: "sql", n: 4 },
      ]);
      await rebuildConversationTopicStream(db, { embedder: fakeEmbedder, coldFloor: 6, k: 3 });
      const app = createApp({ db });
      const res = await app.request("/api/topics/categories?source=conversation");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { source: string; categories: { name: string }[] };
      expect(body.source).toBe("conversation");
      expect(body.categories.some((c) => c.name === "其他")).toBe(true);
      expect(body.categories.length).toBe(4);
    } finally {
      db.close();
    }
  });
});
