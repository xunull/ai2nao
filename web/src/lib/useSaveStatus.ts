import { useEffect, useRef, useState } from "react";

/**
 * 保存动作的四态。
 *
 * 设置页原来是**不对称**的:15 处保存全都有失败提示,一处成功提示都没有
 * (只有主题分类例外)。你改完一个数字按 Tab 走,什么都不会发生 —— 存没存上只能靠猜。
 *
 * 成功态自动消失而失败态不消失,是有意的:「已保存」是通知,看过就算;
 * 红字是要你处理的东西,不该自己溜走。
 */
export type SaveStatus = "idle" | "saving" | "saved" | "error";

/** 「已保存」停留多久。够看清,又不至于变成墙纸。 */
export const SAVED_HOLD_MS = 3000;

type MutationLike = {
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
};

/**
 * 把 react-query 的 mutation 状态映射成四态。
 *
 * 不能直接用 `isSuccess` 当「已保存」:它一旦为真就**一直**为真,直到下次 mutate。
 * 主题分类那处靠 `isSuccess && !dirty` 绕过去 —— 但那招只在「有明确 dirty 状态的
 * 显式表单」上成立。设置页有七处是 onBlur / 增删即存,存完输入框的值就等于服务端的值,
 * dirty 恒为 false,那行绿字会永远挂着。所以这里认的是**「从 pending 落下来」这个瞬间**,
 * 再由定时器收尾,两类保存都成立。
 */
export function useSaveStatus(m: MutationLike, holdMs: number = SAVED_HOLD_MS): SaveStatus {
  const [showSaved, setShowSaved] = useState(false);
  const wasPending = useRef(m.isPending);

  useEffect(() => {
    const justSettled = wasPending.current && !m.isPending;
    wasPending.current = m.isPending;
    if (!justSettled || !m.isSuccess) return;
    setShowSaved(true);
    // 卸载或下一次保存开始时清掉 —— 否则定时器会在已经不存在的组件上 setState。
    const timer = setTimeout(() => setShowSaved(false), holdMs);
    return () => clearTimeout(timer);
  }, [m.isPending, m.isSuccess, holdMs]);

  if (m.isPending) return "saving";
  if (m.isError) return "error";
  return showSaved ? "saved" : "idle";
}
