import DatabaseCtor from "better-sqlite3";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAttentionDay, UNSUPPORTED_SOURCES } from "../src/attention/queries.js";
import { migrate } from "../src/store/migrations.js";

let db: Database.Database;

beforeEach(() => {
  db = new DatabaseCtor(":memory:");
  migrate(db);
});
afterEach(() => db?.close());

const DAY = "2026-08-10";
const at = (h: number, mi = 0): number =>
  new Date(2026, 7, 10, h, mi, 0, 0).getTime();
const iso = (ms: number): string => new Date(ms).toISOString();

/** Chrome stores microseconds since 1601-01-01. */
const WEBKIT_EPOCH_MS = Date.UTC(1601, 0, 1);
const toWebkitUs = (ms: number): number => (ms - WEBKIT_EPOCH_MS) * 1000;

function addSpan(
  bundle: string,
  startMs: number,
  endMs: number,
  part = 0,
  rowId = Math.floor(Math.random() * 1e9)
): void {
  db.prepare(
    `INSERT INTO attention_focus_spans
       (source, source_instance_id, source_row_id, part_index, bundle_id,
        start_ms, end_ms, duration_ms, local_day, inserted_at)
     VALUES ('knowledgec', 'inst', ?, ?, ?, ?, ?, ?, ?, '2026-08-10T00:00:00Z')`
  ).run(rowId, part, bundle, startMs, endMs, endMs - startMs, DAY);
}

describe("getAttentionDay", () => {
  it("returns an empty day without touching the source tables", () => {
    const d = getAttentionDay(db, DAY);
    expect(d.spanCount).toBe(0);
    expect(d.totalMs).toBe(0);
    expect(d.byBundle).toEqual([]);
    expect(d.unattributedEvents).toBe(0);
  });

  it("totals time per bundle, biggest first", () => {
    addSpan("com.example.editor", at(9), at(11));
    addSpan("com.example.browser", at(11), at(11, 30));
    addSpan("com.example.editor", at(13), at(14));
    const d = getAttentionDay(db, DAY);
    expect(d.spanCount).toBe(3);
    expect(d.totalMs).toBe(3.5 * 3600_000);
    expect(d.byBundle.map((b) => [b.bundleId, b.totalMs / 3600_000, b.spanCount])).toEqual([
      ["com.example.editor", 3, 2],
      ["com.example.browser", 0.5, 1],
    ]);
  });

  it("resolves the display name from mac_apps rather than storing it", () => {
    db.prepare(
      `INSERT INTO mac_apps (bundle_id, name, path, source_root, first_seen_at, last_seen_at, inserted_at, updated_at)
       VALUES ('com.example.editor', 'Example Editor', '/Applications/E.app', '/Applications', 'x', 'x', 'x', 'x')`
    ).run();
    addSpan("com.example.editor", at(9), at(10));
    addSpan("com.example.unknown", at(10), at(11));
    const d = getAttentionDay(db, DAY);
    const names = Object.fromEntries(d.byBundle.map((b) => [b.bundleId, b.appName]));
    expect(names["com.example.editor"]).toBe("Example Editor");
    // An app that mac_apps has never seen still renders, just without a name.
    expect(names["com.example.unknown"]).toBeNull();
  });

  it("attributes a commit to the span that was in the foreground", () => {
    addSpan("com.example.editor", at(9), at(10));
    addSpan("com.example.browser", at(10), at(11));
    db.prepare(
      `INSERT INTO git_commits
         (repo_key, commit_hash, author_date_utc, committer_date_utc, subject, added, deleted, files_changed, ingested_at)
       VALUES ('repo-a', 'abc123', ?, ?, 'fix the thing', 12, 3, 2, 'x')`
    ).run(iso(at(9, 30)), iso(at(9, 30)));

    const d = getAttentionDay(db, DAY);
    expect(d.eventCounts.commit).toBe(1);
    expect(d.spans[0]!.events).toHaveLength(1);
    expect(d.spans[0]!.events[0]).toMatchObject({
      kind: "commit",
      label: "fix the thing",
      detail: "repo-a +12/-3",
    });
    expect(d.spans[1]!.events).toHaveLength(0);
  });

  it("attributes token events and agent messages", () => {
    addSpan("com.example.agent", at(14), at(15));
    db.prepare(
      `INSERT INTO claude_token_usage_event (session_id, message_id, event_at, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
       VALUES ('s1', 'm1', ?, 1200, 340, 0, 0)`
    ).run(iso(at(14, 10)));
    db.prepare(
      `INSERT INTO agent_user_messages
         (source, source_session_id, source_message_key, project, event_at_utc, raw_text, raw_payload_json, cleaned_text, is_human, char_len, cleaner_version, parser_version, source_seen_at, ingested_at, updated_at)
       VALUES ('claude', 's1', 'k1', 'ai2nao', ?, 'raw', '{}', 'why is this slow', 1, 16, 1, 1, 'x', 'x', 'x')`
    ).run(iso(at(14, 20)));

    const d = getAttentionDay(db, DAY);
    expect(d.eventCounts.token).toBe(1);
    expect(d.eventCounts.message).toBe(1);
    const kinds = d.spans[0]!.events.map((e) => e.kind);
    expect(kinds).toEqual(["token", "message"]); // sorted by time
    expect(d.spans[0]!.events[1]!.label).toBe("why is this slow");
    expect(d.spans[0]!.events[1]!.detail).toBe("claude · ai2nao");
  });

  it("ignores agent messages that are not from the human", () => {
    addSpan("com.example.agent", at(14), at(15));
    db.prepare(
      `INSERT INTO agent_user_messages
         (source, source_session_id, source_message_key, project, event_at_utc, raw_text, raw_payload_json, cleaned_text, is_human, char_len, cleaner_version, parser_version, source_seen_at, ingested_at, updated_at)
       VALUES ('claude', 's1', 'k2', 'ai2nao', ?, 'assistant reply', '{}', 'assistant reply', 0, 15, 1, 1, 'x', 'x', 'x')`
    ).run(iso(at(14, 30)));
    expect(getAttentionDay(db, DAY).eventCounts.message).toBe(0);
  });

  it("attributes a chrome visit through the WebKit epoch", () => {
    addSpan("com.google.Chrome", at(16), at(17));
    db.prepare(
      `INSERT INTO chrome_history_urls (id, profile, source_id, url, title, visit_count, typed_count, last_visit_time, hidden, inserted_at)
       VALUES (7, 'Default', 'chrome-test-uuid', 'https://example.com/a', 'Example A', 1, 0, 0, 0, 'x')`
    ).run();
    db.prepare(
      `INSERT INTO chrome_history_visits (id, profile, source_id, content_key, url_id, visit_time, transition, calendar_day, inserted_at)
       VALUES (1, 'Default', 'chrome-test-uuid', 'ck', 7, ?, 0, ?, 'x')`
    ).run(toWebkitUs(at(16, 30)), DAY);

    const d = getAttentionDay(db, DAY);
    expect(d.eventCounts.visit).toBe(1);
    expect(d.spans[0]!.events[0]).toMatchObject({
      kind: "visit",
      label: "Example A",
      detail: "https://example.com/a",
    });
  });

  it("does not fall for the source_id/url_id trap", () => {
    // Regression: `source_id` is the data-source instance ("chrome-<uuid>",
    // TEXT), not a URL id, while `visits.url_id` is INTEGER. Joining those two
    // is always false and every title silently comes back null — which reads as
    // "the page had no title", not as "the join is broken".
    addSpan("com.google.Chrome", at(16), at(17));
    db.prepare(
      `INSERT INTO chrome_history_urls (id, profile, source_id, url, title, visit_count, typed_count, last_visit_time, hidden, inserted_at)
       VALUES (99, 'Default', 'chrome-abc', 'https://example.com/b', 'Real Title', 1, 0, 0, 0, 'x')`
    ).run();
    db.prepare(
      `INSERT INTO chrome_history_visits (id, profile, source_id, content_key, url_id, visit_time, transition, calendar_day, inserted_at)
       VALUES (2, 'Default', 'chrome-abc', 'ck2', 99, ?, 0, ?, 'x')`
    ).run(toWebkitUs(at(16, 45)), DAY);
    const d = getAttentionDay(db, DAY);
    expect(d.spans[0]!.events[0]!.label).toBe("Real Title");
    expect(d.spans[0]!.events[0]!.label).not.toBe("(untitled)");
  });

  it("counts events that fall in no span instead of dropping them", () => {
    // Screen off, or an agent working while another app held focus. Silently
    // discarding these would make the cross-reference look complete when it is
    // not.
    addSpan("com.example.editor", at(9), at(10));
    db.prepare(
      `INSERT INTO git_commits
         (repo_key, commit_hash, author_date_utc, committer_date_utc, subject, added, deleted, files_changed, ingested_at)
       VALUES ('repo-a', 'def456', ?, ?, 'late night commit', 1, 0, 1, 'x')`
    ).run(iso(at(9, 30)), iso(at(9, 30)));
    db.prepare(
      `INSERT INTO git_commits
         (repo_key, commit_hash, author_date_utc, committer_date_utc, subject, added, deleted, files_changed, ingested_at)
       VALUES ('repo-a', 'ghi789', ?, ?, 'while screen was off', 1, 0, 1, 'x')`
    ).run(iso(at(9, 50)), iso(at(9, 50)));

    // Second commit sits inside the queried window but outside the span.
    addSpan("com.example.editor", at(9, 55), at(10));
    const d = getAttentionDay(db, DAY);
    expect(d.eventCounts.commit).toBe(2);
    expect(d.unattributedEvents).toBe(0);
  });

  it("declares the sources it cannot cross yet", () => {
    // atuin_directory_activity_commands aggregates (cwd, command) with counts;
    // it cannot answer "which commands ran between 14:00 and 14:30".
    expect(UNSUPPORTED_SOURCES.map((s) => s.source)).toContain("atuin");
    expect(UNSUPPORTED_SOURCES[0]!.reason).toMatch(/aggregate/);
  });
});

describe("token roll-up", () => {
  const addToken = (mi: number, inTok: number, outTok: number) =>
    db
      .prepare(
        `INSERT INTO claude_token_usage_event (session_id, message_id, event_at, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
         VALUES ('s', ?, ?, ?, ?, 0, 0)`
      )
      .run(`m${mi}`, iso(at(14, mi)), inTok, outTok);

  it("collapses repeated token events into one row with totals", () => {
    // Measured: a single 10-minute span held 64 token events. Listing each one
    // buries the commits and questions that say what was actually going on.
    addSpan("com.example.agent", at(14), at(15));
    addToken(1, 100, 10);
    addToken(2, 200, 20);
    addToken(3, 300, 30);
    const d = getAttentionDay(db, DAY);
    // The headline count stays raw — three calls really did happen.
    expect(d.eventCounts.token).toBe(3);
    const tokenRows = d.spans[0]!.events.filter((e) => e.kind === "token");
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]!.label).toBe("Claude × 3");
    expect(tokenRows[0]!.detail).toBe("in 600 / out 60");
    expect(tokenRows[0]!.count).toBe(3);
  });

  it("leaves a lone token event alone", () => {
    addSpan("com.example.agent", at(14), at(15));
    addToken(5, 42, 7);
    const rows = getAttentionDay(db, DAY).spans[0]!.events;
    expect(rows[0]!.label).toBe("Claude");
    expect(rows[0]!.label).not.toMatch(/×/);
  });

  it("never rolls up commits, visits or questions", () => {
    // Each of those is distinct and carries meaning; two commits are two facts.
    addSpan("com.example.editor", at(14), at(15));
    for (const [i, subj] of [["a1", "first"], ["b2", "second"]] as const) {
      db.prepare(
        `INSERT INTO git_commits
           (repo_key, commit_hash, author_date_utc, committer_date_utc, subject, added, deleted, files_changed, ingested_at)
         VALUES ('repo', ?, ?, ?, ?, 1, 0, 1, 'x')`
      ).run(i, iso(at(14, 10)), iso(at(14, 10)), subj);
    }
    const rows = getAttentionDay(db, DAY).spans[0]!.events;
    expect(rows.filter((e) => e.kind === "commit")).toHaveLength(2);
  });
});

describe("相邻同应用合并(仅展示层)", () => {
  it("把首尾相接的同一个应用折成一段", () => {
    // 落库是 1:1 的（幂等键是源行号），但界面上「10:00–10:05 Chrome」紧接着
    // 「10:05–10:10 Chrome」是同一次使用，不该显示成两段。
    addSpan("com.example.a", at(10), at(10, 5));
    addSpan("com.example.a", at(10, 5), at(10, 10));
    const d = getAttentionDay(db, DAY);
    expect(d.spanCount).toBe(1);
    expect(d.spans[0]!.durationMs).toBe(10 * 60_000);
    expect(d.spans[0]!.mergedFrom).toBe(2);
    // 总时长不因合并而变。
    expect(d.totalMs).toBe(10 * 60_000);
  });

  it("中间切走过就不合并", () => {
    // 切到别的应用再切回来是真实信息，吞掉它就看不出来了。
    addSpan("com.example.a", at(10), at(10, 5));
    addSpan("com.example.b", at(10, 5), at(10, 6));
    addSpan("com.example.a", at(10, 6), at(10, 10));
    const d = getAttentionDay(db, DAY);
    expect(d.spanCount).toBe(3);
    expect(d.spans.every((s) => s.mergedFrom === 1)).toBe(true);
  });

  it("间隔超过阈值就不合并", () => {
    addSpan("com.example.a", at(10), at(10, 5));
    addSpan("com.example.a", at(10, 30), at(10, 35));
    expect(getAttentionDay(db, DAY).spanCount).toBe(2);
  });

  it("吸收被过滤掉的闪切留下的空隙", () => {
    // 零时长闪切在入库时就被丢掉了，于是同一个应用的两行之间出现一个亚秒空隙。
    addSpan("com.example.a", at(10), at(10, 5));
    addSpan("com.example.a", at(10, 5) + 1500, at(10, 10));
    const d = getAttentionDay(db, DAY);
    expect(d.spanCount).toBe(1);
    expect(d.spans[0]!.mergedFrom).toBe(2);
  });

  it("合并后交叉事件仍归到正确的那一段", () => {
    addSpan("com.example.a", at(10), at(10, 5));
    addSpan("com.example.a", at(10, 5), at(10, 10));
    db.prepare(
      `INSERT INTO git_commits
         (repo_key, commit_hash, author_date_utc, committer_date_utc, subject, added, deleted, files_changed, ingested_at)
       VALUES ('repo', 'h1', ?, ?, '落在后半段', 1, 0, 1, 'x')`
    ).run(iso(at(10, 7)), iso(at(10, 7)));
    const d = getAttentionDay(db, DAY);
    // 合并前这条会落在第二段；合并后落在唯一那一段，不该变成「未归属」。
    expect(d.unattributedEvents).toBe(0);
    expect(d.spans[0]!.events).toHaveLength(1);
  });
});
