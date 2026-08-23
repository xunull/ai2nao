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
 * **不做孤儿回收。** 源侧 opencode.db 是 vendor 的可变状态库，随时会 vacuum；
 * blob 仓正是为了不受它影响而存在的，跟着它删就失去了意义。体积由
 * `blobStoreStats()` 报出来，超了由人来决定，而不是自动清。
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

function blobPath(sha256: string): string {
  return join(blobStoreDir(), sha256.slice(0, 2), sha256);
}

/**
 * 写入并返回引用。已存在同 hash 的文件就直接返回（内容寻址 → 同内容同路径）。
 * 写失败返回 null —— 调用方据此保留原始内联数据，**绝不在没写成的情况下剥掉正文**。
 */
export function putBlob(bytes: Buffer, mime: string | null): BlobRef | null {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const target = blobPath(sha256);
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
  try {
    return existsSync(p) ? readFileSync(p) : null;
  } catch {
    return null;
  }
}

export function hasBlob(sha256: string): boolean {
  const p = blobPath(sha256);
  try {
    return existsSync(p) && statSync(p).size > 0;
  } catch {
    return false;
  }
}
