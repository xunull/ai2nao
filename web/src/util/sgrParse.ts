/**
 * SGR(终端样式码)残骸解析器。
 *
 * 背景(实测):Claude Code 写 jsonl 时把 ANSI 的 ESC 字节(0x1B)吞了,只留下
 * 字面 SGR 尾巴 `[1m` / `[22m`(真实会话 93 行含残骸、0 行含 ESC)。所以 anser /
 * strip-ansi 这类需要 ESC 前缀的库对这数据是 no-op —— 这里手写状态机,正则里 ESC
 * 可选(`\x1b?`),**同时吃无-ESC 残骸和将来真 ESC**。
 *
 * 只覆盖基础 SGR:reset / 加粗 / 斜体 / 下划线 / 8+16 前景色 / 8+16 背景色。
 * 未知码跳过且状态一致(不泄漏样式)。多参 `[1;31m` 逐个 apply;空参 `[m` == reset。
 *
 * 输出 span 数组(每段文本 + 当时激活的样式)。**只在命令输出段调用**(stdout/stderr/
 * bash-*),真人正文不走这里,避免误伤正文里碰巧像 SGR 的内容(矩阵记号、下标)。
 */
export type SgrSpan = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** 有限调色板色名(见 FG/BG),不放任意 rgb。 */
  fg?: string;
  bg?: string;
};

type SgrState = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  fg?: string;
  bg?: string;
};

// SGR 码 → 8/16 基础色名。前景 30-37 / 亮 90-97;背景 40-47 / 亮 100-107。
const FG: Record<number, string> = {
  30: "black", 31: "red", 32: "green", 33: "yellow",
  34: "blue", 35: "magenta", 36: "cyan", 37: "white",
  90: "bright-black", 91: "bright-red", 92: "bright-green", 93: "bright-yellow",
  94: "bright-blue", 95: "bright-magenta", 96: "bright-cyan", 97: "bright-white",
};
const BG: Record<number, string> = {
  40: "black", 41: "red", 42: "green", 43: "yellow",
  44: "blue", 45: "magenta", 46: "cyan", 47: "white",
  100: "bright-black", 101: "bright-red", 102: "bright-green", 103: "bright-yellow",
  104: "bright-blue", 105: "bright-magenta", 106: "bright-cyan", 107: "bright-white",
};

function freshState(): SgrState {
  return { bold: false, italic: false, underline: false, fg: undefined, bg: undefined };
}

// 对一个 SGR 序列(`[` 和 `m` 之间的内容,如 "1;31" 或 "")逐码更新状态。
function applyCodes(state: SgrState, params: string): void {
  // 空参 `[m` == `[0m` == reset。
  const codes = params === "" ? [0] : params.split(";").map((p) => Number(p || "0"));
  for (const code of codes) {
    if (Number.isNaN(code)) continue; // 畸形参数跳过,状态不变。
    if (code === 0) {
      Object.assign(state, freshState());
    } else if (code === 1) state.bold = true;
    else if (code === 22) state.bold = false;
    else if (code === 3) state.italic = true;
    else if (code === 23) state.italic = false;
    else if (code === 4) state.underline = true;
    else if (code === 24) state.underline = false;
    else if (code === 39) state.fg = undefined;
    else if (code === 49) state.bg = undefined;
    else if (FG[code]) state.fg = FG[code];
    else if (BG[code]) state.bg = BG[code];
    // 其余未知码:跳过,状态一致(不泄漏)。
  }
}

function spanFrom(text: string, s: SgrState): SgrSpan {
  const span: SgrSpan = { text };
  if (s.bold) span.bold = true;
  if (s.italic) span.italic = true;
  if (s.underline) span.underline = true;
  if (s.fg) span.fg = s.fg;
  if (s.bg) span.bg = s.bg;
  return span;
}

/**
 * 把带 SGR 残骸(或真 ESC ANSI)的文本解析成样式 span 数组。
 * 无任何 SGR 码时返回单个无样式 span(除非空串 → 空数组)。
 */
export function sgrParse(input: string): SgrSpan[] {
  const re = /\x1b?\[([0-9;]*)m/g;
  const spans: SgrSpan[] = [];
  const state = freshState();
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    // SGR 码之前的那段文本,带「当前」样式。
    if (m.index > last) {
      spans.push(spanFrom(input.slice(last, m.index), state));
    }
    applyCodes(state, m[1]);
    last = re.lastIndex;
  }
  if (last < input.length) {
    spans.push(spanFrom(input.slice(last), state));
  }
  return spans;
}
