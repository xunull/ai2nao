import { sha1 } from "./currentWork.js";
import type { RadarCandidateRepo } from "./evidence.js";
import { evidenceTerms, hasCurrentWorkEvidence } from "./evidence.js";
import type {
  RadarInsight,
  RadarInsightEvidence,
  RadarInsightFeedback,
  RadarInsightHealth,
} from "./types.js";

export type FeedbackRow = {
  target_type: "insight" | "repo";
  target_id: string;
  feedback: RadarInsightFeedback;
  insight_fingerprint: string | null;
  repo_id: number | null;
  terms: string[];
  expires_at: string | null;
};

export function insightFromRepo(
  kind: "recommended_now" | "rediscovered" | "retire_candidate",
  repo: RadarCandidateRepo,
  evidence: RadarInsightEvidence[],
  warningsCount: number,
  now: Date
): RadarInsight {
  const terms = evidenceTerms(evidence);
  const currentWork = hasCurrentWorkEvidence(evidence);
  const baseScore = evidence.reduce((sum, e) => sum + e.weight + e.matched_terms.length, 0);
  const activeBonus = repo.pushed_at && daysBetween(repo.pushed_at, now) <= 120 ? 8 : 0;
  const starBonus = Math.min(8, Math.floor(Math.log10(Math.max(1, repo.stargazers_count))));
  const health = healthFor(kind, evidence, warningsCount, currentWork);
  const title =
    kind === "recommended_now"
      ? `${repo.full_name} 可能和当前工作有关`
      : kind === "rediscovered"
        ? `${repo.full_name} 这个旧收藏重新活跃了`
        : `${repo.full_name} 可能可以降级关注`;
  const summary =
    kind === "recommended_now"
      ? `它和当前 TODO、docs、branch 或近期 commit 中的 ${terms.slice(0, 3).join(", ") || "主题"} 有重合。`
      : kind === "rediscovered"
        ? `你较早收藏过它，但它近期仍有更新，值得重新看一眼。`
        : repo.archived
          ? "这个仓库已经 archived，适合放入低优先级或忽略。"
          : "它长期缺少近期活动，也没有强当前工作证据。";
  return {
    id: null,
    fingerprint: fingerprint(kind, title, [repo.repo_id], terms),
    kind,
    title,
    summary,
    health,
    health_reason: healthReason(health, currentWork, warningsCount),
    score: baseScore + activeBonus + starBonus,
    repo_ids: [repo.repo_id],
    terms,
    evidence,
  };
}

export function tasteProfileInsight(
  tags: { tag: string; count: number }[]
): RadarInsight | null {
  const top = tags.slice(0, 8);
  if (top.length === 0) return null;
  const terms = top.map((t) => t.tag);
  const title = `你的开源兴趣正在靠近 ${terms.slice(0, 3).join(" / ")}`;
  return {
    id: null,
    fingerprint: fingerprint("taste_profile", title, [], terms),
    kind: "taste_profile",
    title,
    summary: "这是从 Star topics 和语言标签里提炼出的长期技术品味。",
    health: "strong",
    health_reason: "基于多个 Star 标签聚合。",
    score: top.reduce((sum, t) => sum + t.count, 0),
    repo_ids: [],
    terms,
    evidence: top.map((t) => ({
      source_kind: "topic",
      label: `${t.tag} · ${t.count}`,
      source_path: null,
      matched_terms: [t.tag],
      weight: Math.min(5, t.count),
    })),
  };
}

export function applyFeedbackEffects(
  insights: RadarInsight[],
  feedbackRows: FeedbackRow[],
  now: Date
): RadarInsight[] {
  const active = feedbackRows.filter(
    (f) => !f.expires_at || new Date(f.expires_at).getTime() > now.getTime()
  );
  return insights
    .map((insight) => {
      let next = { ...insight };
      for (const f of active) {
        const exact =
          f.insight_fingerprint === insight.fingerprint ||
          (f.target_type === "insight" && f.target_id === insight.fingerprint);
        const sameRepo =
          f.repo_id != null && insight.repo_ids.includes(f.repo_id);
        const relatedTerm = f.terms.some((t) => insight.terms.includes(t));
        if (f.feedback === "useful" && (exact || relatedTerm)) {
          next.score += exact ? 20 : 5;
        }
        if (f.feedback === "wrong" && exact) {
          next = { ...next, health: "suppressed", score: -999 };
        } else if (f.feedback === "wrong" && sameRepo && relatedTerm) {
          next.score -= 15;
        }
        if (f.feedback === "later" && sameRepo && insight.kind === "recommended_now") {
          next = { ...next, health: "suppressed", score: -999 };
        }
        if (
          f.feedback === "ignore" &&
          sameRepo &&
          (insight.kind === "recommended_now" || insight.kind === "rediscovered")
        ) {
          next = { ...next, health: "suppressed", score: -999 };
        }
      }
      return next;
    })
    .sort((a, b) => b.score - a.score);
}

export function fingerprint(
  kind: string,
  title: string,
  repoIds: number[],
  terms: string[]
): string {
  return sha1(
    JSON.stringify({
      kind,
      title: title.trim().toLowerCase(),
      repoIds: [...repoIds].sort((a, b) => a - b),
      terms: [...terms].sort(),
    })
  );
}

function healthFor(
  kind: string,
  evidence: RadarInsightEvidence[],
  warningsCount: number,
  currentWork: boolean
): RadarInsightHealth {
  if (warningsCount > 0 && currentWork) return "partial";
  if (kind === "retire_candidate") return evidence.length > 0 ? "strong" : "weak";
  if (currentWork && evidence.length >= 3) return "strong";
  if (currentWork) return "partial";
  return "weak";
}

function healthReason(
  health: RadarInsightHealth,
  currentWork: boolean,
  warningsCount: number
): string {
  if (health === "partial") {
    return warningsCount > 0
      ? "部分本地上下文读取失败，但仍有当前工作证据。"
      : "有当前工作证据，但证据数量有限。";
  }
  if (health === "strong") {
    return currentWork ? "有当前工作证据和 repo 事实共同支撑。" : "有多项 repo 事实支撑。";
  }
  if (health === "suppressed") return "用户反馈已暂时隐藏。";
  return "证据较弱，应该低置信展示。";
}

function daysBetween(iso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
}
