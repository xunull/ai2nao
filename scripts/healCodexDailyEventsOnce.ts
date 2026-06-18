/**
 * One-off: backfill the codex_token_usage_event timeline (v4 rule).
 *
 * Before this, the trend page bucketed each Codex session's total on its
 * `last_updated_at`, so a multi-day resumed session collapsed a week of tokens
 * onto its final day. The fix records each token_count event's per-event delta
 * against its own timestamp; this forces a full reparse so existing sessions
 * populate the event table.
 *
 * The self-heal at the refresh entry only fires when stored rule_version !=
 * CODEX_TOKEN_USAGE_RULE_VERSION. If a partial hot-reload already stamped the
 * state at v4 while the event table is still empty, self-heal would skip. This
 * script forces full=true directly.
 *
 * Run:  npx tsx scripts/healCodexDailyEventsOnce.ts
 */
import { defaultDbPath } from "../src/config.js";
import { openDatabase } from "../src/store/open.js";
import { refreshCodexTokenUsage } from "../src/codexTokenUsage/refresh.js";

async function main() {
  const dbPath = defaultDbPath();
  console.log(`opening db: ${dbPath}`);
  const db = openDatabase(dbPath);

  const beforeEvents = (
    db.prepare("SELECT COUNT(*) AS n FROM codex_token_usage_event").get() as { n: number }
  ).n;
  console.log(`event rows before: ${beforeEvents}`);

  console.log("running refreshCodexTokenUsage({ full: true })...");
  const r = await refreshCodexTokenUsage(db, { full: true });
  console.log("refresh:", {
    status: r.status,
    indexed: r.indexedSessionCount,
    known: r.tokenKnownSessionCount,
    skipped: r.skippedUnchangedCount,
    errors: r.errors.length,
    durationMs: r.durationMs,
  });

  const afterEvents = (
    db.prepare("SELECT COUNT(*) AS n FROM codex_token_usage_event").get() as { n: number }
  ).n;
  console.log(`event rows after: ${afterEvents}`);

  // Reconciliation: per-event sums must equal the per-session totals.
  const recon = db
    .prepare(
      `SELECT
         (SELECT COALESCE(SUM(input_tokens + output_tokens), 0)
            FROM codex_token_usage_event e
            JOIN codex_session_token_usage s ON s.session_id = e.session_id
           WHERE s.token_status='full' AND s.missing_since IS NULL) AS event_total,
         (SELECT COALESCE(SUM(s2.total_tokens), 0)
            FROM codex_session_token_usage s2
           WHERE s2.token_status='full' AND s2.missing_since IS NULL) AS session_total`
    )
    .get() as { event_total: number; session_total: number };
  console.log("reconcile:", recon, "diff:", recon.event_total - recon.session_total);

  // Show the formerly-collapsed days now spread out.
  const byDay = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', e.event_at, 'localtime') AS day,
              SUM(e.input_tokens + e.output_tokens) AS tok
         FROM codex_token_usage_event e
         JOIN codex_session_token_usage s ON s.session_id = e.session_id
        WHERE s.token_status='full' AND s.missing_since IS NULL
          AND e.event_at >= '2026-06-10'
        GROUP BY day ORDER BY day DESC LIMIT 12`
    )
    .all() as Array<{ day: string; tok: number }>;
  console.log("codex tokens by event-day (since 6/10):");
  for (const r of byDay) console.log(`  ${r.day}  ${r.tok}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
