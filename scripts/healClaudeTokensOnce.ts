/**
 * One-off heal: force a full Claude token-usage reparse against the live DB.
 *
 * Background: bumping CLAUDE_TOKEN_USAGE_RULE_VERSION 1→2 added prompt-cache
 * fields, but if the running scheduler ticked once between the version bump
 * and the self-heal logic landing, it wrote `state.rule_version=2` while the
 * row totals stayed at v1 (input + output only, no cache). Self-heal then
 * sees v2==v2 on subsequent ticks and skips the rebuild forever.
 *
 * This script unsticks that one-time gap without restarting the server: it
 * downgrades state.rule_version to 1 so the next refresh — which we run
 * here immediately — triggers the self-heal force-full path.
 *
 * Run:  npx tsx scripts/healClaudeTokensOnce.ts
 */
import { openDatabase } from "../src/store/open.js";
import { refreshClaudeTokenUsage } from "../src/claudeTokenUsage/refresh.js";
import { defaultDbPath } from "../src/config.js";

async function main() {
  const dbPath = defaultDbPath();
  console.log(`opening db: ${dbPath}`);
  const db = openDatabase(dbPath);

  const before = db
    .prepare("SELECT rule_version FROM claude_session_token_usage_state")
    .get() as { rule_version: number } | undefined;
  console.log(`state.rule_version before: ${before?.rule_version ?? "(no state row)"}`);

  if (before) {
    db.prepare(
      "UPDATE claude_session_token_usage_state SET rule_version = 1 WHERE id = 1"
    ).run();
    console.log("downgraded state.rule_version → 1 (forces self-heal on next refresh)");
  }

  console.log("running refreshClaudeTokenUsage (self-heal will force full=true)...");
  const result = await refreshClaudeTokenUsage(db);
  console.log("refresh result:", {
    status: result.status,
    sourceSessionCount: result.sourceSessionCount,
    indexedSessionCount: result.indexedSessionCount,
    tokenKnownSessionCount: result.tokenKnownSessionCount,
    skippedUnchangedCount: result.skippedUnchangedCount,
    errorCount: result.errors.length,
    durationMs: result.durationMs,
  });

  const after = db
    .prepare("SELECT rule_version FROM claude_session_token_usage_state")
    .get() as { rule_version: number } | undefined;
  console.log(`state.rule_version after: ${after?.rule_version}`);

  const days = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', last_updated_at, 'localtime') AS day,
              SUM(total_tokens) AS total,
              COUNT(*) AS sessions
       FROM claude_session_token_usage
       WHERE missing_since IS NULL
         AND last_updated_at >= '2026-06-08'
         AND last_updated_at <  '2026-06-13'
       GROUP BY day
       ORDER BY day`
    )
    .all();
  console.log("6/8-6/12 Claude per-day totals (post-heal):");
  console.table(days);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
