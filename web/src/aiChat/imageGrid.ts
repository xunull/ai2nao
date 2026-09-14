/**
 * 用户消息里多张图怎么排。设计评审 D2 定的:**分数网格,不是固定像素**。
 *
 * CopilotKit 默认把图渲染成 `flex-wrap` 一行、每张最大 80×80、宽度随原图比例 ——
 * 一张竖长截图在那里被压成 32px 宽的细缝(2026-09-07 实测)。固定像素还有一个
 * 问题:对话面板宽度随窗口流动(`AiChat.tsx` 的 `grid-cols-[300px_minmax(0,1fr)]`),
 * 窄窗口下会穿出气泡。分数列天然不溢出。
 */

export type ChatImage = {
  /** 给 `<img>` 用的地址:本机附件仓的 url,或刚发出那条的 data: URI。 */
  src: string;
  filename: string | null;
  /** 刚发出、还没落库的那条是内联 base64。打开原图要另走 blob URL。 */
  isDataSource: boolean;
};

/** 最多两行 —— DESIGN.md「禁止竖着排很多」。 */
export const MAX_IMAGE_ROWS = 2;

export type ImageGridLayout = {
  cols: number;
  /** 第一张横跨两格(只在单张时)。 */
  spanFirst: boolean;
  visible: number;
  /** 超出两行、收进最后一格「+N」的张数。 */
  overflow: number;
};

export function imageGridLayout(count: number): ImageGridLayout {
  if (count <= 0) return { cols: 0, spanFirst: false, visible: 0, overflow: 0 };
  // 单张横跨两格:放在一格里显得过小,而单张恰恰常是需要看清的报错截图。
  if (count === 1) return { cols: 2, spanFirst: true, visible: 1, overflow: 0 };
  // 2、4 张两列(方正);其余三列。后端单条上限 6 张,三列两行正好放下。
  const cols = count === 2 || count === 4 ? 2 : 3;
  const visible = Math.min(count, cols * MAX_IMAGE_ROWS);
  return { cols, spanFirst: false, visible, overflow: count - visible };
}

/** 从 AG-UI 消息的 content 里取出要画的图。 */
export function imagesFromContent(content: unknown): ChatImage[] {
  if (!Array.isArray(content)) return [];
  const out: ChatImage[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: unknown; source?: unknown; metadata?: unknown };
    if (p.type !== "image" || !p.source || typeof p.source !== "object") continue;
    const src = p.source as { type?: unknown; value?: unknown; mimeType?: unknown };
    const value = typeof src.value === "string" ? src.value : "";
    if (!value) continue;
    const meta = p.metadata && typeof p.metadata === "object" ? (p.metadata as Record<string, unknown>) : {};
    const filename = typeof meta.filename === "string" && meta.filename ? meta.filename : null;

    if (src.type === "url") {
      // 只画本机附件仓的地址。后端不收外部 URL;这里再挡一次,免得浏览器替一条
      // 异常消息去请求外部或内网地址。
      if (!value.startsWith("/api/blobs/")) continue;
      out.push({ src: value, filename, isDataSource: false });
    } else if (src.type === "data") {
      // CopilotKit 给的是**裸 base64**(readFileAsBase64 剥掉了 data: 前缀),要自己拼回去。
      const mime = typeof src.mimeType === "string" && src.mimeType ? src.mimeType : "image/png";
      out.push({ src: `data:${mime};base64,${value}`, filename, isDataSource: true });
    }
  }
  return out;
}
