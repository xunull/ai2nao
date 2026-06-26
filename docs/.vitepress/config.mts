import { defineConfig } from 'vitepress'
import { buildSidebar } from './sidebar'

// ai2nao 设计 & 架构笔记手册（公开发布到 GitHub Pages）
// 文件一律留在 docs/ 原地，仅在侧边栏配置里按 frontmatter.category 逻辑分组。
export default defineConfig({
  base: '/ai2nao/', // GitHub 项目页；若将来上 custom domain 需改
  lang: 'zh-CN',
  title: 'ai2nao 设计笔记',
  description: 'ai2nao 的架构与设计决策手册（贡献者 / 读源码向）',
  cleanUrls: true,
  lastUpdated: true,

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: 'GitHub', link: 'https://github.com/xunull/ai2nao' },
    ],
    sidebar: buildSidebar(),
    search: { provider: 'local' }, // minisearch；中文靠子串匹配，详见 docs 设计 Open Questions
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    darkModeSwitchLabel: '主题',
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '菜单',
    socialLinks: [{ icon: 'github', link: 'https://github.com/xunull/ai2nao' }],
  },

  // 只豁免 docs 根外的相对链接（指向仓库 local-docs/ 等其它目录），保留站内死链校验。
  ignoreDeadLinks: [
    (link: string) => link.startsWith('../') || link.includes('/local-docs/'),
  ],
})
