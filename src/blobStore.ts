import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * 按内容寻址的附件仓（`~/.ai2nao/blobs/<前两位>/<sha256>`）。
 *
 * 为什么需要它：opencode 的 user 消息把粘贴进去的图片以 `data:` URI 整个内联在
 * `part.data` 里 —— 真库实测 129 段共 53.2 MB（96 张 PNG、15 webp、15 jpeg），
 * 平均每张 422 KB，最大 3.6 MB。这些字节原样进了 `agent_user_messages.raw_payload_json`，
 * 让 1934 行 opencode 消息占掉 65.8 MB，而其中真正的正文只有 12 MB。
 *
 * 抽出来而不是删掉：那 129 张图是「我到底喂给 AI 看了什么」的唯一记录，
 * 删了就再也没有了。按 sha256 寻址天然去重（同一张截图粘两次只存一份）。
 *
 * **写入方现在有两个**：opencode 的历史抽取（`opencodeHistory/myMessages.ts`）与
 * `/ai-chat` 的贴图（`llmChat/sessions.ts`）。
 *
 * **不做孤儿回收 —— 对两个来源都是。** 理由不是「源侧会 vacuum」（那只解释了
 * opencode 那一半），而是：任何来源的附件都是「我到底喂给 AI 看了什么」的唯一记录，
 * 而 sha 去重意味着同一个 blob 可能同时被多个会话、以及 opencode 的
 * `agent_user_messages` 引用 —— 引用埋在两张表的 JSON 字段里，跨子系统的引用计数
 * 漏扫一处就是不可逆的数据丢失。几十 MB 的磁盘不值这个风险。
 * 体积由人来看、由人来清。
 *
 * **读取入口一律经 `blobPath` 校验 sha 形状。** 它是 `getBlob` / `hasBlob` 共用的
 * 瓶颈，校验放这里，未来每个调用方自动受保护 —— 不靠谁记得在路由层再判一次。
 */

/** 环境变量覆盖 —— 没有它的话测试会写进开发者真实的 `~/.ai2nao/blobs`。 */
export function blobStoreDir(): string {
  const override = (process.env.AI2NAO_BLOBS ?? "").trim();
  if (override) return resolve(override);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return home ? join(home, ".ai2nao", "blobs") : join(".ai2nao", "blobs");
}

export type BlobRef = {
  sha256: string;
  /** 解码后的字节数（不是 base64 的长度）。 */
  bytes: number;
  mime: string | null;
};

/** `data:<mime>;base64,<payload>` → 解出的字节与 mime。非 data: URI 返回 null。 */
export function parseDataUri(url: string): { bytes: Buffer; mime: string | null } | null {
  if (!url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const header = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  const isBase64 = header.endsWith(";base64");
  const mime = (isBase64 ? header.slice(0, -";base64".length) : header).trim() || null;
  try {
    const bytes = isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    // 空解码结果多半是坏 URI —— 当作不可抽取,让调用方留着原样。
    return bytes.length > 0 ? { bytes, mime } : null;
  } catch {
    return null;
  }
}

/** 小写十六进制 64 位，别的一律不认。 */
const SHA256_RE = /^[a-f0-9]{64}$/;

export function isValidSha256(value: string): boolean {
  return SHA256_RE.test(value);
}

/**
 * 路径拼接**兼**安全闸。形状不合法返回 null,调用方据此当「没有这个 blob」。
 *
 * 为什么必须校验:分片目录取的是 `sha256.slice(0, 2)`,传 `"../../../etc/passwd"`
 * 进来时它是 `".."`,`join` 拼出来就是一条真实的穿越路径。在 `getBlob` 有 HTTP
 * 出口之前这条路不可达,有了 `/api/blobs/:sha256` 就可达了。
 */
function blobPath(sha256: string): string | null {
  if (!isValidSha256(sha256)) return null;
  return join(blobStoreDir(), sha256.slice(0, 2), sha256);
}

/**
 * 写入并返回引用。已存在同 hash 的文件就直接返回（内容寻址 → 同内容同路径）。
 * 写失败返回 null —— 调用方据此保留原始内联数据，**绝不在没写成的情况下剥掉正文**。
 */
export function putBlob(bytes: Buffer, mime: string | null): BlobRef | null {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // digest("hex") 必然是合法形状,这里的 null 分支实际不可达 —— 但让它走
  // 与写失败相同的「返回 null」出口,调用方不需要为它单独写一条路径。
  const target = blobPath(sha256);
  if (!target) return null;
  try {
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { mode: 0o600 });
    }
    return { sha256, bytes: bytes.length, mime };
  } catch {
    return null;
  }
}

/** 读回。用于「按 hash 取得回」的验收与将来的详情页展示。 */
export function getBlob(sha256: string): Buffer | null {
  const p = blobPath(sha256);
  if (!p) return null;
  try {
    return existsSync(p) ? readFileSync(p) : null;
  } catch {
    return null;
  }
}

export function hasBlob(sha256: string): boolean {
  const p = blobPath(sha256);
  if (!p) return false;
  try {
    return existsSync(p) && statSync(p).size > 0;
  } catch {
    return false;
  }
}

/**
 * 按魔术字节判类型。**不信任任何声明的 mime** —— 落盘的是裸字节，没有扩展名，
 * mime 从来没跟着 blob 存下来（`putBlob` 只把它回给调用方）。
 *
 * 白名单之外一律返回 null，调用方据此降级为附件下载。SVG 故意不在白名单里：
 * 同源端点上按 `image/svg+xml` 吐出去，直接打开那个 URL 就是同源脚本执行。
 */
export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "image/webp";
  return null;
}

/**
 * 从文件头读出图片宽高(像素)。只认 `sniffImageMime` 白名单里的四种;读不出返回 null。
 *
 * 用途是估算图片的 token:厂商按像素计费,2026-09-19 实测 512×512 与 1600×1000 两张图,
 * DeepSeek V4 flash 约 184 / 962 token,MiniMax-M3 约 326 / 2054 —— 随面积线性增长,
 * 固定估值在大图上会少估数倍(一张 Retina 截图在 MiniMax 上约 6600 token)。
 * 只读头部几十个字节,不解码像素。
 */
export function imageDimensions(bytes: Buffer): { width: number; height: number } | null {
  const mime = sniffImageMime(bytes);
  const ok = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : null;
  if (mime === "image/png") {
    // 签名 8 字节 → IHDR 块:长度 4、类型 4,随后宽、高各 4 字节大端。
    return bytes.length >= 24 ? ok(bytes.readUInt32BE(16), bytes.readUInt32BE(20)) : null;
  }
  if (mime === "image/gif") return ok(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  if (mime === "image/jpeg") {
    // 逐段跳过,直到 SOF(C0–CF,除去 C4 / C8 / CC 这三个非帧头标记)。
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return ok(bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5));
      }
      at += 2 + bytes.readUInt16BE(at + 2);
    }
    return null;
  }
  if (mime === "image/webp" && bytes.length >= 30) {
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X") return ok(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3));
    if (chunk === "VP8 ") return ok(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
    if (chunk === "VP8L") {
      const b1 = bytes[22]!, b2 = bytes[23]!, b3 = bytes[24]!;
      return ok(1 + (((b1 & 0x3f) << 8) | bytes[21]!), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
    }
  }
  return null;
}
