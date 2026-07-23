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
import { CARD_REGISTRY, type CardRenderOpts } from "./registry.js";

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

function buildReadme(now?: Date): string {
  const date = (now ?? new Date()).toISOString().slice(0, 10);
  const sections = CARD_REGISTRY.map(
    (c) => `## ${c.title}\n\n${c.description}\n\n![${c.name}](${c.name}.svg)`
  ).join("\n\n");
  return (
    `# 我的 AI coding 面板\n\n` +
    `> 由 [ai2nao](https://github.com/xunull/ai2nao) 从本地数据生成 · 更新于 ${date}\n\n` +
    `${sections}\n`
  );
}
