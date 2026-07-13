import { scrubPaths } from "../util/scrub.js";
import { redactSecrets } from "./prompt.js";
import type { WorkRecapRun } from "./types.js";

/**
 * Render a work-recap run as a Feishu interactive card.
 *
 * SAFETY: every string that goes into the card passes through
 * `redactSecrets` (API keys / tokens in commit subjects) + `scrubPaths`
 * (real home paths). This is the one place ai2nao sends data off the machine,
 * so sanitisation is applied at the boundary, not trusted upstream.
 *
 * No deep link back to ai2nao: it serves on localhost, so a link would be dead
 * on the phone where you actually read the card. A dead link is worse than none.
 */
export type RecapPushKind = "daily" | "weekly";

const WORK_MODE_LABEL: Record<string, string> = {
  build: "在 build",
  debug: "在 debug",
  explore: "在 explore",
  fragmented: "被打断得厉害",
  low_signal: "信号很少",
};

function clean(s: string | null | undefined): string {
  if (!s) return "";
  return scrubPaths(redactSecrets(String(s)).redacted).trim();
}

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function cardTitle(kind: RecapPushKind, run: WorkRecapRun): string {
  const f = run.facts;
  if (kind === "daily") {
    return `今日回看 · ${f.windowStart.slice(0, 10)}`;
  }
  // last-week: windowEnd is the exclusive 本周一 00:00 → show 上周日 as the last day
  const endExclusive = new Date(f.windowEnd);
  const lastDay = new Date(endExclusive.getTime() - 86_400_000);
  return `上周回看 · ${f.windowStart.slice(0, 10)} ~ ${lastDay.toISOString().slice(0, 10)}`;
}

/** Feishu interactive-card payload (the `card` field of the webhook body). */
export function renderFeishuCard(kind: RecapPushKind, run: WorkRecapRun): unknown {
  const { facts, inference } = run;
  const elements: unknown[] = [];

  // Mode + one-line reason
  const mode = WORK_MODE_LABEL[inference.workMode] ?? inference.workMode;
  const reason = clean(inference.workModeReason);
  elements.push({
    tag: "div",
    text: {
      tag: "lark_md",
      content: `**看起来${mode}**${reason ? ` · ${reason}` : ""}`,
    },
  });

  // The narrative (facts and inference stay visually separate, like the UI).
  const summary = clean(inference.summary);
  if (summary) {
    elements.push({ tag: "div", text: { tag: "lark_md", content: summary } });
  }
  if (inference.degraded) {
    elements.push({
      tag: "note",
      elements: [{ tag: "plain_text", content: "叙事已降级,以下为事实层" }],
    });
  }

  elements.push({ tag: "hr" });

  // Fact fields (two-column)
  const fields: unknown[] = [];
  const tf = facts.tokenFacts;
  if (tf?.status === "ok" && tf.data) {
    const hedge = tf.data.coverage === "full" ? "" : "(至少)";
    fields.push({
      is_short: true,
      text: {
        tag: "lark_md",
        content: `**成本**\n${fmtMoney(tf.data.costUsd)}${hedge}`,
      },
    });
  }
  fields.push({
    is_short: true,
    text: {
      tag: "lark_md",
      content: `**提交**\n${facts.totalCommits} 条 / ${facts.projectCount} 个项目`,
    },
  });
  if (fields.length > 0) elements.push({ tag: "div", fields });

  // Topics per source
  const tp = facts.topicDrift;
  if (tp?.status === "ok" && tp.data) {
    const lines = tp.data.bySource
      .map((s) => {
        const label = s.source === "chrome" ? "浏览" : s.source === "git" ? "提交" : "对话";
        const top = s.top
          .slice(0, 3)
          .map((t) => `${clean(t.name)} ${(t.share * 100).toFixed(0)}%`)
          .join(" · ");
        return top ? `**${label}** ${top}` : "";
      })
      .filter(Boolean);
    if (lines.length > 0) {
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: lines.join("\n") },
      });
    }
  }

  // Top projects
  const projects = facts.projectShare
    .slice(0, 3)
    .map((p) => `${clean(p.projectLabel)}(${p.commitCount})`)
    .join(" · ");
  if (projects) {
    elements.push({
      tag: "note",
      elements: [{ tag: "plain_text", content: `主要项目:${projects}` }],
    });
  }

  elements.push({
    tag: "note",
    elements: [{ tag: "plain_text", content: `ai2nao · ${run.promptVersion}` }],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: cardTitle(kind, run) },
      template: kind === "weekly" ? "blue" : "turquoise",
    },
    elements,
  };
}
