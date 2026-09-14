// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatImageGrid } from "../web/src/aiChat/ChatImageGrid";
import { MAX_IMAGE_ROWS, imageGridLayout, imagesFromContent } from "../web/src/aiChat/imageGrid";

/**
 * 用户消息里的图气泡。CopilotKit 默认把图排成一行、每张最大 80×80 按原图比例缩 ——
 * 竖长截图被压成 32px 宽的细缝(2026-09-07 实测)。这组测试守设计评审定的规格。
 */

afterEach(() => cleanup());

const blob = (n: number) => `/api/blobs/${String(n).padStart(64, "a")}`;

describe("imageGridLayout", () => {
  it("单张横跨两格", () => {
    expect(imageGridLayout(1)).toEqual({ cols: 2, spanFirst: true, visible: 1, overflow: 0 });
  });

  it("2、4 张两列,3、5、6 张三列", () => {
    expect(imageGridLayout(2).cols).toBe(2);
    expect(imageGridLayout(4).cols).toBe(2);
    for (const n of [3, 5, 6]) expect(imageGridLayout(n).cols, String(n)).toBe(3);
  });

  it("★ 任何张数都不超过两行 —— DESIGN.md 禁止竖着排很多", () => {
    for (let n = 1; n <= 20; n += 1) {
      const l = imageGridLayout(n);
      const cells = l.visible + (l.spanFirst ? 1 : 0);
      expect(Math.ceil(cells / l.cols), String(n)).toBeLessThanOrEqual(MAX_IMAGE_ROWS);
      expect(l.visible + l.overflow, String(n)).toBe(n); // 一张都不凭空消失
    }
  });

  it("超出两行的收进 +N", () => {
    expect(imageGridLayout(7)).toMatchObject({ visible: 6, overflow: 1 });
  });

  it("0 张什么都不画", () => {
    expect(imageGridLayout(0).visible).toBe(0);
  });
});

describe("imagesFromContent", () => {
  it("url 源只认本机附件仓,外部地址直接丢掉", () => {
    const out = imagesFromContent([
      { type: "image", source: { type: "url", value: blob(1) } },
      { type: "image", source: { type: "url", value: "https://attacker.invalid/x.png" } },
    ]);
    expect(out.map((i) => i.src)).toEqual([blob(1)]);
  });

  it("★ data 源(刚发出、还没落库)拼成 data: URI —— CopilotKit 给的是裸 base64", () => {
    const [img] = imagesFromContent([
      { type: "image", source: { type: "data", value: "iVBORw0K", mimeType: "image/png" } },
    ]);
    expect(img!.src).toBe("data:image/png;base64,iVBORw0K");
    expect(img!.isDataSource).toBe(true);
  });

  it("文件名取自 metadata.filename;文本 part 与字符串 content 忽略", () => {
    expect(imagesFromContent("只是文字")).toEqual([]);
    const out = imagesFromContent([
      { type: "text", text: "看这个" },
      { type: "image", source: { type: "url", value: blob(2) }, metadata: { filename: "报错.png" } },
    ]);
    expect(out).toEqual([{ src: blob(2), filename: "报错.png", isDataSource: false }]);
  });
});

describe("ChatImageGrid", () => {
  const imgs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      src: blob(i + 1),
      filename: i === 0 ? "第一张.png" : null,
      isDataSource: false,
    }));

  it("★ 分数列而不是固定像素 —— 固定宽度在窄窗口会穿出气泡", () => {
    render(<ChatImageGrid images={imgs(3)} />);
    expect(screen.getByTestId("chat-image-grid").style.gridTemplateColumns).toBe(
      "repeat(3, minmax(0, 1fr))"
    );
  });

  it("★ 每格 4:3 裁切填满 —— 不再按原图比例把竖长截图压成细缝", () => {
    render(<ChatImageGrid images={imgs(2)} />);
    for (const img of screen.getAllByRole("img")) {
      expect(img).toHaveClass("object-cover");
      expect(img.parentElement).toHaveClass("aspect-[4/3]");
    }
  });

  it("alt 用文件名,没有文件名用中文兜底", () => {
    render(<ChatImageGrid images={imgs(2)} />);
    expect(screen.getByAltText("第一张.png")).toBeInTheDocument();
    expect(screen.getByAltText("用户贴的截图")).toBeInTheDocument();
  });

  it("点击在新标签打开原图", () => {
    render(<ChatImageGrid images={imgs(1)} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", blob(1));
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("★ 图加载失败显示中性的「图已不在」,不是红色报错", () => {
    render(<ChatImageGrid images={imgs(1)} />);
    fireEvent.error(screen.getByRole("img"));
    const ph = screen.getByText("图已不在");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(ph.parentElement?.className).not.toMatch(/red/);
  });

  it("7 张只画 6 格,最后一格盖 +1", () => {
    render(<ChatImageGrid images={imgs(7)} />);
    expect(screen.getAllByRole("img")).toHaveLength(6);
    expect(screen.getByText("+1")).toBeInTheDocument();
  });

  it("没有图时不渲染任何东西", () => {
    const { container } = render(<ChatImageGrid images={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
