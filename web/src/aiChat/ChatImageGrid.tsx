import { useState } from "react";
import { imageGridLayout, type ChatImage } from "./imageGrid";

/**
 * 用户消息里的图。规格来自设计评审:
 * - D2 分数网格(不是固定像素),每格 4:3 裁切填满,最多两行,超出收进「+N」,单张横跨两格
 * - D3 点击在新标签打开原图
 * - 断图显示中性的「图已不在」—— 那是历史事实,不是当前错误,所以不用红色
 *
 * 纯展示,不碰 CopilotKit 的任何状态。
 *
 * `!mb-2` / `!border`:它渲染在聊天区里,CopilotKit 对聊天区的元素级重置会把
 * margin 与 border 清零(详见 ChatContextBar)。
 */
export function ChatImageGrid({ images }: { images: ChatImage[] }) {
  const layout = imageGridLayout(images.length);
  if (layout.visible === 0) return null;
  const shown = images.slice(0, layout.visible);
  return (
    <div
      data-testid="chat-image-grid"
      className="!mb-2 grid w-full max-w-[480px] gap-1.5"
      style={{ gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))` }}
    >
      {shown.map((image, i) => (
        <ImageCell
          key={i}
          image={image}
          span={layout.spanFirst && i === 0}
          overflow={i === shown.length - 1 ? layout.overflow : 0}
        />
      ))}
    </div>
  );
}

function ImageCell({ image, span, overflow }: { image: ChatImage; span: boolean; overflow: number }) {
  const [broken, setBroken] = useState(false);
  const alt = image.filename ?? "用户贴的截图";
  const cell = `relative aspect-[4/3] overflow-hidden rounded${span ? " col-span-2" : ""}`;

  if (broken) {
    return (
      <div className={`${cell} flex items-center justify-center !border !border-neutral-200 bg-[#fafafa]`}>
        <span className="text-[11px] text-neutral-400">图已不在</span>
      </div>
    );
  }

  return (
    <a
      href={image.isDataSource ? "#" : image.src}
      target="_blank"
      rel="noopener noreferrer"
      title={`${alt}（在新标签打开原图）`}
      onClick={
        image.isDataSource
          ? (e) => {
              e.preventDefault();
              openDataImage(image.src);
            }
          : undefined
      }
      className={`${cell} block bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
    >
      <img src={image.src} alt={alt} className="h-full w-full object-cover" onError={() => setBroken(true)} />
      {overflow > 0 ? (
        <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-sm font-medium text-white">
          +{overflow}
        </span>
      ) : null}
    </a>
  );
}

/**
 * 刚发出、还没落库的那条是内联 base64。Chrome 禁止在新标签里顶层导航到 data: 地址,
 * 直接当 href 用会点了没反应 —— 所以点击时才转成 blob URL 再打开。
 * 放在点击时而不是渲染时:一张手机原图的 base64 有两三 MB,没人点就不该解码。
 */
function openDataImage(dataUrl: string) {
  const comma = dataUrl.indexOf(",");
  const mime = dataUrl.slice(5, dataUrl.indexOf(";")) || "image/png";
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  window.open(url, "_blank", "noopener");
  // 给新标签足够时间读完再回收,免得大图还没加载完地址就失效。
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
