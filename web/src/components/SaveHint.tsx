import type { SaveStatus } from "../lib/useSaveStatus";

/**
 * 一处保存的状态提示。渲染成 `<span>`,由调用方决定塞进哪儿 ——
 * 按钮下方是 `<p>` 包一层,数字输入那几行是直接追加在行尾。
 *
 * 行尾那个槽在设置页上本来就是「这一行的临时状态」的位置(错误红字一直在那儿),
 * 所以三种状态共用它:不会让行宽跳动,也就不会在窄窗口下顶出横向滚动条。
 */
export function SaveHint({
  status,
  errorText,
  note,
  savedLabel = "已保存",
  className = "",
}: {
  status: SaveStatus;
  /** 已经格式化好的错误文本。这里不做格式化 —— 各页自己的 shortErr 口径不一样。 */
  errorText?: string;
  /** 「已保存」后面那句话,给保存完**不会立刻生效**的设置用。 */
  note?: string;
  /** 清除动作传「已清除」。 */
  savedLabel?: string;
  className?: string;
}) {
  if (status === "idle") return null;
  if (status === "saving") {
    return <span className={`text-xs text-[var(--muted)] ${className}`}>保存中…</span>;
  }
  if (status === "error") {
    return errorText ? <span className={`text-xs text-red-600 ${className}`}>{errorText}</span> : null;
  }
  return (
    <span className={`text-xs text-emerald-700 ${className}`}>
      {savedLabel}
      {note ? ` · ${note}` : ""}
    </span>
  );
}
