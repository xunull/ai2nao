import type Database from "better-sqlite3";
import { effectiveCorpusRoots } from "./config.js";
import { minimalRagConfig } from "./defaultConfig.js";
import { listRagFileManifests } from "./manifest.js";
import type { RagFileManifest, RagIngestActionKind } from "./manifestTypes.js";
import { sha256Hex } from "./sha256.js";
import type { RagConfigV1 } from "./types.js";
import {
  type CorpusFileEntry,
  listCorpusFiles,
  readFileLimited,
} from "./walkFiles.js";

export type RagIngestMode = {
  force?: boolean;
  repair?: boolean;
};

export type RagIngestPlanAction = {
  kind: RagIngestActionKind;
  sourceRoot: string;
  filePath: string;
  file?: CorpusFileEntry;
  manifest?: RagFileManifest;
  fileSha256?: string | null;
  reason: string;
};

export type RagIngestPlan = {
  roots: string[];
  effectiveConfig: RagConfigV1;
  actions: RagIngestPlanAction[];
  warnings: string[];
  counts: Record<RagIngestActionKind, number>;
  filesSeen: number;
};

function actionCounts(): Record<RagIngestActionKind, number> {
  return {
    skip: 0,
    index_new: 0,
    index_changed: 0,
    delete_missing: 0,
    repair: 0,
    force_rebuild: 0,
  };
}

function manifestKey(sourceRoot: string, filePath: string): string {
  return `${sourceRoot}\0${filePath}`;
}

function vectorProvider(cfg: RagConfigV1): string {
  return cfg.vectorStore?.provider ?? "none";
}

function needsRepair(manifest: RagFileManifest, cfg: RagConfigV1): boolean {
  if (manifest.status === "partial" || manifest.status === "error") return true;
  if (manifest.ftsStatus === "error" || manifest.vectorStatus === "error") return true;
  if (manifest.status === "deleted") return false;

  const provider = vectorProvider(cfg);
  if (manifest.vectorProvider && manifest.vectorProvider !== provider) return true;
  if (cfg.embedding?.enabled) {
    if (manifest.embeddingModel && manifest.embeddingModel !== cfg.embedding.model) return true;
    if (provider === "lancedb" && manifest.vectorStatus !== "indexed") return true;
  }
  return false;
}

function isFastSkip(
  file: CorpusFileEntry,
  manifest: RagFileManifest,
  cfg: RagConfigV1
): boolean {
  if (manifest.status === "deleted") return false;
  if (needsRepair(manifest, cfg)) return false;
  return manifest.mtimeMs === file.mtimeMs && manifest.sizeBytes === file.sizeBytes;
}

function pushAction(plan: RagIngestPlan, action: RagIngestPlanAction): void {
  plan.actions.push(action);
  plan.counts[action.kind]++;
}

export function buildRagIngestPlan(
  db: Database.Database,
  cfg: RagConfigV1 | null,
  cliRoots: string[],
  mode: RagIngestMode = {}
): RagIngestPlan {
  const { roots, error } = effectiveCorpusRoots(cfg, cliRoots);
  const effectiveConfig = cfg ?? minimalRagConfig(roots);
  const plan: RagIngestPlan = {
    roots,
    effectiveConfig,
    actions: [],
    warnings: error ? [error] : [],
    counts: actionCounts(),
    filesSeen: 0,
  };
  if (error || roots.length === 0) return plan;

  const extSet = new Set(effectiveConfig.includeExtensions.map((e) => e.toLowerCase()));
  const manifests = new Map<string, RagFileManifest>();
  for (const manifest of listRagFileManifests(db)) {
    manifests.set(manifestKey(manifest.sourceRoot, manifest.filePath), manifest);
  }

  const seen = new Set<string>();
  for (const root of roots) {
    const listed = listCorpusFiles(root, extSet, effectiveConfig.respectDefaultExcludes);
    plan.warnings.push(...listed.warnings);
    for (const file of listed.files) {
      plan.filesSeen++;
      const key = manifestKey(root, file.relPath);
      seen.add(key);
      const manifest = manifests.get(key);
      if (mode.force) {
        pushAction(plan, {
          kind: "force_rebuild",
          sourceRoot: root,
          filePath: file.relPath,
          file,
          manifest,
          reason: "force",
        });
        continue;
      }
      if (mode.repair) {
        if (manifest && manifest.status !== "deleted" && needsRepair(manifest, effectiveConfig)) {
          pushAction(plan, {
            kind: "repair",
            sourceRoot: root,
            filePath: file.relPath,
            file,
            manifest,
            reason: "manifest_unhealthy",
          });
        } else {
          pushAction(plan, {
            kind: "skip",
            sourceRoot: root,
            filePath: file.relPath,
            file,
            manifest,
            reason: manifest ? "repair_not_needed" : "repair_no_manifest",
          });
        }
        continue;
      }
      if (!manifest || manifest.status === "deleted") {
        pushAction(plan, {
          kind: "index_new",
          sourceRoot: root,
          filePath: file.relPath,
          file,
          manifest,
          reason: manifest?.status === "deleted" ? "previously_deleted" : "new",
        });
        continue;
      }
      if (isFastSkip(file, manifest, effectiveConfig)) {
        pushAction(plan, {
          kind: "skip",
          sourceRoot: root,
          filePath: file.relPath,
          file,
          manifest,
          reason: "stat_unchanged",
        });
        continue;
      }

      const read = readFileLimited(
        file.absPath,
        file.relPath,
        file.mtimeMs,
        effectiveConfig.maxFileBytes
      );
      if (!read.ok) {
        pushAction(plan, {
          kind: "index_changed",
          sourceRoot: root,
          filePath: file.relPath,
          file,
          manifest,
          reason: read.error,
        });
        continue;
      }
      const fileSha256 = sha256Hex(read.data.body);
      if (manifest.fileSha256 && manifest.fileSha256 === fileSha256 && !needsRepair(manifest, effectiveConfig)) {
        pushAction(plan, {
          kind: "skip",
          sourceRoot: root,
          filePath: file.relPath,
          file,
          manifest,
          fileSha256,
          reason: "hash_unchanged",
        });
        continue;
      }
      pushAction(plan, {
        kind: "index_changed",
        sourceRoot: root,
        filePath: file.relPath,
        file,
        manifest,
        fileSha256,
        reason: needsRepair(manifest, effectiveConfig) ? "config_or_status_changed" : "content_changed",
      });
    }
  }

  if (mode.repair) return plan;

  for (const manifest of manifests.values()) {
    if (manifest.status === "deleted") continue;
    if (!roots.includes(manifest.sourceRoot)) continue;
    const key = manifestKey(manifest.sourceRoot, manifest.filePath);
    if (seen.has(key)) continue;
    pushAction(plan, {
      kind: "delete_missing",
      sourceRoot: manifest.sourceRoot,
      filePath: manifest.filePath,
      manifest,
      reason: "missing_on_disk",
    });
  }

  return plan;
}
