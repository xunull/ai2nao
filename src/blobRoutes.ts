/**
 * `GET /api/blobs/:sha256` —— 内容寻址附件仓的唯一读出口。
 *
 * 放在这一层而不是 `llmChat/` 下:blob 仓有两个写入方(opencode 历史抽取与
 * `/ai-chat` 贴图),读出口不属于其中任何一个子系统。
 *
 * 三条约束,每条都有来由:
 *
 * **一、类型只从字节本身认。** `putBlob` 从不把 mime 落盘 —— 磁盘上是以 sha 为名、
 * 无扩展名的裸文件,mime 只活在引用里。所以这里既不能查库(引用埋在两张表的 JSON 里),
 * 也不能收查询参数(那等于让调用方任选同源端点的 Content-Type,是现成的 XSS 向量)。
 *
 * **二、白名单之外一律降为附件下载。** 尤其是 SVG:同源端点上按 `image/svg+xml`
 * 吐出去,直接打开那个 URL 就是同源脚本执行,而本仓所有 API 路由都无鉴权。
 *
 * **三、sha 形状校验在 `blobStore.blobPath` 里,不在这里。** 那是 `getBlob`/`hasBlob`
 * 共用的瓶颈;放在路由层的话,下一个调用方得自己记得再判一次。
 */
import type { Hono } from "hono";
import { getBlob, sniffImageMime } from "./blobStore.js";

/** 内容寻址 ⇒ 同一个 URL 的字节永不改变 ⇒ 可以放心让浏览器永久缓存。 */
const IMMUTABLE = "public, max-age=31536000, immutable";

export function registerBlobRoutes(app: Hono): void {
  app.get("/api/blobs/:sha256", (c) => {
    // 形状不合法与文件不存在都走这里 —— 对外不区分,免得变成一个探测器。
    const bytes = getBlob(c.req.param("sha256"));
    if (!bytes) return c.json({ error: "没有这个附件" }, 404);

    const mime = sniffImageMime(bytes);
    const body = new Uint8Array(bytes);

    if (!mime) {
      // 认不出的(含 SVG)不当图片渲染,当文件下载。
      return c.body(body, 200, {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment",
        "x-content-type-options": "nosniff",
        "cache-control": IMMUTABLE,
      });
    }

    return c.body(body, 200, {
      "content-type": mime,
      "x-content-type-options": "nosniff",
      "cache-control": IMMUTABLE,
    });
  });
}
