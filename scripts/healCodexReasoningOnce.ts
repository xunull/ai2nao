/**
 * One-off: force a full Codex token reparse with the v2 parser (output no
 * longer double-counts reasoning_output_tokens).
 *
 * The self-heal at the refresh entry only fires when stored rule_version !=
 * CODEX_TOKEN_USAGE_RULE_VERSION. If a partial hot-reload already stamped the
 * state at v2 while rows still hold v1 (buggy, inflated) output, self-heal
 * sees v2==v2 and skips forever. This script forces full=true directly.
 *
 * Run:  npx tsx scripts/healCodexReasoningOnce.ts
 */
import { defaultDbPath } from "../src/config.js";
import { openDatabase } from "../src/store/open.js";
import { refreshCodexTokenUsage } from "../src/codexTokenUsage/refresh.js";

async function main() {
  const dbPath = defaultDbPath();
  console.log(`opening db: ${dbPath}`);
  const db = openDatabase(dbPath);

  const before = db
    .prepare(
      `SELECT SUM(output_tokens) AS out, SUM(total_tokens) AS total
       FROM codex_session_token_usage
       WHERE token_status='full' AND missing_since IS NULL`
    )
    .get() as { out: number; total: number };
  console.log("before:", before);

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

  const after = db
    .prepare(
      `SELECT SUM(output_tokens) AS out, SUM(total_tokens) AS total
       FROM codex_session_token_usage
       WHERE token_status='full' AND missing_since IS NULL`
    )
    .get() as { out: number; total: number };
  console.log("after:", after);
  const drop = before.out > 0 ? (100 * (before.out - after.out)) / before.out : 0;
  console.log(`output dropped ${drop.toFixed(1)}% (expected ~22.6% if reasoning was being double-counted)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
