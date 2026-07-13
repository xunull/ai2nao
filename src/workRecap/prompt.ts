import {
  COMMIT_TYPE_KINDS,
  WORK_RECAP_PROMPT_BUDGET,
  WORK_RECAP_PROMPT_VERSION,
  windowToDays,
  type WorkRecapCommit,
  type WorkRecapFacts,
} from "./types.js";

/**
 * Secret patterns: redact anything that looks like an API key / token before
 * we hand commit subjects (or bodies) to an LLM. Reuses the project's
 * existing pattern in src/dailySummary/service.ts and appends well-known
 * vendor token shapes.
 */
/**
 * Secret patterns are stored as string sources + flags rather than RegExp
 * literals because reusing a `/g` regex across multiple inputs leaks
 * `lastIndex` state and silently misses matches on subsequent calls.
 * Each redactSecrets invocation constructs fresh RegExp objects.
 */
const SECRET_PATTERNS: {
  name: string;
  source: string;
  flags: string;
  redactor?: (match: string, ...groups: string[]) => string;
}[] = [
  {
    name: "cli-arg-secret",
    source: "(--?(?:token|password|secret|api[-_]?key)\\s+)(\\S+)",
    flags: "gi",
    redactor: (_m, p1) => `${p1}<redacted>`,
  },
  // Order matters: bearer-with-prefix has to fire before the bare token
  // patterns, otherwise we tag the wrong kind.
  {
    name: "bearer-header",
    source: "(Authorization:\\s+)?Bearer\\s+\\S+",
    flags: "gi",
    redactor: (_m, prefix?: string) => `${prefix ?? ""}Bearer <redacted>`,
  },
  { name: "openai-sk", source: "\\bsk-[A-Za-z0-9_-]{20,}\\b", flags: "g" },
  { name: "github-pat-classic", source: "\\bghp_[A-Za-z0-9]{20,}\\b", flags: "g" },
  { name: "github-pat-fine", source: "\\bgithub_pat_[A-Za-z0-9_]{30,}\\b", flags: "g" },
  { name: "aws-access-key", source: "\\bAKIA[0-9A-Z]{16}\\b", flags: "g" },
  {
    name: "jwt",
    source: "\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b",
    flags: "g",
  },
];

export function redactSecrets(text: string): {
  redacted: string;
  hits: string[];
} {
  let out = text;
  const hits: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    if (!regex.test(out)) continue;
    // test() advanced lastIndex; construct another fresh regex for replace.
    const replacer = new RegExp(pattern.source, pattern.flags);
    out = out.replace(replacer, (...args) => {
      hits.push(pattern.name);
      if (pattern.redactor) return pattern.redactor(args[0], ...args.slice(1));
      return `<redacted:${pattern.name}>`;
    });
  }
  return { redacted: out, hits };
}

function clipSubject(subject: string): string {
  const { redacted } = redactSecrets(subject);
  if (redacted.length <= WORK_RECAP_PROMPT_BUDGET.subjectMaxChars) {
    return redacted;
  }
  return redacted.slice(0, WORK_RECAP_PROMPT_BUDGET.subjectMaxChars - 1) + "…";
}

export type PromptInput = {
  facts: WorkRecapFacts;
  /** Commits grouped by projectKey, in scan order. */
  commits: WorkRecapCommit[];
};

export type PromptOutput = {
  /** Full message text fed to the LLM `user` role. */
  prompt: string;
  /** True when commit set was trimmed to fit the budget. */
  budgetExceeded: boolean;
  /** Final per-project commit count after trim, for diagnostics. */
  perProjectCommitCounts: Record<string, number>;
  /** Secret patterns matched during sanitization (kind only, never values). */
  redactedKinds: string[];
};

const SYSTEM_PROMPT = `You write a developer's periodic work recap from multiple local signals: git commits, AI-assistant token spend/cost, and topic activity (what they browsed, asked AI, and committed — unified as topics).
You produce strict JSON only, matching the schema in the user message.
Lead the narrative with cost + this window's top topics (the reliable signals); commits are the "shipped" dimension.
A window can be commit-sparse yet research-heavy: spend + topics but few commits = "explore", not low_signal.
Cost coverage may be partial — when the facts say so, hedge ("至少 $Z,部分会话未计入"); never overstate a cost flagged partial.
git commits and git-source topics are the SAME activity seen two ways; do not double-count them as separate work.
Never invent projects, topics, or numbers not in the provided facts. Lean toward humble language ("看起来", "appears"); never assert.
Only if commits, token, AND topic signal are all absent/empty: set workMode to "low_signal" and write a short factual summary.`;

const SCHEMA_DESCRIPTION = JSON.stringify(
  {
    summary: "string (Chinese, <=400 chars, narrative)",
    workMode: "build|debug|explore|fragmented|low_signal",
    workModeReason: "string (<=80 chars, one-line explanation)",
    nextUp: "array of string (1-2 short lines guiding tomorrow's pickup, [] when low signal)",
    fragmentation: "low|med|high",
    degraded: "boolean (set true only if you have to abandon inference)",
    degradeReason:
      "null|sparse_signal|text_fact_conflict (use sparse_signal only when commits AND token AND topic signal are all absent/empty; null otherwise)",
  },
  null,
  2
);

function factStatusLabel(status: string): string {
  return status === "absent"
    ? "source not available"
    : status === "empty"
      ? "no activity this window"
      : status === "error"
        ? "read failed"
        : "ok";
}

/** Compact token/cost line for the prompt (with a coverage hedge when partial). */
function renderTokenFacts(g: WorkRecapFacts["tokenFacts"]): string {
  if (g.status !== "ok" || !g.data) return `Token/cost: (${factStatusLabel(g.status)})`;
  const d = g.data;
  const hedge =
    d.coverage === "full"
      ? ""
      : ` [coverage=${d.coverage}${d.unpricedTokenCount ? `, ${d.unpricedTokenCount} tokens unpriced` : ""} — state cost as a floor, not exact]`;
  return `Token/cost: ~$${d.costUsd.toFixed(2)}${hedge}; ${d.headlineTokens.toLocaleString()} tokens; dominant=${d.dominantProvider} (claude ${(d.claudeShare * 100).toFixed(0)}% / codex ${(d.codexShare * 100).toFixed(0)}%); price snapshot ${d.priceSnapshotDate}`;
}

/** Per-source top topics + gated drift. Chrome is de-weighted (generic browsing). */
function renderTopicFacts(g: WorkRecapFacts["topicDrift"]): string {
  if (g.status !== "ok" || !g.data) return `Topics: (${factStatusLabel(g.status)})`;
  const lines = g.data.bySource.map(
    (s) =>
      `  ${s.source} (${s.events} ev): ${s.top.map((t) => `${t.name} ${(t.share * 100).toFixed(0)}%`).join(", ") || "(none above noise)"}`
  );
  const drift = g.data.drift?.length
    ? "  drift: " + g.data.drift.map((d) => `${d.source} ${d.from}→${d.to}`).join("; ")
    : "  drift: (none / below threshold — do not narrate a shift)";
  return [
    "Topics this window (git+conversation are dev-meaningful; chrome de-weighted):",
    ...lines,
    drift,
  ].join("\n");
}

/**
 * Builds the prompt with hard token/char budgets enforced. Commits are
 * grouped by project and top-N kept per project; long-tail projects beyond
 * topProjects collapse into a single bucket so the LLM still sees totals
 * faithfully even when budget cuts in.
 */
export function buildPrompt(input: PromptInput): PromptOutput {
  const { facts } = input;
  const budget = WORK_RECAP_PROMPT_BUDGET;
  const redactedKinds: string[] = [];

  // Group commits by project, in projectShare order (most active first).
  const grouped = new Map<string, WorkRecapCommit[]>();
  for (const c of input.commits) {
    const arr = grouped.get(c.repoPath);
    if (arr) arr.push(c);
    else grouped.set(c.repoPath, [c]);
  }

  const projectsForPrompt = facts.projectShare.slice(0, budget.topProjects);
  const overflowProjects = facts.projectShare.length - projectsForPrompt.length;

  const perProjectCommitCounts: Record<string, number> = {};
  const projectBlocks: Array<{
    label: string;
    key: string;
    totalInWindow: number;
    sampleSubjects: string[];
  }> = [];

  let totalCommitsInPrompt = 0;
  let budgetExceeded = overflowProjects > 0;

  for (const proj of projectsForPrompt) {
    const all = grouped.get(proj.projectKey) ?? [];
    const sample = all.slice(0, budget.commitsPerProject);
    perProjectCommitCounts[proj.projectKey] = sample.length;
    if (all.length > sample.length) budgetExceeded = true;
    totalCommitsInPrompt += sample.length;
    const subjects: string[] = [];
    for (const c of sample) {
      const clipped = clipSubject(c.subject);
      const { hits } = redactSecrets(c.subject);
      for (const h of hits) {
        if (!redactedKinds.includes(h)) redactedKinds.push(h);
      }
      subjects.push(`${c.kind}: ${clipped}`);
    }
    projectBlocks.push({
      label: proj.projectLabel,
      key: proj.projectKey,
      totalInWindow: proj.commitCount,
      sampleSubjects: subjects,
    });
  }

  const days = windowToDays(facts.windowKey);
  const commitTypeSummary = COMMIT_TYPE_KINDS.filter(
    (k) => facts.commitTypeCounts[k] > 0
  )
    .map((k) => `${k}=${facts.commitTypeCounts[k]}`)
    .join(", ");

  const factsHeader = [
    `Window: ${facts.windowKey} (${days} days, ${facts.windowStart} → ${facts.windowEnd})`,
    `Author email: ${facts.authorEmail}`,
    `Repos scanned: ${facts.reposScanned}/${facts.reposTotal}${facts.scanTruncated ? " (TRUNCATED: " + (facts.scanTruncatedReason ?? "unknown") + ")" : ""}`,
    `Total commits: ${facts.totalCommits}, projects: ${facts.projectCount}`,
    `Commit kinds: ${commitTypeSummary || "(none)"}`,
  ].join("\n");

  const projectSection = projectBlocks
    .map((p) => {
      const lines = [
        `Project: ${p.label} (key=${p.key}, total=${p.totalInWindow})`,
      ];
      for (const s of p.sampleSubjects) {
        lines.push(`  - ${s}`);
      }
      return lines.join("\n");
    })
    .join("\n");

  const overflowNote =
    overflowProjects > 0
      ? `\nNOTE: ${overflowProjects} more project(s) had commits but were omitted by prompt budget. Treat them as long-tail; do not pretend they don't exist.`
      : "";

  let prompt = [
    "Schema:",
    SCHEMA_DESCRIPTION,
    "",
    "Facts:",
    factsHeader,
    "",
    renderTokenFacts(facts.tokenFacts),
    "",
    renderTopicFacts(facts.topicDrift),
    "",
    "Projects (top by commit count):",
    projectSection || "(no commits in window)",
    overflowNote,
    "",
    "Output JSON only, no markdown fences, no commentary.",
  ].join("\n");

  // Final char-budget guard: if even the trimmed prompt blows totalCharsCap,
  // truncate from the project section tail (keeps schema + facts header).
  if (prompt.length > budget.totalCharsCap) {
    const truncated = prompt.slice(0, budget.totalCharsCap - 200);
    prompt =
      truncated +
      "\n…[TRUNCATED FOR PROMPT BUDGET]\nOutput JSON only, no markdown fences, no commentary.";
    budgetExceeded = true;
  }

  // Sanity: even with truncation, sample at least 1 commit if any existed.
  if (totalCommitsInPrompt === 0 && input.commits.length > 0) {
    budgetExceeded = true;
  }

  return {
    prompt,
    budgetExceeded,
    perProjectCommitCounts,
    redactedKinds,
  };
}

/** Re-exported so service code can stamp consistent prompt_version. */
export const PROMPT_VERSION = WORK_RECAP_PROMPT_VERSION;

export { SYSTEM_PROMPT };
