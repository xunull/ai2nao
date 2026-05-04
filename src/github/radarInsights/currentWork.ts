import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { RadarInsightWarning } from "./types.js";

export type CurrentWorkSourceKind = "todo" | "doc" | "git_commit" | "branch";

export type CurrentWorkSource = {
  source_kind: CurrentWorkSourceKind;
  label: string;
  source_path: string | null;
  content: string;
  terms: string[];
  hash: string;
};

export type CurrentWorkScanResult = {
  sources: CurrentWorkSource[];
  warnings: RadarInsightWarning[];
  git_context_hash: string | null;
};

export type CurrentWorkScanArgs = {
  cwd?: string;
};

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "have",
  "has",
  "not",
  "are",
  "was",
  "were",
  "todo",
  "docs",
  "feat",
  "fix",
  "chore",
  "test",
  "src",
  "api",
  "ui",
]);

export function scanCurrentGitContext(args: CurrentWorkScanArgs = {}): CurrentWorkScanResult {
  const cwd = args.cwd ?? process.cwd();
  const warnings: RadarInsightWarning[] = [];
  const sources: CurrentWorkSource[] = [];
  let gitContextHash: string | null = null;

  const gitParts: string[] = [];
  try {
    const branch = execGit(cwd, ["branch", "--show-current"]).trim();
    if (branch) {
      gitParts.push(`branch:${branch}`);
      sources.push(source("branch", `branch: ${branch}`, null, branch));
    }
    const log = execGit(cwd, ["log", "--oneline", "-30"]);
    gitParts.push(log);
    for (const line of log.split("\n").filter(Boolean).slice(0, 30)) {
      sources.push(source("git_commit", `commit: ${safeCommit(line)}`, null, line));
    }
  } catch {
    warnings.push({
      code: "git_log_failed",
      message: "git context could not be read; current-work evidence is partial.",
    });
  }
  gitContextHash = gitParts.length > 0 ? sha1(gitParts.join("\n")) : null;

  return {
    sources,
    warnings,
    git_context_hash: gitContextHash,
  };
}

export function extractTerms(content: string, limit = 40): string[] {
  const matches = content
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}._/-]{2,}/gu);
  if (!matches) return [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const t = sanitizeTerm(raw);
    if (!t || STOPWORDS.has(t) || /^\d+$/.test(t)) continue;
    seen.add(t);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

export function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

export function source(
  source_kind: CurrentWorkSourceKind,
  label: string,
  source_path: string | null,
  content: string
): CurrentWorkSource {
  return {
    source_kind,
    label,
    source_path,
    content,
    terms: extractTerms(content),
    hash: sha1(content),
  };
}

function execGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function safeCommit(line: string): string {
  return line.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120);
}

function sanitizeTerm(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 48);
}
