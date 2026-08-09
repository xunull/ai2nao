process.env.TZ = "Asia/Shanghai";

import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  collectLeads,
  validateRegistry,
  MAX_LEADS,
  PROBES,
  type LeadSeverity,
  type Probe,
} from "../src/home/leads.js";

/**
 * 编排层的性质测试。用合成探针,不碰真数据 —— 这里要守的是「怎么把线索排好、截好、
 * 把异常隔离好」,和某个探针今天说了什么无关。
 */

const NOW = new Date("2026-08-08T04:00:00.000Z");
const ctx = { now: NOW };
const db = null as unknown as Database.Database; // 合成探针不碰 db

/** run() 的返回值:不含 id / href —— 那两个由探针声明,collectLeads 负责补上。 */
function lead(id: string, severity: LeadSeverity, asOf = "2026-08-08T00:00:00.000Z") {
  return { severity, title: `${id} 说了句话`, asOf };
}

/** 出一条线索的探针。 */
function speaking(id: string, severity: LeadSeverity, asOf?: string): Probe {
  return {
    id,
    label: id,
    baseline: { kind: "threshold", note: "test" },
    href: "/dashboard",
    run: () => lead(id, severity, asOf),
  };
}

/** 什么都不说的探针。 */
function silent(id: string): Probe {
  return { id, label: id, baseline: { kind: "novelty" }, href: "/dashboard", run: () => null };
}

/** 炸掉的探针。 */
function exploding(id: string, message = "boom"): Probe {
  return {
    id,
    label: id,
    baseline: { kind: "failure" },
    href: "/scheduler",
    run: () => {
      throw new Error(message);
    },
  };
}

describe("collectLeads 编排", () => {
  it("探针返回 null 就不出现在结果里", () => {
    const r = collectLeads(db, ctx, [speaking("a", "info"), silent("b"), speaking("c", "info")]);
    expect(r.leads.map((l) => l.id)).toEqual(["a", "c"]);
    expect(r.errors).toEqual([]);
  });

  it("全部沉默 → leads 为空并给出兜底卡片", () => {
    const r = collectLeads(db, ctx, [silent("a"), silent("b")]);
    expect(r.leads).toEqual([]);
    expect(r.overflow).toBe(0);
    expect(r.fallbackCards).toEqual(["streak", "rhythm", "source-trend"]);
  });

  it("有线索时不给兜底卡片(否则首页会同时出现两套东西)", () => {
    const r = collectLeads(db, ctx, [speaking("a", "info")]);
    expect(r.fallbackCards).toBeUndefined();
  });

  it("探针抛异常 → 进 errors[],不伪造成 Lead,其余照常返回", () => {
    const r = collectLeads(db, ctx, [
      speaking("ok1", "info"),
      exploding("bad", "table missing"),
      speaking("ok2", "info"),
    ]);
    expect(r.leads.map((l) => l.id)).toEqual(["ok1", "ok2"]);
    expect(r.errors).toEqual([{ probeId: "bad", message: "table missing" }]);
    // 关键:错误没有混进 leads 去占版面。
    expect(r.leads.some((l) => l.id === "bad")).toBe(false);
  });

  it("全部探针都炸 → leads 为空,errors 全在,并且仍给兜底卡片", () => {
    const r = collectLeads(db, ctx, [exploding("a"), exploding("b")]);
    expect(r.leads).toEqual([]);
    expect(r.errors.map((e) => e.probeId)).toEqual(["a", "b"]);
    expect(r.fallbackCards).toBeDefined();
  });

  it("排序:severity 降序 → asOf 降序 → registry 顺序兜底", () => {
    const r = collectLeads(db, ctx, [
      speaking("info-new", "info", "2026-08-08T09:00:00.000Z"),
      speaking("warn", "warning", "2026-08-08T01:00:00.000Z"),
      speaking("notable", "notable", "2026-08-08T02:00:00.000Z"),
      speaking("info-old", "info", "2026-08-08T03:00:00.000Z"),
    ]);
    expect(r.leads.map((l) => l.id)).toEqual(["warn", "notable", "info-new", "info-old"]);
  });

  it("同 severity 同 asOf 时按 registry 顺序,结果是确定的", () => {
    const same = "2026-08-08T05:00:00.000Z";
    const probes = [speaking("first", "info", same), speaking("second", "info", same)];
    for (let i = 0; i < 5; i++) {
      expect(collectLeads(db, ctx, probes).leads.map((l) => l.id)).toEqual(["first", "second"]);
    }
  });

  it(`恰好 ${MAX_LEADS} 条:全显示,不产生 overflow`, () => {
    const probes = Array.from({ length: MAX_LEADS }, (_, i) => speaking(`p${i}`, "info"));
    const r = collectLeads(db, ctx, probes);
    expect(r.leads).toHaveLength(MAX_LEADS);
    expect(r.overflow).toBe(0);
  });

  it(`${MAX_LEADS + 1} 条:截到 ${MAX_LEADS},overflow 计 1`, () => {
    const probes = Array.from({ length: MAX_LEADS + 1 }, (_, i) => speaking(`p${i}`, "info"));
    const r = collectLeads(db, ctx, probes);
    expect(r.leads).toHaveLength(MAX_LEADS);
    expect(r.overflow).toBe(1);
  });

  it("warning 不参与截断 —— 额度见底不会因为版面不够被折走", () => {
    const probes = [
      ...Array.from({ length: MAX_LEADS }, (_, i) => speaking(`info${i}`, "info")),
      speaking("quota", "warning"),
    ];
    const r = collectLeads(db, ctx, probes);
    expect(r.leads.some((l) => l.id === "quota")).toBe(true);
    expect(r.leads[0].id).toBe("quota"); // 而且排在最前
    expect(r.leads).toHaveLength(MAX_LEADS); // warning 占掉一个名额,info 少显示一条
    expect(r.overflow).toBe(1);
  });

  it(`warning 本身超过 ${MAX_LEADS} 条时全部显示(宁可长,也不能瞒)`, () => {
    const probes = Array.from({ length: MAX_LEADS + 2 }, (_, i) => speaking(`w${i}`, "warning"));
    const r = collectLeads(db, ctx, probes);
    expect(r.leads).toHaveLength(MAX_LEADS + 2);
    expect(r.overflow).toBe(0);
  });

  it("返回的 Lead 不带任何内部排序字段", () => {
    const r = collectLeads(db, ctx, [speaking("a", "info")]);
    expect(Object.keys(r.leads[0]).sort()).toEqual(["asOf", "href", "id", "severity", "title"]);
  });
});

describe("validateRegistry 注册前置", () => {
  it("真实注册表通过", () => {
    expect(() => validateRegistry(PROBES)).not.toThrow();
  });

  it("没有 baseline 的探针不允许注册", () => {
    const bad = { id: "x", label: "x", href: "/dashboard", run: () => null } as unknown as Probe;
    expect(() => validateRegistry([bad])).toThrow(/baseline/);
  });

  it("没有 href 的探针不允许注册 —— 不能点进去的线索没有意义", () => {
    const bad = {
      id: "x",
      label: "x",
      baseline: { kind: "novelty" },
      run: () => null,
    } as unknown as Probe;
    expect(() => validateRegistry([bad])).toThrow(/href/);
  });

  it("每条真实探针的 href 都以 / 开头(具体路由校验见 home.links.test.ts)", () => {
    for (const p of PROBES) expect(p.href.startsWith("/"), `${p.id}`).toBe(true);
  });

  it("id 重复会被拦下(否则前端 key 撞车,而且没人会发现)", () => {
    expect(() => validateRegistry([speaking("dup", "info"), silent("dup")])).toThrow(/duplicate/);
  });

  it("每个真实探针都声明了 baseline 且 id 唯一", () => {
    expect(PROBES.length).toBeGreaterThan(0);
    for (const p of PROBES) {
      expect(p.baseline?.kind, `${p.id} 缺 baseline`).toBeTruthy();
    }
    expect(new Set(PROBES.map((p) => p.id)).size).toBe(PROBES.length);
  });
});
