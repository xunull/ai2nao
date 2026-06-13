/**
 * T0 SPIKE — Recharts 4-Bar stackId + SVG <pattern> fill 验证
 *
 * Verifies design doc F1 assumption that we can express partial token coverage
 * via 4 parallel <Bar stackId="tokens"> series (claudeFull / claudePartial /
 * codexFull / codexPartial) with one of them filled via url(#hatched) pattern.
 *
 * 三个验证点（也在 test/spike-recharts.test.tsx 里断言）：
 *   1. 4 个 Bar 共享 stackId 时正确堆叠（不分离不重叠）
 *   2. SVG <defs><pattern> 能被 <Bar fill="url(#id)"> 引用渲染
 *   3. Tooltip 默认就合并所有同 stackId 的 series
 *
 * 若任一验证失败 → fallback：design doc F1 已写预案（DTO 取消 *Full/*Partial 拆
 * 分，前端 partial 桶用 ⚠ icon）。
 */
import React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
void React;

type SpikeBucket = {
  date: string;
  claudeFull: number;
  claudePartial: number;
  codexFull: number;
  codexPartial: number;
};

const SAMPLE_DATA: SpikeBucket[] = [
  { date: "2026-06-04", claudeFull: 12000, claudePartial: 1500, codexFull: 4000, codexPartial: 800 },
  { date: "2026-06-05", claudeFull: 8000, claudePartial: 3000, codexFull: 2000, codexPartial: 500 },
  { date: "2026-06-06", claudeFull: 6000, claudePartial: 700, codexFull: 6000, codexPartial: 1200 },
  { date: "2026-06-07", claudeFull: 5000, claudePartial: 2000, codexFull: 1000, codexPartial: 4000 },
];

export function RechartsStackedPartialSpike() {
  return (
    <div style={{ width: 800, height: 320, fontFamily: "system-ui" }}>
      <svg width={0} height={0} style={{ position: "absolute" }}>
        <defs>
          <pattern
            id="hatch-claude"
            patternUnits="userSpaceOnUse"
            width="6"
            height="6"
          >
            <rect width="6" height="6" fill="#d97757" />
            <path d="M0,6 L6,0" stroke="rgba(0,0,0,0.25)" strokeWidth="1.2" />
          </pattern>
          <pattern
            id="hatch-codex"
            patternUnits="userSpaceOnUse"
            width="6"
            height="6"
          >
            <rect width="6" height="6" fill="#2563eb" />
            <path d="M0,6 L6,0" stroke="rgba(0,0,0,0.25)" strokeWidth="1.2" />
          </pattern>
        </defs>
      </svg>
      {/*
        In production: <ResponsiveContainer width="100%" height="100%">
        For the spike (and unit tests in jsdom that have no layout pass), use
        fixed dimensions so Recharts actually renders.
      */}
      <BarChart width={800} height={320} data={SAMPLE_DATA}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e4e4e7" />
        <XAxis dataKey="date" axisLine={false} tickLine={false} />
        <YAxis axisLine={false} tickLine={false} />
        <Tooltip />
        <Bar dataKey="claudeFull" stackId="tokens" fill="#d97757" radius={0} />
        <Bar dataKey="claudePartial" stackId="tokens" fill="url(#hatch-claude)" radius={0} />
        <Bar dataKey="codexFull" stackId="tokens" fill="#2563eb" radius={0} />
        <Bar dataKey="codexPartial" stackId="tokens" fill="url(#hatch-codex)" radius={0} />
      </BarChart>
    </div>
  );
}
