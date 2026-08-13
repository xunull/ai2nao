/**
 * 受控开关。详情页标题栏上已经有三个形态完全一样的开关(只看对话 / 最新在前 /
 * 结构化内容默认展开),各写一份 Tailwind 类必然会漂,所以统一走这里。
 *
 * 纯受控:状态与持久化归调用方,本组件只管样式与无障碍属性。
 * `label` 同时作为可见文字与 aria-label —— 测试按名字定位开关时靠的就是它。
 */
export function Toggle({
  label,
  on,
  onToggle,
  title,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
  /** 鼠标悬停说明;不影响可访问名。 */
  title?: string;
}) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2 text-xs font-medium text-neutral-600">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        title={title}
        onClick={onToggle}
        className={[
          "relative inline-flex h-5 w-9 items-center rounded-full transition",
          on ? "bg-blue-500" : "bg-neutral-300",
        ].join(" ")}
      >
        <span
          className={[
            "inline-block h-4 w-4 transform rounded-full bg-white shadow transition",
            on ? "translate-x-4" : "translate-x-0.5",
          ].join(" ")}
        />
      </button>
    </label>
  );
}
