/**
 * PNG 导出：把任意 HTMLElement 拍成 PNG 让用户下载。
 *
 * D2 spike 选了 html2canvas-pro（旧 html2canvas 不支持 oklch + 在 Recharts
 * 的 <foreignObject> 上有渲染坑；pro 分支处理了这俩）。如果之后这条路
 * 跑不稳，design Day 2 step 10 还有 server-side resvg-js 兜底方案。
 *
 * 性能预算（P4）：M-class MacBook 1920×1080 ≤500ms。pixelRatio=2 让推文
 * 截图清晰，又不会把生成尺寸放到 4K 量级。
 */
export async function exportElementToPng(
  el: HTMLElement,
  filename: string
): Promise<void> {
  const { default: html2canvas } = await import("html2canvas-pro");
  const canvas = await html2canvas(el, {
    backgroundColor: "#ffffff",
    scale: window.devicePixelRatio > 1 ? 2 : 1.5,
    logging: false,
  });
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png")
  );
  if (!blob) throw new Error("canvas.toBlob produced no blob");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
