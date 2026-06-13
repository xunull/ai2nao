/**
 * T1b spike — verify Cosmos can summarize + embed real Claude sessions through
 * the existing rag.embeddings pipeline (DashScope per current rag.json).
 *
 * Reads 5 Claude sessions from ~/.ai2nao/index.db, builds the proposed Cosmos
 * summary text (first user message + last assistant message, truncated to
 * 2K chars), calls fetchEmbeddingsBatch, prints dims + cosine similarity
 * between session 0 and the rest as a sanity check (similar sessions should
 * score higher than wildly different ones).
 *
 * If this works: T2 refresh.ts gets to assume the pipeline is reliable.
 * If this fails (auth/network/429): triggers OQ#1 — first version of Cosmos
 * falls back to token-feature PCA instead of semantic embeddings.
 *
 * Run:  npx tsx scripts/spikeCosmosEmbed.ts
 */
import { readFileSync } from "node:fs";
import { defaultDbPath } from "../src/config.js";
import { openReadOnlyDatabase } from "../src/store/open.js";
import { parseJsonlText } from "../src/localJsonl/parse.js";
import { buildClaudeSession } from "../src/claudeCodeHistory/normalize.js";
import { fetchEmbeddingsBatch, cosineSimilarity } from "../src/rag/embeddings.js";
import { readRagConfig } from "../src/rag/config.js";

type SessionMeta = {
  session_id: string;
  file_path: string;
  title: string | null;
  project_path: string;
  total_tokens: number;
};

function summarizeForCosmos(filePath: string): {
  firstUser: string;
  lastAssistant: string;
  combined: string;
} | null {
  const text = readFileSync(filePath, "utf8");
  const parsed = parseJsonlText(text);
  const { session } = buildClaudeSession({
    projectId: "spike",
    sessionId: "spike",
    parse: parsed,
    fileMtimeMs: Date.now(),
  });
  const firstUser =
    session.messages.find((m) => m.role === "user" && m.content.trim())
      ?.content.trim() ?? "";
  const lastAssistant = [...session.messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.content.trim())
    ?.content.trim() ?? "";
  if (!firstUser && !lastAssistant) return null;
  const combined = [firstUser, "---", lastAssistant]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 2048);
  return { firstUser, lastAssistant, combined };
}

async function main() {
  const cfg = readRagConfig();
  if (!cfg?.embedding?.enabled) {
    console.error("ERROR: rag.json has no enabled embedding block");
    process.exit(1);
  }
  console.log(
    `provider: ${cfg.embedding.baseURL} model=${cfg.embedding.model}`
  );

  const db = openReadOnlyDatabase(defaultDbPath());
  const sessions = db
    .prepare(
      `SELECT session_id, file_path, title, project_path, total_tokens
       FROM claude_session_token_usage
       WHERE missing_since IS NULL AND token_status = 'full'
       ORDER BY total_tokens DESC
       LIMIT 5`
    )
    .all() as SessionMeta[];
  console.log(`picked ${sessions.length} Claude sessions:`);
  sessions.forEach((s, i) =>
    console.log(
      `  [${i}] ${s.session_id}  tokens=${s.total_tokens}  title="${(s.title ?? "").slice(0, 60)}"`
    )
  );

  const summaries: string[] = [];
  const labels: string[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]!;
    const summary = summarizeForCosmos(s.file_path);
    if (!summary) {
      console.log(`  [${i}] no-summary — skipping`);
      continue;
    }
    summaries.push(summary.combined);
    labels.push(`s${i}`);
    console.log(
      `  [${i}] summary chars=${summary.combined.length}  preview="${summary.combined.slice(0, 80).replace(/\n/g, " ")}…"`
    );
  }

  if (summaries.length === 0) {
    console.error("no summarizable sessions — spike fails (degenerate input)");
    process.exit(1);
  }

  console.log(`\ncalling fetchEmbeddingsBatch on ${summaries.length} summaries...`);
  const started = Date.now();
  try {
    const vectors = await fetchEmbeddingsBatch(summaries, cfg);
    const elapsed = Date.now() - started;
    console.log(`OK in ${elapsed}ms — got ${vectors.length} vectors`);
    vectors.forEach((v, i) =>
      console.log(
        `  ${labels[i]}: dim=${v.dim} first3=[${Array.from(v.vector.slice(0, 3)).map((x) => x.toFixed(4)).join(", ")}]`
      )
    );
    if (vectors.length >= 2) {
      console.log(`\ncosine similarity matrix (sanity — Claude sessions on similar work should score > 0.5):`);
      for (let i = 0; i < vectors.length; i++) {
        const row: string[] = [];
        for (let j = 0; j < vectors.length; j++) {
          const sim = cosineSimilarity(vectors[i]!.vector, vectors[j]!.vector);
          row.push(sim.toFixed(3));
        }
        console.log(`  ${labels[i]}: [${row.join(", ")}]`);
      }
    }
    console.log("\nSPIKE OK — T2 can proceed with real DashScope pipeline.");
  } catch (e) {
    console.error(`SPIKE FAILED after ${Date.now() - started}ms`);
    console.error(e);
    console.error("\n→ OQ#1 fallback path: T2 must implement token-feature PCA.");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
