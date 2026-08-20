/**
 * 跨模块共用的诊断条目。
 *
 * workDashboard / workRecap / workTokensTrend 三处各自定义过同款
 * `{severity, kind, message}`,~10 行 × 3 重复,而且每加一个模块就再复制一次。
 * 抽到这里之后 severity 联合只有一处真相,不会两边漂移。
 *
 * **各模块保留自己带前缀的别名**(`DashboardDiagnostic` 等),所以调用点零改动 ——
 * TODOS 里记的那条顾虑「抽出后命名要重新决定」由此消解:名字不用改,只是背后
 * 共享同一个核心。
 */

export type DiagnosticSeverity = "info" | "warning" | "error";

/** 诊断的公共核心。各模块用交叉类型补自己的字段。 */
export type Diagnostic = {
  severity: DiagnosticSeverity;
  kind: string;
  message: string;
};
