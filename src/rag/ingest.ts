import type Database from "better-sqlite3";
import { buildRagIngestPlan } from "./ingestPlan.js";
import { executeRagIngestPlan } from "./ingestExecute.js";
import type { RagIngestActionKind } from "./manifestTypes.js";
import type { RagConfigV1 } from "./types.js";

export type IngestPlanCounts = Record<RagIngestActionKind, number>;

export type IngestResult = {
  roots: number;
  filesSeen: number;
  filesIndexed: number;
  filesSkipped: number;
  filesDeleted: number;
  filesPartial: number;
  chunksInserted: number;
  errors: string[];
  plan: IngestPlanCounts;
  dryRun: boolean;
};

/** 处理每个待索引文件时回调（1-based current / total），用于终端进度。 */
export type IngestFileProgress = {
  current: number;
  total: number;
  relPath: string;
};

export type IngestCorpusOptions = {
  dryRun?: boolean;
  force?: boolean;
  repair?: boolean;
  onProgress?: (p: IngestFileProgress) => void;
};

/**
 * Index effective corpus roots into `db` incrementally.
 * @param cliRoots if non-empty, overrides config roots
 */
export async function ingestCorpus(
  db: Database.Database,
  cfg: RagConfigV1 | null,
  cliRoots: string[],
  options: IngestCorpusOptions = {}
): Promise<IngestResult> {
  const plan = buildRagIngestPlan(db, cfg, cliRoots, {
    force: options.force,
    repair: options.repair,
  });
  if (options.dryRun || plan.roots.length === 0) {
    return {
      roots: plan.roots.length,
      filesSeen: plan.filesSeen,
      filesIndexed: 0,
      filesSkipped: plan.counts.skip,
      filesDeleted: 0,
      filesPartial: 0,
      chunksInserted: 0,
      errors: [...plan.warnings],
      plan: plan.counts,
      dryRun: Boolean(options.dryRun),
    };
  }
  return executeRagIngestPlan(db, plan, { onProgress: options.onProgress });
}
