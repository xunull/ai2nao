/**
 * 看板各页面共用的源标签。
 *
 * 为什么单独一个文件:`web/` 与 `src/` 是两个 tsconfig(web/tsconfig.json 的
 * include 只有 `src`,指的是 `web/src`),前端 import 不到后端的
 * `DASHBOARD_SOURCES`。所以这里保留一份**类型**副本用于穷尽性检查,而**运行时
 * 的源列表**由后端响应的 `availableSources` 下发 —— 加第五个源时下拉自动就有,
 * 只有标签需要在这里补一行,而且不补 tsc 会报。
 *
 * 在此之前,WorkDashboard.tsx 与 WorkTokenRanking.tsx 各写了一个末位是**兜底**
 * 的标签函数(`return "opencode"` / `: "opencode"`),任何新源都会被静默标成
 * opencode。下面的 Record 让「漏配标签」变成编译错误而不是错误的界面文字。
 */

export const DASHBOARD_SOURCES = ["claude-code", "codex", "opencode", "kimi"] as const;

export type DashboardSource = (typeof DASHBOARD_SOURCES)[number];

/** 漏一个键 → tsc 报 "Property 'x' is missing in type"。这是本文件存在的理由。 */
export const SOURCE_LABELS: Record<DashboardSource, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  opencode: "opencode",
  kimi: "Kimi",
};

/**
 * 后端可能下发前端还不认识的源(后端先上线、前端后跟)。这种情况显示源的原始
 * 标识而不是任何一个已知源的名字 —— 难看,但不会指鹿为马。
 */
export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source as DashboardSource] ?? source;
}

/**
 * 由后端下发的 `availableSources` 生成下拉选项:一个「全选」加逐源。
 * value 是逗号分隔串,与 URL 上的 `sources` 参数同形。
 *
 * `selected` 是当前选中的那串。URL 上可能带着任意组合(老书签就是这么来的),
 * 若它不等于任何一个选项的 value,`<select>` 会静默显示错的那项 —— 所以把它
 * 补成一个额外选项,标签由各部分拼出来。
 */
export function buildSourceOptions(
  available: readonly string[],
  selected?: string
): { value: string; label: string }[] {
  const each = available.map((source) => ({
    value: source,
    label: sourceLabel(source),
  }));
  const options =
    available.length <= 1
      ? each
      : [{ value: available.join(","), label: "全部来源" }, ...each];
  // 首屏 available 还是空的(响应没回来),但 URL 上可能已经有选中值。此时仍然
  // 补出这一个选项 —— 否则下拉是个空控件,看上去像「一个来源都没有」。
  if (selected && !options.some((option) => option.value === selected)) {
    options.push({
      value: selected,
      label: selected.split(",").map(sourceLabel).join(" + "),
    });
  }
  return options;
}
