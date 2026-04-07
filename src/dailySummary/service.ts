import { createHash } from "node:crypto";
import { basename } from "node:path";
import type Database from "better-sqlite3";
import type { AtuinEntry } from "../atuin/queries.js";
import { DEFAULT_MANIFEST_RELS } from "../config.js";
import { canonicalizePath } from "../path/canonical.js";
import {
  getManifestByRepoAndRelPath,
  listRepoMatches,
} from "../read/queries.js";
import { getStatusSummary } from "../store/operations.js";
import { getCachedDailySummary, putCachedDailySummary } from "./cache.js";
import {
  DailySummaryLlmError,
  type DailySummaryLlmConfig,
  generateDailySummaryText,
} from "./llm.js";
import type {
  DailySummaryDegradeReason,
  DailySummaryFacts,
  DailySummaryFragmentation,
  DailySummaryPayload,
  DailySummaryRepoFact,
  DailySummaryStatus,
} from "./types.js";

const PROMPT_VERSION = "2026-04-07.1";
const RESOLVER_VERSION = "2026-04-07.1";
const TOP_REPO_LIMIT = 3;
const COMMAND_SAMPLE_LIMIT = 3;
const COMMAND_PREVIEW_LIMIT = 120;
const BLURB_LIMIT = 240;
const SPARSE_DAY_THRESHOLD = 3;

type RepoMatch = {
  id: number;
  pathCanonical: string;
  label: string;
};

type DailySummaryRuntimeOptions = {
  enabled: boolean;
  cacheDbPath: string | null;
  llm: DailySummaryLlmConfig;
};

type DailySummaryServiceOptions = {
  indexDb: Database.Database;
  atuinEntries: AtuinEntry[];
  cacheDb: Database.Database | null;
  runtime: DailySummaryRuntimeOptions;
};

type RepoBucket = {
  repoId: number | null;
  repoLabel: string;
  matched: boolean;
  entries: AtuinEntry[];
  blurb: string | null;
};

export type GenerateDailySummaryInput = {
  date: string;
  refresh?: boolean;
};

function compressCommand(command: string): string {
  const scrubbed = command
    .replace(
      /(--?(?:token|password|secret|api[-_]?key)\s+)(\S+)/gi,
      "$1[REDACTED]"
    )
    .replace(/([A-Za-z_][A-Za-z0-9_]*=)([^\s]+)/g, "$1[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return scrubbed.length > COMMAND_PREVIEW_LIMIT
    ? `${scrubbed.slice(0, COMMAND_PREVIEW_LIMIT - 1)}…`
    : scrubbed;
}

function repoLabelFromPath(pathCanonical: string): string {
  return basename(pathCanonical) || pathCanonical;
}

function isRepoPathPrefix(repoPath: string, cwd: string): boolean {
  return cwd === repoPath || cwd.startsWith(`${repoPath}/`);
}

function bestManifestBlurb(
  indexDb: Database.Database,
  repoId: number
): string | null {
  for (const rel of DEFAULT_MANIFEST_RELS) {
    const manifest = getManifestByRepoAndRelPath(indexDb, repoId, rel);
    if (!manifest) continue;
    const body = manifest.body.trim();
    if (!body) continue;

    if (rel === "package.json") {
      try {
        const parsed = JSON.parse(body) as {
          name?: string;
          description?: string;
        };
        const jsonBlurb = [parsed.name, parsed.description]
          .filter((part): part is string => !!part && !!part.trim())
          .join(" - ");
        if (jsonBlurb) {
          return jsonBlurb.slice(0, BLURB_LIMIT);
        }
      } catch {
        // Fall back to plain text below.
      }
    }

    const compact = body.replace(/\s+/g, " ").trim();
    return compact.length > BLURB_LIMIT
      ? `${compact.slice(0, BLURB_LIMIT - 1)}…`
      : compact;
  }
  return null;
}

function computeDaySignature(entries: AtuinEntry[]): string {
  const hash = createHash("sha1");
  for (const entry of entries) {
    hash
      .update(entry.id)
      .update("|")
      .update(String(entry.timestamp_ns))
      .update("|")
      .update(entry.cwd)
      .update("|")
      .update(entry.command)
      .update("|")
      .update(String(entry.exit))
      .update("\n");
  }
  return hash.digest("hex");
}

function buildCacheKey(
  date: string,
  entries: AtuinEntry[],
  indexDb: Database.Database,
  runtime: DailySummaryRuntimeOptions
): string {
  const status = getStatusSummary(indexDb);
  const statusFingerprint = [
    status.repos,
    status.manifests,
    status.lastJob?.id ?? 0,
    status.lastJob?.status ?? "none",
  ].join(":");
  const daySignature = computeDaySignature(entries);
  return createHash("sha1")
    .update(
      JSON.stringify({
        date,
        model: runtime.llm.model,
        promptVersion: PROMPT_VERSION,
        resolverVersion: RESOLVER_VERSION,
        statusFingerprint,
        daySignature,
      })
    )
    .digest("hex");
}

function resolveRepoBuckets(
  indexDb: Database.Database,
  entries: AtuinEntry[]
): RepoBucket[] {
  const repoMatches: RepoMatch[] = listRepoMatches(indexDb).map((repo) => ({
    id: repo.id,
    pathCanonical: repo.path_canonical,
    label: repoLabelFromPath(repo.path_canonical),
  }));
  const cwdMatches = new Map<string, RepoMatch | null>();

  for (const cwd of new Set(entries.map((entry) => entry.cwd))) {
    const canonical = canonicalizePath(cwd, { bestEffort: true });
    if (!canonical) {
      cwdMatches.set(cwd, null);
      continue;
    }
    const repo =
      repoMatches.find((candidate) =>
        isRepoPathPrefix(candidate.pathCanonical, canonical)
      ) ?? null;
    cwdMatches.set(cwd, repo);
  }

  const buckets = new Map<string, RepoBucket>();
  for (const entry of entries) {
    const repo = cwdMatches.get(entry.cwd) ?? null;
    const key = repo ? `repo:${repo.id}` : "repo:none";
    const existing = buckets.get(key);
    if (existing) {
      existing.entries.push(entry);
      continue;
    }
    buckets.set(key, {
      repoId: repo?.id ?? null,
      repoLabel: repo?.label ?? "outside indexed repos",
      matched: !!repo,
      entries: [entry],
      blurb: null,
    });
  }

  return [...buckets.values()].sort(
    (a, b) => b.entries.length - a.entries.length
  );
}

function attachRepoBlurbs(
  indexDb: Database.Database,
  buckets: RepoBucket[]
): RepoBucket[] {
  for (const bucket of buckets.slice(0, TOP_REPO_LIMIT)) {
    if (!bucket.repoId) continue;
    bucket.blurb = bestManifestBlurb(indexDb, bucket.repoId);
  }
  return buckets;
}

function buildFragmentation(repoFacts: DailySummaryRepoFact[], sparse: boolean): DailySummaryFragmentation | null {
  if (sparse || repoFacts.length === 0) return null;
  const total = repoFacts.reduce((sum, repo) => sum + repo.commandCount, 0);
  const topShare = total > 0 ? repoFacts[0].commandCount / total : 0;

  if (repoFacts.length <= 1 || topShare >= 0.75) {
    return {
      label: "focused",
      summary: "Most command activity stayed concentrated in one work area.",
    };
  }
  if (repoFacts.length >= 4 && topShare < 0.55) {
    return {
      label: "fragmented",
      summary: "The day bounced across several work areas instead of staying focused.",
    };
  }
  return {
    label: "mixed",
    summary: "The day mixed a primary thread with a noticeable amount of switching.",
  };
}

function buildFacts(date: string, buckets: RepoBucket[], entries: AtuinEntry[]): DailySummaryFacts {
  const sparse = entries.length > 0 && entries.length < SPARSE_DAY_THRESHOLD;
  const repoFacts: DailySummaryRepoFact[] = buckets.slice(0, TOP_REPO_LIMIT).map((bucket) => {
    const ordered = [...bucket.entries].sort(
      (a, b) => a.timestamp_ns - b.timestamp_ns
    );
    const sampleCommands = [...new Set(ordered.map((entry) => compressCommand(entry.command)))].slice(
      0,
      COMMAND_SAMPLE_LIMIT
    );
    return {
      repoId: bucket.repoId,
      repoLabel: bucket.repoLabel,
      matched: bucket.matched,
      commandCount: ordered.length,
      firstTimestampNs: ordered[0]?.timestamp_ns ?? 0,
      lastTimestampNs: ordered[ordered.length - 1]?.timestamp_ns ?? 0,
      sampleCommands,
      blurb: bucket.blurb,
    };
  });

  const topRepo = repoFacts[0] ?? null;
  const outsideIndexedRepos = buckets
    .filter((bucket) => !bucket.matched)
    .reduce((sum, bucket) => sum + bucket.entries.length, 0);

  let recap = "No significant activity detected.";
  if (entries.length > 0 && topRepo) {
    recap = `Observed ${entries.length} shell commands. Main focus appears to be ${topRepo.repoLabel}.`;
  } else if (entries.length > 0) {
    recap = `Observed ${entries.length} shell commands, but none matched an indexed repo with confidence.`;
  }

  if (sparse && entries.length > 0) {
    recap = `Observed ${entries.length} shell commands. Signal is sparse, so this is a factual recap instead of a confident narrative.`;
  }

  return {
    date,
    totalCommands: entries.length,
    distinctCwds: new Set(entries.map((entry) => entry.cwd)).size,
    repoMatches: entries.length - outsideIndexedRepos,
    outsideIndexedRepos,
    sparse,
    recap,
    topRepoLabel: topRepo?.repoLabel ?? null,
    nextUpHint:
      !sparse && topRepo
        ? `Likely continue in ${topRepo.repoLabel}.`
        : null,
    repoFacts,
  };
}

function withMeta(
  payload: DailySummaryPayload,
  options: {
    cacheKey: string;
    cacheDbPath: string;
    fromCache: boolean;
    usedLlm: boolean;
    model: string | null;
  }
): DailySummaryPayload {
  return {
    ...payload,
    meta: {
      ...payload.meta,
      cacheKey: options.cacheKey,
      cacheDbPath: options.cacheDbPath,
      fromCache: options.fromCache,
      usedLlm: options.usedLlm,
      model: options.model,
    },
  };
}

function fallbackPayload(
  facts: DailySummaryFacts,
  fragmentation: DailySummaryFragmentation | null,
  cacheKey: string,
  cacheDbPath: string,
  model: string | null,
  degradeReason: DailySummaryDegradeReason | null
): DailySummaryPayload {
  return {
    summary: facts.recap,
    nextUp: null,
    workMode: null,
    fragmentation,
    degraded: degradeReason !== null,
    degradeReason,
    facts,
    meta: {
      generatedAt: new Date().toISOString(),
      model,
      promptVersion: PROMPT_VERSION,
      resolverVersion: RESOLVER_VERSION,
      cacheKey,
      fromCache: false,
      usedLlm: false,
      cacheDbPath,
    },
  };
}

export function getDailySummaryStatus(
  runtime: DailySummaryRuntimeOptions
): DailySummaryStatus {
  return {
    enabled: runtime.enabled,
    modelConfigured: !!runtime.llm.baseUrl && !!runtime.llm.model,
    model: runtime.llm.model,
    cacheDbPath: runtime.cacheDbPath,
  };
}

export async function generateDailySummary(
  opts: DailySummaryServiceOptions & GenerateDailySummaryInput
): Promise<DailySummaryPayload> {
  const cacheDbPath = opts.runtime.cacheDbPath ?? "";
  const cacheKey = buildCacheKey(
    opts.date,
    opts.atuinEntries,
    opts.indexDb,
    opts.runtime
  );

  if (!opts.refresh && opts.cacheDb) {
    const cached = getCachedDailySummary(opts.cacheDb, cacheKey);
    if (cached) {
      return withMeta(cached, {
        cacheKey,
        cacheDbPath,
        fromCache: true,
        usedLlm: cached.meta.usedLlm,
        model: cached.meta.model,
      });
    }
  }

  const buckets = attachRepoBlurbs(
    opts.indexDb,
    resolveRepoBuckets(opts.indexDb, opts.atuinEntries)
  );
  const facts = buildFacts(opts.date, buckets, opts.atuinEntries);
  const fragmentation = buildFragmentation(facts.repoFacts, facts.sparse);

  let payload = fallbackPayload(
    facts,
    fragmentation,
    cacheKey,
    cacheDbPath,
    opts.runtime.llm.model,
    opts.atuinEntries.length === 0
      ? "empty_day"
      : facts.sparse
        ? "sparse_signal"
        : null
  );

  if (opts.atuinEntries.length > 0 && !facts.sparse) {
    try {
      const llm = await generateDailySummaryText(
        opts.date,
        facts,
        opts.runtime.llm
      );
      if (
        llm.primaryRepoLabel &&
        facts.topRepoLabel &&
        llm.primaryRepoLabel.toLowerCase() !== facts.topRepoLabel.toLowerCase()
      ) {
        throw new DailySummaryLlmError(
          "text_fact_conflict",
          "LLM primary repo conflicts with deterministic facts"
        );
      }

      payload = {
        summary: llm.summary,
        nextUp: llm.nextUp ?? facts.nextUpHint,
        workMode: llm.workMode,
        fragmentation,
        degraded: false,
        degradeReason: null,
        facts,
        meta: {
          generatedAt: new Date().toISOString(),
          model: opts.runtime.llm.model,
          promptVersion: PROMPT_VERSION,
          resolverVersion: RESOLVER_VERSION,
          cacheKey,
          fromCache: false,
          usedLlm: true,
          cacheDbPath,
        },
      };
    } catch (error) {
      const reason =
        error instanceof DailySummaryLlmError
          ? error.reason
          : "llm_unavailable";
      payload = fallbackPayload(
        facts,
        fragmentation,
        cacheKey,
        cacheDbPath,
        opts.runtime.llm.model,
        reason
      );
    }
  }

  if (opts.cacheDb) {
    try {
      putCachedDailySummary(opts.cacheDb, opts.date, cacheKey, payload);
    } catch {
      // Cache is a sidecar optimization. A write failure should not hide
      // the summary we just generated for the user.
    }
  }

  return payload;
}

export type { DailySummaryRuntimeOptions };

