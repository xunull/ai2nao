export type DailySummaryWorkMode =
  | "implementation"
  | "debugging"
  | "exploration";

export type DailySummaryFragmentationLabel =
  | "focused"
  | "mixed"
  | "fragmented";

export type DailySummaryDegradeReason =
  | "empty_day"
  | "sparse_signal"
  | "repo_match_ambiguous"
  | "llm_unavailable"
  | "llm_timeout"
  | "llm_empty"
  | "llm_malformed"
  | "text_fact_conflict";

export type DailySummaryRepoFact = {
  repoId: number | null;
  repoLabel: string;
  matched: boolean;
  commandCount: number;
  firstTimestampNs: number;
  lastTimestampNs: number;
  sampleCommands: string[];
  blurb: string | null;
};

export type DailySummaryFragmentation = {
  label: DailySummaryFragmentationLabel;
  summary: string;
};

export type DailySummaryFacts = {
  date: string;
  totalCommands: number;
  distinctCwds: number;
  repoMatches: number;
  outsideIndexedRepos: number;
  sparse: boolean;
  recap: string;
  topRepoLabel: string | null;
  nextUpHint: string | null;
  repoFacts: DailySummaryRepoFact[];
};

export type DailySummaryMeta = {
  generatedAt: string;
  model: string | null;
  promptVersion: string;
  resolverVersion: string;
  cacheKey: string;
  fromCache: boolean;
  usedLlm: boolean;
  cacheDbPath: string;
};

export type DailySummaryPayload = {
  summary: string;
  nextUp: string | null;
  workMode: DailySummaryWorkMode | null;
  fragmentation: DailySummaryFragmentation | null;
  degraded: boolean;
  degradeReason: DailySummaryDegradeReason | null;
  facts: DailySummaryFacts;
  meta: DailySummaryMeta;
};

export type DailySummaryStatus = {
  enabled: boolean;
  modelConfigured: boolean;
  model: string | null;
  cacheDbPath: string | null;
};

