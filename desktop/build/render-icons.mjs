import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

/**
 * SVG → .icns（应用图标）+ base64 PNG（菜单栏图标）。
 *
 * 跑法：`npm run icons`。产物已提交，所以日常 build / package 不跑这个脚本 ——
 * 只有改了 build/*.svg 才需要重跑。
 *
 * ## 为什么用 qlmanage + sips
 *
 * 都是 macOS 自带，零依赖。试过的两条路都不行：
 *  - playwright：仓库根装的是 1.59.1，它要 chromium build 1234，本机缓存里只有
 *    1208/1217，而 `playwright install` 静默无输出也没补上。
 *  - Electron 离屏 capturePage：`transparent: true` + `show: false` 时挂死，
 *    合成器不给隐藏窗口出帧。
 *
 * ## 两个踩过的坑，改这个文件前先读
 *
 * 1. **qlmanage 不放大，只补白。** `-s 512` 遇到固有尺寸 44 的 SVG，会把 44px
 *    的内容放进 512 画布的左上角，其余留白。所以 tray.svg 的 width/height 写
 *    512（viewBox 仍是 44），先渲大图再用 sips 降采样。
 * 2. **水平直线 + objectBoundingBox 渐变 = 不上色。** 见 icon.svg 里的注释。
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** macOS .icns 要求的全套尺寸（含 @2x）。 */
const ICNS_SIZES = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];

/** 菜单栏：@1x / @2x / @3x。 */
const TRAY_SIZES = [16, 32, 48];

const work = join(tmpdir(), `ai2nao-icons-${process.pid}`);
mkdirSync(work, { recursive: true });

/** 用 Quick Look 把 SVG 渲成 PNG（按 SVG 的固有尺寸，不放大）。返回 PNG 路径。 */
function renderMaster(svgName, size) {
  execFileSync("qlmanage", ["-t", "-s", String(size), "-o", work, join(HERE, svgName)], {
    stdio: "ignore",
  });
  const out = join(work, `${svgName}.png`);
  const dims = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", out], {
    encoding: "utf8",
  });
  if (!dims.includes(`pixelWidth: ${size}`)) {
    throw new Error(
      `${svgName} rendered at the wrong size:\n${dims}\n` +
        `qlmanage 不会放大 SVG —— 把 <svg> 的 width/height 调到至少 ${size}。`
    );
  }
  return out;
}

/** sips 降采样到指定边长，写到目标路径。 */
function resize(src, size, dest) {
  execFileSync("sips", ["-s", "format", "png", "-z", String(size), String(size), src, "--out", dest], {
    stdio: "ignore",
  });
}

try {
  // ---- 应用图标 ----
  const appMaster = renderMaster("icon.svg", 1024);
  const iconset = join(work, "icon.iconset");
  mkdirSync(iconset, { recursive: true });
  for (const [size, name] of ICNS_SIZES) resize(appMaster, size, join(iconset, name));
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(HERE, "icon.icns")]);
  // electron-builder 在非 mac 目标（以及某些 dmg 步骤）会用到 PNG。
  resize(appMaster, 512, join(HERE, "icon.png"));
  console.log("wrote build/icon.icns + build/icon.png");

  // ---- 菜单栏图标 → 源码里的 base64 ----
  const trayMaster = renderMaster("tray.svg", 512);
  const trays = TRAY_SIZES.map((size) => {
    const dest = join(work, `tray-${size}.png`);
    resize(trayMaster, size, dest);
    return [size, readFileSync(dest).toString("base64")];
  });
  writeFileSync(
    join(HERE, "..", "src", "trayIcon.generated.ts"),
    `// 自动生成,不要手改。改了 desktop/build/tray.svg 之后跑:npm run icons\n` +
      `//\n` +
      `// 为什么是 base64 而不是 PNG 文件:打包后的 .app 里没有源码树,任何「运行时按\n` +
      `// 相对路径找资源」的写法都会断(壳已经为此栽过一次)。data URL 没有路径。\n` +
      `//\n` +
      `// 纯黑 + alpha 的 template image —— macOS 会按浅色/深色菜单栏和高亮状态自己\n` +
      `// 重新着色,所以这里放任何颜色都会被丢掉。\n` +
      `export const TRAY_ICON_DATA_URLS: ReadonlyArray<{ scale: number; dataUrl: string }> = [\n` +
      trays
        .map(
          ([size, b64], i) =>
            `  { scale: ${i + 1}, dataUrl: "data:image/png;base64,${b64}" }, // ${size}px`
        )
        .join("\n") +
      `\n];\n`
  );
  console.log(`wrote src/trayIcon.generated.ts (${TRAY_SIZES.join("/")}px)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
