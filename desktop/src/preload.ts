import { contextBridge, ipcRenderer } from "electron";

/**
 * 外壳暴露给页面的**全部**接口。
 *
 * 在这之前 `webPreferences` 是没有 preload 的,注释写着「外壳对页面无话可说,
 * 加 preload 就要决定暴露什么,在那之前保持零暴露面」。现在开了这个口,理由只有一个:
 * 浏览器里的 `<input type="file">` 拿不到真实路径(安全限制,绕不过),而这个应用有
 * 三处需要用户给出一个**绝对目录路径**(扫描根、RAG 语料、开源雷达的工作目录)。
 * 手打路径是这些地方共同的毛病。
 *
 * 所以这个面**故意只有一个方法、不接受任何参数**:弹系统的目录选择器,回一个路径或 null。
 * 页面不能借它读目录、不能指定起始位置、不能选文件。再加第二个方法之前请先想清楚 ——
 * 零暴露面已经破了,剩下能守的只有「暴露面尽可能小」。
 *
 * `sandbox: true` 下 preload 必须是 CJS,而且只拿得到 `electron` 的一小撮模块 ——
 * 见 desktop/build.mjs 里单独的那个 esbuild 目标(format: "cjs")。
 */
contextBridge.exposeInMainWorld("ai2nao", {
  /** 弹目录选择器。用户取消返回 null。 */
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("dialog:pickDirectory"),
});
