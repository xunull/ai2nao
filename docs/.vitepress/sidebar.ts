import fg from 'fast-glob'
import matter from 'gray-matter'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { DefaultTheme } from 'vitepress'

// docs/ 根目录（本文件在 docs/.vitepress/ 下）
const DOCS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 侧边栏分组的展示顺序（自上而下）。未在此列出的 category 排在最后、「其他」垫底。
const CATEGORY_ORDER = [
  '架构与 AI 对话',
  'RAG 与检索',
  'Token 与成本',
  '数据源与同步',
  'LLM 工具',
  '调度与运维',
  '规划',
  '其他',
]

interface Item {
  text: string
  link: string
  order: number
}

// 在 config 加载期同步扫描 docs/**/*.md，按 frontmatter 的 category 分组生成侧边栏。
// 不用 createContentLoader（官方只承诺 .data.ts 用法）；用 fast-glob + gray-matter 这条 boring 路径。
export function buildSidebar(): DefaultTheme.SidebarItem[] {
  const files = fg.sync('**/*.md', {
    cwd: DOCS_ROOT,
    ignore: ['index.md', '.vitepress/**'], // index.md 是首页，不进侧边栏
  })

  const groups: Record<string, Item[]> = {}
  for (const rel of files) {
    const { data, content } = matter(readFileSync(resolve(DOCS_ROOT, rel), 'utf-8'))

    const category = (data.category as string) || '其他'
    if (!data.category) {
      console.warn(`[sidebar] 缺少 category，归入「其他」: ${rel}`)
    }

    // 标题优先级：frontmatter.title > 正文首个 H1 > 文件名
    let title = data.title as string | undefined
    if (!title) {
      const m = content.match(/^#\s+(.+?)\s*$/m)
      title = m ? m[1].trim() : rel.replace(/\.md$/, '')
    }

    // 站内相对链接，绝不手动带 base（/ai2nao/）——VitePress 自动加 base
    const link = '/' + rel.replace(/\.md$/, '')
    const order = typeof data.order === 'number' ? data.order : 999
    ;(groups[category] ||= []).push({ text: title, link, order })
  }

  const rank = (c: string) => {
    const i = CATEGORY_ORDER.indexOf(c)
    return i === -1 ? CATEGORY_ORDER.length : i
  }

  return Object.keys(groups)
    .sort((a, b) => rank(a) - rank(b))
    .map((category) => ({
      text: category,
      collapsed: false,
      items: groups[category]
        .sort((a, b) => a.order - b.order || a.text.localeCompare(b.text, 'zh-Hans-CN'))
        .map(({ text, link }) => ({ text, link })),
    }))
}
