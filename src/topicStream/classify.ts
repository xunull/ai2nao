import { createHash } from "node:crypto";
import {
  chromeHistoryUrlIdentity,
  type ChromeHistoryUrlIdentity,
} from "../chromeHistory/domain.js";

/**
 * Stage 1 topic classification: an OPINIONATED, dev-focused default taxonomy.
 *
 * These bands are tuned for a heavy developer's browsing (so "开发" is split
 * into frontend / backend / AI / docs / community / tools rather than being one
 * fat band). Open-source users will be able to override this via
 * `~/.ai2nao/config.json` in Stage 2; for now it ships as a built-in constant.
 *
 * `其他` (Other) is the fallback and is NOT a taxonomy entry.
 */

export type TaxonomyRule =
  | { kind: "domainSuffix"; value: string }
  | { kind: "hostPrefix"; value: string }
  | { kind: "titleKeyword"; value: string };

export const TAXONOMY_RULE_KINDS = ["domainSuffix", "hostPrefix", "titleKeyword"] as const;

export type TopicCategory = {
  name: string;
  color: string;
  rules: TaxonomyRule[];
};

export const OTHER_CATEGORY = "其他";
export const OTHER_COLOR = "#8a8f98";

export const DEFAULT_TAXONOMY: TopicCategory[] = [
  {
    name: "前端·UI",
    color: "#4f9dff",
    rules: [
      { kind: "domainSuffix", value: "reactjs.org" },
      { kind: "domainSuffix", value: "react.dev" },
      { kind: "domainSuffix", value: "vuejs.org" },
      { kind: "domainSuffix", value: "svelte.dev" },
      { kind: "domainSuffix", value: "tailwindcss.com" },
      { kind: "domainSuffix", value: "css-tricks.com" },
      { kind: "titleKeyword", value: "css" },
      { kind: "titleKeyword", value: "tailwind" },
      { kind: "titleKeyword", value: "react" },
    ],
  },
  {
    name: "后端·基建",
    color: "#3fb98f",
    rules: [
      { kind: "domainSuffix", value: "kubernetes.io" },
      { kind: "domainSuffix", value: "docker.com" },
      { kind: "domainSuffix", value: "nginx.org" },
      { kind: "domainSuffix", value: "postgresql.org" },
      { kind: "domainSuffix", value: "redis.io" },
      { kind: "domainSuffix", value: "grpc.io" },
      { kind: "domainSuffix", value: "terraform.io" },
    ],
  },
  {
    name: "AI·ML",
    color: "#a06bff",
    rules: [
      { kind: "domainSuffix", value: "huggingface.co" },
      { kind: "domainSuffix", value: "openai.com" },
      { kind: "domainSuffix", value: "anthropic.com" },
      { kind: "domainSuffix", value: "arxiv.org" },
      { kind: "domainSuffix", value: "pytorch.org" },
      { kind: "domainSuffix", value: "kaggle.com" },
      { kind: "titleKeyword", value: "llm" },
      { kind: "titleKeyword", value: "embedding" },
    ],
  },
  {
    name: "文档·API",
    color: "#e0a33a",
    rules: [
      { kind: "domainSuffix", value: "developer.mozilla.org" },
      { kind: "domainSuffix", value: "docs.python.org" },
      { kind: "domainSuffix", value: "pkg.go.dev" },
      { kind: "domainSuffix", value: "docs.rs" },
      { kind: "domainSuffix", value: "readthedocs.io" },
      { kind: "titleKeyword", value: "documentation" },
    ],
  },
  {
    name: "社区",
    color: "#ff8a5c",
    rules: [
      { kind: "domainSuffix", value: "github.com" },
      { kind: "domainSuffix", value: "stackoverflow.com" },
      { kind: "domainSuffix", value: "news.ycombinator.com" },
      { kind: "domainSuffix", value: "reddit.com" },
      { kind: "domainSuffix", value: "zhihu.com" },
      { kind: "domainSuffix", value: "v2ex.com" },
      { kind: "domainSuffix", value: "juejin.cn" },
    ],
  },
  {
    name: "资讯·阅读",
    color: "#c98bdb",
    rules: [
      { kind: "domainSuffix", value: "medium.com" },
      { kind: "domainSuffix", value: "substack.com" },
      { kind: "domainSuffix", value: "mp.weixin.qq.com" },
      { kind: "domainSuffix", value: "sspai.com" },
    ],
  },
  {
    name: "工具·云控制台",
    color: "#6c9fb8",
    rules: [
      { kind: "domainSuffix", value: "console.aws.amazon.com" },
      { kind: "domainSuffix", value: "console.cloud.google.com" },
      { kind: "domainSuffix", value: "vercel.com" },
      { kind: "domainSuffix", value: "netlify.com" },
      { kind: "domainSuffix", value: "cloudflare.com" },
      { kind: "domainSuffix", value: "portal.azure.com" },
    ],
  },
  {
    name: "视频·娱乐",
    color: "#e5688a",
    rules: [
      { kind: "domainSuffix", value: "youtube.com" },
      { kind: "domainSuffix", value: "bilibili.com" },
      { kind: "domainSuffix", value: "twitch.tv" },
      { kind: "domainSuffix", value: "netflix.com" },
    ],
  },
];

/** Stable content hash of the active taxonomy — the rebuild's `rule_version`. */
export function taxonomyRuleVersion(taxonomy: TopicCategory[] = DEFAULT_TAXONOMY): string {
  const canonical = JSON.stringify(
    taxonomy.map((c) => ({ name: c.name, rules: c.rules }))
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

export const TAXONOMY_RULE_VERSION = taxonomyRuleVersion();

/** Ordered category name + color list for the frontend legend (Other appended). */
export function taxonomyLegend(
  taxonomy: TopicCategory[] = DEFAULT_TAXONOMY
): { name: string; color: string }[] {
  return [
    ...taxonomy.map((c) => ({ name: c.name, color: c.color })),
    { name: OTHER_CATEGORY, color: OTHER_COLOR },
  ];
}

/** Dot-boundary suffix match: `reactjs.org` matches `docs.reactjs.org`, not `evil-reactjs.org`. */
function domainSuffixMatch(host: string, value: string): boolean {
  const v = value.toLowerCase();
  return host === v || host.endsWith(`.${v}`);
}

/** Literal host prefix: `192.168.` matches `192.168.10.36`; used for LAN IPs / homelab. */
function hostPrefixMatch(host: string, value: string): boolean {
  return host.startsWith(value.toLowerCase());
}

function hostRuleMatch(host: string, rule: TaxonomyRule): boolean {
  if (rule.kind === "domainSuffix") return domainSuffixMatch(host, rule.value);
  if (rule.kind === "hostPrefix") return hostPrefixMatch(host, rule.value);
  return false;
}

/**
 * Classify one visit's URL identity + title into a category.
 *
 * Two deterministic passes so a host match always beats a title-keyword match:
 *   1. host pass (domainSuffix + hostPrefix) over categories in array order.
 *   2. titleKeyword pass over categories in array order.
 *   3. otherwise `其他`.
 * First hit wins in each pass, so the result is stable and reproducible.
 */
export function classifyIdentity(
  identity: ChromeHistoryUrlIdentity,
  title: string | null | undefined,
  taxonomy: TopicCategory[] = DEFAULT_TAXONOMY
): string {
  const host = identity.host;
  if (host) {
    for (const cat of taxonomy) {
      for (const rule of cat.rules) {
        if (hostRuleMatch(host, rule)) return cat.name;
      }
    }
  }
  const t = (title ?? "").toLowerCase();
  if (t) {
    for (const cat of taxonomy) {
      for (const rule of cat.rules) {
        if (rule.kind === "titleKeyword" && t.includes(rule.value.toLowerCase())) {
          return cat.name;
        }
      }
    }
  }
  return OTHER_CATEGORY;
}

/** Convenience wrapper: parse the URL via the shared identity helper, then classify. */
export function classifyUrl(
  url: string,
  title: string | null | undefined,
  taxonomy: TopicCategory[] = DEFAULT_TAXONOMY
): string {
  return classifyIdentity(chromeHistoryUrlIdentity(url), title, taxonomy);
}
