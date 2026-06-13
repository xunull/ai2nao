import { describe, expect, it } from "vitest";
import { buildPrompt, redactSecrets } from "../src/workRecap/prompt.js";
import { computeFacts } from "../src/workRecap/facts.js";
import {
  WORK_RECAP_PROMPT_BUDGET,
  type WorkRecapCommit,
} from "../src/workRecap/types.js";

function commit(
  repoPath: string,
  repoLabel: string,
  sha: string,
  subject: string,
  kind: WorkRecapCommit["kind"] = "feat"
): WorkRecapCommit {
  return {
    repoPath,
    repoLabel,
    sha,
    authorEmail: "me@example.com",
    authorName: "Me",
    committedAt: new Date("2026-06-02T10:00:00Z"),
    subject,
    kind,
  };
}

const WINDOW_START = new Date("2026-06-01T00:00:00Z");
const WINDOW_END = new Date("2026-06-08T00:00:00Z");

function factsFor(commits: WorkRecapCommit[]) {
  return computeFacts({
    commits,
    windowKey: "7d",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    authorEmail: "me@example.com",
    reposScanned: new Set(commits.map((c) => c.repoPath)).size,
    reposTotal: new Set(commits.map((c) => c.repoPath)).size,
    scanTruncated: false,
    scanTruncatedReason: null,
    scanDiagnostics: [],
  });
}

describe("redactSecrets", () => {
  it("redacts well-known secret shapes", () => {
    const cases = [
      "sk-abcdef1234567890abcdef1234567890",
      "ghp_aaaaaaaaaaaaaaaaaaaa1234",
      "AKIAABCDEFGHIJKLMNOP",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signaturepartXYZ",
    ];
    for (const c of cases) {
      const { redacted, hits } = redactSecrets(`commit: leaks ${c}`);
      expect(redacted).not.toContain(c);
      expect(hits.length).toBeGreaterThan(0);
    }
  });

  it("redacts --token style CLI args", () => {
    const { redacted, hits } = redactSecrets("feat: ai2nao --token secret123");
    expect(redacted).not.toContain("secret123");
    expect(hits).toContain("cli-arg-secret");
  });

  it("redacts Bearer authorization headers", () => {
    const { redacted, hits } = redactSecrets(
      "debug: curl -H 'Authorization: Bearer xyz123abc456'"
    );
    expect(redacted).not.toContain("xyz123abc456");
    expect(hits).toContain("bearer-header");
  });

  it("returns input unchanged when no secret present", () => {
    const { redacted, hits } = redactSecrets("feat: add login page");
    expect(redacted).toBe("feat: add login page");
    expect(hits).toHaveLength(0);
  });
});

describe("buildPrompt", () => {
  it("includes facts header, schema, and projects", () => {
    const commits = [
      commit("/a", "alpha", "s1", "feat: a"),
      commit("/a", "alpha", "s2", "fix: b", "fix"),
      commit("/b", "bravo", "s3", "docs: c", "docs"),
    ];
    const facts = factsFor(commits);
    const out = buildPrompt({ facts, commits });
    expect(out.prompt).toContain("Schema:");
    expect(out.prompt).toContain("Facts:");
    expect(out.prompt).toContain("Total commits: 3");
    expect(out.prompt).toContain("alpha");
    expect(out.prompt).toContain("bravo");
    expect(out.prompt).toContain("feat: a");
    expect(out.budgetExceeded).toBe(false);
  });

  it("F6 T-B2: marks budgetExceeded when project count overflows topProjects", () => {
    const projectsBeyondBudget = WORK_RECAP_PROMPT_BUDGET.topProjects + 3;
    const commits: WorkRecapCommit[] = [];
    for (let i = 0; i < projectsBeyondBudget; i++) {
      commits.push(commit(`/p${i}`, `p${i}`, `s${i}`, `feat: in p${i}`));
    }
    const facts = factsFor(commits);
    const out = buildPrompt({ facts, commits });
    expect(out.budgetExceeded).toBe(true);
    expect(out.prompt).toContain("project(s) had commits but were omitted");
  });

  it("F6 T-B2: marks budgetExceeded when a single project has more commits than per-project sample", () => {
    const commitsInOne = WORK_RECAP_PROMPT_BUDGET.commitsPerProject + 5;
    const commits: WorkRecapCommit[] = [];
    for (let i = 0; i < commitsInOne; i++) {
      commits.push(commit("/a", "alpha", `s${i}`, `feat: c${i}`));
    }
    const facts = factsFor(commits);
    const out = buildPrompt({ facts, commits });
    expect(out.budgetExceeded).toBe(true);
    const perProj = out.perProjectCommitCounts["/a"];
    expect(perProj).toBe(WORK_RECAP_PROMPT_BUDGET.commitsPerProject);
  });

  it("redacts secrets inside subjects when building the prompt", () => {
    const commits = [
      commit("/a", "alpha", "s1", "feat: deploy ghp_1234567890abcdef1234"),
    ];
    const facts = factsFor(commits);
    const out = buildPrompt({ facts, commits });
    expect(out.prompt).not.toContain("ghp_1234567890abcdef1234");
    expect(out.redactedKinds).toContain("github-pat-classic");
  });

  it("clips a long subject to the per-subject char cap", () => {
    const longSubject = "feat: " + "x".repeat(500);
    const commits = [commit("/a", "alpha", "s1", longSubject)];
    const facts = factsFor(commits);
    const out = buildPrompt({ facts, commits });
    // Each subject must be <= subjectMaxChars + ellipsis
    expect(out.prompt).toMatch(/x{20,}…/);
    expect(out.prompt).not.toContain("x".repeat(200));
  });
});
