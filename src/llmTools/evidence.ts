export type AiEvidenceSource = "local" | "web" | "session";

export type AiEvidenceItem = {
  id: string;
  source: AiEvidenceSource;
  title: string;
  url?: string;
  path?: string;
  snippet: string;
  rank: number;
  provider?: string;
  fetchedAt?: string;
  matchedBy?: string[];
};

export type AiEvidenceToolResult =
  | {
      ok: true;
      kind: "evidence";
      source: AiEvidenceSource;
      query: string;
      reason?: string;
      generatedAt: string;
      evidence: AiEvidenceItem[];
      meta: {
        provider?: string;
        cached?: boolean;
        durationMs?: number;
        diagnosticsId?: string;
        warnings?: string[];
      };
    }
  | {
      ok: false;
      kind: "evidence_error";
      source: AiEvidenceSource;
      queryHash?: string;
      code: string;
      message: string;
      recoverable: boolean;
    };
