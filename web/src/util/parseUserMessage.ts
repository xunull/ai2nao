/**
 * 把一条 user 消息的 raw 文本切成**有序段数组**。
 *
 * Claude Code 把斜杠 / `!` 命令的回显塞进 user 消息(全在 user role,实测),混着
 * 12 个控制标签(见 controlTags.ts)和真人正文。这里按标签把它拆成四种段,渲染层
 * 各自出样式,和真人文字视觉分开。
 *
 * 段归属:`command-name` / `command-args` / `command-message` 是一组语义事件(一条
 * 命令),聚成一个 command 段;遇到已占用的字段(第二个 command-name)则视为新命令、
 * 另起一段。
 *
 * 吞噬防护:标签匹配**非贪婪 + 同名闭合**(`<x>...</x>`),故 stdout 内部出现字面
 * `<command-name>` 不会被当控制结构(整块 stdout 被非贪婪一次吞掉,内部不递归解析)。
 * 未闭合 / 坏标签匹配不上 → 落进 text 段原样保留,不吃掉后续内容。
 */
import { CONTROL_TAG_NAMES } from "./controlTags";

export type UserSegment =
  | { kind: "command"; name?: string; args?: string; message?: string }
  | { kind: "stdout"; raw: string }
  | { kind: "caveat"; text: string }
  | { kind: "text"; text: string };

// 标签名 → 段类别。
type TagKind = "cmd-name" | "cmd-args" | "cmd-message" | "stdout" | "caveat";
const TAG_KIND: Record<string, TagKind> = {
  "command-name": "cmd-name",
  "bash-input": "cmd-name", // ! 命令的输入,当命令名展示
  "command-args": "cmd-args",
  "command-message": "cmd-message",
  "local-command-stdout": "stdout",
  "local-command-stderr": "stdout",
  "command-stdout": "stdout",
  "command-stderr": "stdout",
  "bash-stdout": "stdout",
  "bash-stderr": "stdout",
  "local-command-caveat": "caveat",
  "system-reminder": "caveat",
};

// 匹配任意已知标签:<name>...</name>,非贪婪、同名闭合(\1 反引用)。
// 名字表来自 controlTags.ts(前后端靠 drift 测试守一致)。
const TAG_RE = new RegExp(
  `<(${CONTROL_TAG_NAMES.join("|")})>([\\s\\S]*?)<\\/\\1>`,
  "g"
);

// command 段的三个字段;某字段已占用时说明是「下一条命令」→ flush 另起。
type PendingCommand = { name?: string; args?: string; message?: string };

function hasField(c: PendingCommand, k: TagKind): boolean {
  if (k === "cmd-name") return c.name !== undefined;
  if (k === "cmd-args") return c.args !== undefined;
  if (k === "cmd-message") return c.message !== undefined;
  return false;
}

export function parseUserMessage(raw: string): UserSegment[] {
  const segs: UserSegment[] = [];
  let pending: PendingCommand | null = null;

  const flushCommand = (): void => {
    if (pending) {
      segs.push({ kind: "command", ...pending });
      pending = null;
    }
  };

  // trim 后非空的 text 段才留;纯空白(命令字段之间的换行)丢弃、不打断 command 聚合。
  const pushText = (text: string): void => {
    if (text.trim() === "") return;
    flushCommand();
    segs.push({ kind: "text", text });
  };

  let last = 0;
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(raw)) !== null) {
    if (m.index > last) pushText(raw.slice(last, m.index));
    last = TAG_RE.lastIndex;

    const kind = TAG_KIND[m[1]];
    const inner = m[2];

    if (kind === "stdout") {
      flushCommand();
      segs.push({ kind: "stdout", raw: inner });
    } else if (kind === "caveat") {
      flushCommand();
      segs.push({ kind: "caveat", text: inner });
    } else {
      // 命令字段:字段已占用 → 是下一条命令,先 flush。
      if (pending && hasField(pending, kind)) flushCommand();
      if (!pending) pending = {};
      if (kind === "cmd-name") pending.name = inner;
      else if (kind === "cmd-args") pending.args = inner;
      else if (kind === "cmd-message") pending.message = inner;
    }
  }
  if (last < raw.length) pushText(raw.slice(last));
  flushCommand();

  return segs;
}

/** 这条 user 消息是否含任何注入回显(有则详情页给它上「查看原文」切换 + 结构化)。 */
export function hasCommandInjection(raw: string): boolean {
  TAG_RE.lastIndex = 0;
  return TAG_RE.test(raw);
}
