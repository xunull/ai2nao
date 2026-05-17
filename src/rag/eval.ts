import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { searchHybridDetailed } from "./retrieve.js";
import type { RagConfigV1 } from "./types.js";
import type { RagEvidenceHit } from "./evidence.js";

export type RagEvalExpected = {
  filePath?: string;
  contains?: string;
};

export type RagEvalCase = {
  id?: string;
  query: string;
  expected: RagEvalExpected[];
};

export type RagEvalCaseResult = {
  id: string;
  query: string;
  hitCount: number;
  firstRelevantRank: number | null;
  matchedFilePath: string | null;
};

export type RagEvalResult = {
  ok: true;
  caseCount: number;
  topK: number;
  recallAtK: number;
  mrr: number;
  noHit: number;
  cases: RagEvalCaseResult[];
};

export function loadRagEvalCases(path: string): RagEvalCase[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("RAG eval cases must be a JSON array");
  }
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`case #${index + 1} is not an object`);
    }
    const row = item as Record<string, unknown>;
    if (typeof row.query !== "string" || !row.query.trim()) {
      throw new Error(`case #${index + 1} query is required`);
    }
    if (!Array.isArray(row.expected) || row.expected.length === 0) {
      throw new Error(`case #${index + 1} expected is required`);
    }
    const expected = row.expected.map((raw, expectedIndex) => {
      if (!raw || typeof raw !== "object") {
        throw new Error(`case #${index + 1} expected #${expectedIndex + 1} is not an object`);
      }
      const e = raw as Record<string, unknown>;
      const filePath = typeof e.filePath === "string" && e.filePath.trim() ? e.filePath.trim() : undefined;
      const contains = typeof e.contains === "string" && e.contains.trim() ? e.contains.trim() : undefined;
      if (!filePath && !contains) {
        throw new Error(
          `case #${index + 1} expected #${expectedIndex + 1} needs filePath or contains`
        );
      }
      return {
        ...(filePath ? { filePath } : {}),
        ...(contains ? { contains } : {}),
      };
    });
    return {
      id: typeof row.id === "string" && row.id.trim() ? row.id.trim() : undefined,
      query: row.query.trim(),
      expected,
    };
  });
}

export async function runRagEval(args: {
  db: Database.Database;
  cfg: RagConfigV1 | null;
  cases: RagEvalCase[];
  topK: number;
}): Promise<RagEvalResult> {
  const topK = Math.max(1, Math.floor(args.topK));
  const caseResults: RagEvalCaseResult[] = [];
  let reciprocalRankSum = 0;
  let matchedCount = 0;
  let noHit = 0;

  for (let i = 0; i < args.cases.length; i++) {
    const testCase = args.cases[i]!;
    const result = await searchHybridDetailed(args.db, testCase.query, topK, args.cfg);
    const rank = firstRelevantRank(result.hits, testCase.expected);
    if (rank == null) {
      if (result.hits.length === 0) noHit++;
    } else {
      matchedCount++;
      reciprocalRankSum += 1 / rank;
    }
    caseResults.push({
      id: testCase.id ?? `case-${i + 1}`,
      query: testCase.query,
      hitCount: result.hits.length,
      firstRelevantRank: rank,
      matchedFilePath: rank == null ? null : result.hits[rank - 1]?.filePath ?? null,
    });
  }

  const caseCount = args.cases.length;
  return {
    ok: true,
    caseCount,
    topK,
    recallAtK: caseCount === 0 ? 0 : matchedCount / caseCount,
    mrr: caseCount === 0 ? 0 : reciprocalRankSum / caseCount,
    noHit,
    cases: caseResults,
  };
}

function firstRelevantRank(hits: RagEvidenceHit[], expected: RagEvalExpected[]): number | null {
  for (let i = 0; i < hits.length; i++) {
    if (expected.some((e) => matchesExpected(hits[i]!, e))) return i + 1;
  }
  return null;
}

function matchesExpected(hit: RagEvidenceHit, expected: RagEvalExpected): boolean {
  if (expected.filePath && hit.filePath !== expected.filePath) return false;
  if (expected.contains && !hit.content.includes(expected.contains)) return false;
  return true;
}
