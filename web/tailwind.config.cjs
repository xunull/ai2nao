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
  plugins: [],
};
