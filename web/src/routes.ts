/**
 * 全站路由表。**纯字符串,不 import React** —— 这样服务端侧的测试可以直接拿它来校验
 * 首页线索的深链,不用把整个前端拖进来。
 *
 * 这份表存在的唯一理由是给「每条线索的 href 都得是真路由」提供判据。它有变成**第二份**
 * 路由表的风险(和 App.tsx 各说各话),所以 test/home.links.test.ts 里有一条测试直接解析
 * App.tsx 的 `<Route path="...">`,断言两边集合完全相等。漂了就当场红。
 */
export const ROUTE_PATHS = [
  "/",
  "/dashboard",
  "/dashboard/tokens",
  "/work-recap",
  "/dashboard/tokens-trend",
  "/dashboard/project-output",
  "/settings",
  "/dashboard/cosmos",
  "/topics/river",
  "/providers",
  "/agent-messages",
  "/ai-rhythm",
  "/ai-sessions",
  "/project-calendar",
  "/attention",
  "/commit-bridge",
  "/replay",
  "/repos",
  "/repos/:id",
  "/repos/:id/file",
  "/search",
  "/scheduler",
  "/atuin",
  "/atuin/directories",
  "/downloads",
  "/apps",
  "/vscode",
  "/cursor-projects",
  "/brew",
  "/huggingface-models",
  "/lmstudio-models",
  "/ai-tools",
  "/chrome-history",
  "/chrome-history/domains",
  "/chrome-downloads",
  "/cherry-studio-history",
  "/cherry-studio-history/s/:sessionId",
  "/cursor-history",
  "/cursor-history/s/:sessionId",
  "/claude-code-history",
  "/claude-code-history/s/:sessionId",
  "/codex-history",
  "/codex-history/s/:sessionId",
  "/opencode-history",
  "/opencode-history/s/:sessionId",
  "/kimi-history",
  "/kimi-history/s/:sessionId",
  "/ai-chat",
  "/bash-permissions",
  "/bash-sandbox",
  "/rag-status",
  "/rag-debug",
  "/github",
  "/github/radar",
  "/github/tags",
] as const;

export type RoutePath = (typeof ROUTE_PATHS)[number];

/**
 * 一个具体路径(可带 query)是否命中路由表。
 *
 * 线索的 href 是具体路径(`/repos/42`),路由表里是模式(`/repos/:id`),所以要按段比对:
 * 段数相同,且每一段要么字面相等,要么表里那段是 `:param`。
 */
export function isKnownRoute(href: string): boolean {
  const path = href.split("?")[0].split("#")[0];
  const parts = path.split("/");
  return ROUTE_PATHS.some((pattern) => {
    const pp = pattern.split("/");
    if (pp.length !== parts.length) return false;
    return pp.every((seg, i) => seg.startsWith(":") || seg === parts[i]);
  });
}
