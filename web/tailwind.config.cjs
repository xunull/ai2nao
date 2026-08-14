const path = require("node:path");

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    path.join(__dirname, "index.html"),
    path.join(__dirname, "src/**/*.{js,ts,jsx,tsx}"),
  ],
  theme: {
    extend: {
      keyframes: {
        // 右侧 Sheet 抽屉(web/src/components/Sheet.tsx)的滑入/滑出 + 遮罩淡入。
        sheetIn: {
          from: { transform: "translateX(100%)" },
          to: { transform: "translateX(0)" },
        },
        sheetOut: {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(100%)" },
        },
        sheetFade: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
      },
    },
  },
  // typography 提供 `prose` 类,给 RenderedMarkdown 产出的 markdown 元素补回排版。
  // 没有它的话 preflight(@tailwind base)会把这些元素全部清零:h1-h6 的 font-size 与
  // font-weight 都 inherit(标题与正文完全同形)、ol/ul 的 list-style:none 且 margin
  // padding 归零(项目符号与缩进消失)、a 的 color/text-decoration inherit(链接不可见)、
  // td/th 无边框无 padding。实测语料里标题占 11.0% 的消息、无序列表 9.6%、有序列表
  // 6.0%、引用 2.3% —— 不补排版,这四类渲染后比渲染前更难读(字面的 ## 和 - 至少还
  // 提供结构线索)。
  plugins: [require("@tailwindcss/typography")],
};
