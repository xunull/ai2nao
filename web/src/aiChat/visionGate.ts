/**
 * 贴图入口的闸。**四态,不是布尔** —— 因为「不能」有两种,处置方式相反。
 *
 * 抽成纯函数而不是留在 JSX 里:要守的是这四条判定与它们的文案,不是 CopilotKit
 * 能不能在 jsdom 里渲染。整页渲染要拖起整个 CopilotKit,又重又脆,而且测出来的
 * 也不是这里的逻辑。
 *
 * 判据与后端 `views.ts` 的 `VisionUiState` 同源,这里只做呈现。
 */

export type VisionState = "yes" | "unknown" | "catalog-no" | "adapter-no";

export type VisionGate = {
  /** 贴图入口(拖放/粘贴/选文件)开不开。 */
  imagesEnabled: boolean;
  /** 状态条文案。null = 不显示条。 */
  notice: string | null;
  /** 显不显示「仍要发送」。**只有 `catalog-no` 有** —— 见下面的理由。 */
  canForce: boolean;
};

/**
 * @param vision 后端给的四态。**字段缺失按 `unknown`**(打包桌面版可能是旧后端);
 *               把「不知道」当成「不支持」会让旧后端一律不能贴图。
 * @param forced 用户点过「仍要发送」没有。
 */
export function visionGate(vision: VisionState | undefined, forced: boolean): VisionGate {
  switch (vision ?? "unknown") {
    case "yes":
      return { imagesEnabled: true, notice: null, canForce: false };

    case "adapter-no":
      // **没有后门。** 后门是给「目录可能过期、模型其实能用」留的;适配器发不出去
      // 是我们自己依赖的确定事实(如 @ai-sdk/deepseek 2.0.35 的 user content 是
      // 纯字符串,图无处可去,且只警告不抛错)。放行只会让用户为一张没送出去的图付钱。
      return {
        imagesEnabled: false,
        notice:
          "当前模型不能贴图：ai2nao 接入这家的方式发不出图片，发出去也会被丢掉而费用照扣。换一个能读图的模型再试。",
        canForce: false,
      };

    case "catalog-no":
      // 目录会过期,厂商可能刚上了新能力 —— 所以这一条留后门。
      return forced
        ? { imagesEnabled: true, notice: null, canForce: false }
        : {
            imagesEnabled: false,
            notice: "模型目录里这个模型不支持读图，贴图入口已关闭。",
            canForce: true,
          };

    default:
      // 目录没拉到 / 旧缓存 / 手填的模型。**可用 + 提示,不置灰** ——
      // 目录过期不该硬拦一个实际能用的模型。
      return {
        imagesEnabled: true,
        notice:
          "没查到这个模型的读图能力（目录未拉取或是手填的模型），贴图可用但不保证模型看得见。",
        canForce: false,
      };
  }
}
