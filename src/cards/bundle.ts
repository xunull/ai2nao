/**
 * `card bundle`:把全部卡片渲成 SVG + 一个自包含 README.md,一并写进目标目录。
 * README 用**相对路径**嵌图(`![](name.svg)`,GitHub 原生当图渲染),整目录 commit 成
 * 一个公开 repo 即可,主页 README 再引一下。
 *
 * 非破坏性:只写 out-dir 内的 <name>.svg 和 README.md,不碰用户已有的主页 README。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import {
  CARD_REGISTRY,
  findCard,
  type CardDef,
  type CardRenderOpts,
} from "./registry.js";

export type BundleOptions = {
  cost?: boolean;
  /** 覆盖时钟(测试 / README 日期)。 */
  now?: Date;
};

export type BundleResult = {
  outDir: string;
  /** 写出的文件绝对路径(N 个 svg + README.md)。 */
  files: string[];
};

/** 生成整套卡片 + README 到 outDir。返回写出的文件列表。 */
export function generateCardBundle(
  db: Database.Database,
  outDir: string,
  opts: BundleOptions = {}
): BundleResult {
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });

  const renderOpts: CardRenderOpts = { cost: opts.cost, now: opts.now };
  const files: string[] = [];

  for (const card of CARD_REGISTRY) {
    const svgPath = join(dir, `${card.name}.svg`);
    writeFileSync(svgPath, card.render(db, renderOpts), "utf8");
    files.push(svgPath);
  }

  const readmePath = join(dir, "README.md");
  writeFileSync(readmePath, buildReadme(opts.now), "utf8");
  files.push(readmePath);

  return { outDir: dir, files };
}

/**
 * README 布局:每行一个数组。单个 name = 整行(宽卡);两个 name = 并排(窄卡,HTML 表格)。
 * 未列到的卡兜底整行补在末尾,删卡也不会引用到不存在的图。
 */
const README_LAYOUT: string[][] = [
  ["rhythm"],
  ["calendar"],
  ["streak", "token"],
  ["source-trend", "records"],
  ["ai-tools", "leaderboard"],
];

function buildReadme(now?: Date): string {
  const date = (now ?? new Date()).toISOString().slice(0, 10);
  const used = new Set<string>();
  const blocks: string[] = [];

  // 连续的「并排行」归进同一张 <table>,列宽全表共享 → 三行的分界线才对齐。
  let pending: CardDef[][] = [];
  const flush = () => {
    if (pending.length) {
      blocks.push(multiRowTable(pending));
      pending = [];
    }
  };

  for (const row of README_LAYOUT) {
    const cards = row
      .map((name) => findCard(name))
      .filter((c): c is CardDef => c !== undefined);
    if (cards.length === 0) continue;
    for (const c of cards) used.add(c.name);
    if (cards.length === 1) {
      flush(); // 整行卡打断表格
      blocks.push(fullBlock(cards[0]));
    } else {
      pending.push(cards);
    }
  }
  flush();
  // 布局里没列到的卡(以后新增的)整行补在后面。
  for (const c of CARD_REGISTRY) {
    if (!used.has(c.name)) blocks.push(fullBlock(c));
  }

  return (
    `# 我的 AI coding 面板\n\n` +
    `> 由 [ai2nao](https://github.com/xunull/ai2nao) 从本地数据生成 · 更新于 ${date}\n\n` +
    `${blocks.join("\n\n")}\n`
  );
}

/** 整行:markdown 标题 + 说明 + 图。 */
function fullBlock(c: CardDef): string {
  return `## ${c.title}\n\n${c.description}\n\n![${c.name}](${c.name}.svg)`;
}

/**
 * 多行并排:一张 <table> 装多行(每行一个 <tr>)。列宽是整表共享的,所以各行的
 * 列边界垂直对齐。列数取最宽一行,width 平分栏宽(td 用 % 让浏览器等分)。
 */
function multiRowTable(rows: CardDef[][]): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const w = Math.round(100 / cols);
  const trs = rows
    .map((cards) => `<tr>\n${cards.map((c) => cell(c, w)).join("\n")}\n</tr>`)
    .join("\n");
  return `<table width="100%">\n${trs}\n</table>`;
}

function cell(c: CardDef, w: number): string {
  return (
    `<td width="${w}%" valign="top">\n` +
    `<h3>${c.title}</h3>\n` +
    `${c.description}<br><br>\n` +
    `<img src="${c.name}.svg" width="100%" alt="${c.name}">\n` +
    `</td>`
  );
}
