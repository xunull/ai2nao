import { readLlmChatConfig, type LlmChatConfig } from "../llmChat/config.js";
import { stripControlTags } from "../workCosmos/summarize.js";
import { scrubPaths, tfidfLabels, type ClusterNamer } from "./conversation.js";

/** Up to this many representative messages per cluster shown to the namer. */
const NAMING_SAMPLES = 6;
const NAMING_SAMPLE_CHARS = 220;
const MAX_LABEL_CHARS = 14;

async function chatComplete(cfg: LlmChatConfig, prompt: string): Promise<string> {
  const baseURL = cfg.baseURL.replace(/\/$/, "");
  const url = baseURL.includes("/v1") ? `${baseURL}/chat/completions` : `${baseURL}/v1/chat/completions`;
  const apiKey =
    cfg.apiKey?.trim() ||
    process.env.AI2NAO_LLM_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "local-no-key";
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      // Reasoning models (e.g. deepseek-reasoner) spend the budget on reasoning
      // before emitting content; too small a cap returns an empty label. The
      // label itself is short — the sanitizer trims — so the ceiling is safe.
      max_tokens: 600,
    }),
  });
  if (!r.ok) throw new Error(`chat HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return j.choices?.[0]?.message?.content ?? "";
}

/** Keep a clean, path-free, short label; fall back when the model returns junk. */
function sanitizeLabel(raw: string, fallback: string): string {
  let s = scrubPaths(raw).split("\n")[0]!.trim();
  s = s.replace(/^["'「『【\s]+|["'」』】\s]+$/g, "").replace(/[\\/]+/g, " ").trim();
  s = s.slice(0, MAX_LABEL_CHARS).trim();
  return s.length >= 1 ? s : fallback;
}

function promptFor(texts: string[]): string {
  const samples = texts
    .slice(0, NAMING_SAMPLES)
    .map((t) => stripControlTags(scrubPaths(t)).replace(/\s+/g, " ").slice(0, NAMING_SAMPLE_CHARS))
    .filter(Boolean)
    .map((t, i) => `${i + 1}. ${t}`)
    .join("\n");
  return (
    "下面是同一主题簇里若干条「用户向 AI 提的问题」片段。请用 2-6 个汉字给这个主题起一个简洁、可读的中文标签。" +
    "只输出标签本身,不要引号、标点、解释,不要出现文件路径或代码。\n\n" +
    samples
  );
}

/**
 * LLM cluster namer with an offline TF-IDF fallback. Names each cluster from a
 * few representative messages. Any config/network failure degrades that cluster
 * (or all) to its TF-IDF label — naming never blocks a rebuild. Only runs at
 * freeze/bump (codebook derivation), not on every rebuild.
 */
export const llmClusterNamer: ClusterNamer = async (clusterTexts) => {
  const fallback = tfidfLabels(clusterTexts);
  const cfg = readLlmChatConfig();
  if (!cfg) return fallback;
  const labels = await Promise.all(
    clusterTexts.map(async (texts, i) => {
      // Retry once: parallel reasoner calls occasionally rate-limit or return an
      // empty label; a single retry avoids an ugly TF-IDF band for that cluster.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const out = await chatComplete(cfg, promptFor(texts));
          const label = sanitizeLabel(out, "");
          if (label) return label;
        } catch {
          // fall through to retry / fallback
        }
      }
      return fallback[i]!;
    })
  );
  // Deliberately NOT de-duplicated. Clusters the model names identically are the
  // same topic — K over-split a dense blob (e.g. lots of "分析这张图" sessions).
  // Same label → same topic_stream category → they collapse into one band. The
  // model's naming is the merge signal; this beats tuning K globally (which just
  // inflates 其他 and starves the smaller real topics).
  return labels;
};
