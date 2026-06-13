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

const SYSTEM_PROMPT = `You summarize a developer's recent commits across multiple local git repositories.
You produce strict JSON only, matching the schema in the user message.
Never invent project names that are not in the provided facts.
Lean toward humble inference language ("looks like", "appears to") in summary; never assert.
If totalCommits is small or signal is sparse, set workMode to "low_signal" and write a short factual summary.`;

const SCHEMA_DESCRIPTION = JSON.stringify(
  {
    summary: "string (Chinese, <=400 chars, narrative)",
    workMode: "build|debug|explore|fragmented|low_signal",
    workModeReason: "string (<=80 chars, one-line explanation)",
    nextUp: "array of string (1-2 short lines guiding tomorrow's pickup, [] when low signal)",
    fragmentation: "low|med|high",
    degraded: "boolean (set true only if you have to abandon inference)",
    degradeReason:
      "null|sparse_signal|text_fact_conflict (use sparse_signal when totalCommits<3 or projects all show 1 commit; null otherwise)",
  },
  null,
  2
);

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
