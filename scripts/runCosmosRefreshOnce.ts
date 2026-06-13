/**
 * Day 1 end-to-end: run refreshCosmos against the real ~/.ai2nao/index.db.
 *
 * This is the moment of truth — Day 1 step 5 from the design doc. Pulls all
 * 201 Claude + Codex sessions, summarizes each (with boilerplate stripped),
 * embeds via DashScope, writes vectors into work_cosmos_embeddings.
 *
 * No projection yet (that's Day 2). After this script, the DB should have:
 *   - ~201 rows in work_cosmos_points with embedding_status='ok' or
 *     'no_summary'
 *   - ~150-180 rows in work_cosmos_embeddings (whatever survived after
 *     stripping pure-boilerplate sessions)
 *   - 1 row in work_cosmos_state with embedded_session_count > 0
 *
 * Run:  npx tsx scripts/runCosmosRefreshOnce.ts
 *
 * Cost: ~60s and a small DashScope quota nibble on first run; subsequent
 * runs skip unchanged sessions via (mtime, size) and cost nothing.
 */
import { defaultDbPath } from "../src/config.js";
import { openDatabase } from "../src/store/open.js";
import { refreshCosmos } from "../src/workCosmos/refresh.js";

async function main() {
  const dbPath = defaultDbPath();
  console.log(`opening db: ${dbPath}`);
  const db = openDatabase(dbPath);

  const sources = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM claude_session_token_usage WHERE missing_since IS NULL) AS claude,
         (SELECT COUNT(*) FROM codex_session_token_usage WHERE missing_since IS NULL) AS codex`
    )
    .get() as { claude: number; codex: number };
  console.log(
    `source: claude=${sources.claude} codex=${sources.codex} total=${sources.claude + sources.codex}`
  );

  const fullArg = process.argv.includes("--full");
  console.log(
    `running refreshCosmos({ full: ${fullArg} }) (hits DashScope; ~60s expected on first run)...`
  );
  const result = await refreshCosmos(db, { full: fullArg });
  console.log("result:", {
    status: result.status,
    source: result.sourceSessionCount,
    indexed: result.indexedSessionCount,
    embedded: result.embeddedSessionCount,
    no_summary: result.noSummarySessionCount,
    errors: result.errorSessionCount,
    skipped: result.skippedUnchangedCount,
    duration_ms: result.durationMs,
    first_error: result.errors[0] ?? null,
  });

  const breakdown = db
    .prepare(
      `SELECT embedding_status, COUNT(*) AS n
       FROM work_cosmos_points
       WHERE missing_since IS NULL
       GROUP BY embedding_status
       ORDER BY n DESC`
    )
    .all();
  console.log("\npoint status breakdown:");
  console.table(breakdown);

  const sample = db
    .prepare(
      `SELECT p.session_id, p.source, p.total_tokens, e.embedding_dim,
              LENGTH(e.vector) AS bytes,
              SUBSTR(e.summary, 1, 60) AS summary_preview
       FROM work_cosmos_points p
       JOIN work_cosmos_embeddings e ON e.session_id = p.session_id
       WHERE p.missing_since IS NULL AND p.embedding_status = 'ok'
       ORDER BY p.total_tokens DESC
       LIMIT 5`
    )
    .all();
  console.log("\ntop-5 embedded sessions:");
  console.table(sample);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
