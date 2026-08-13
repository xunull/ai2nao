import { useCallback, useState } from "react";
import { Toggle } from "./Toggle";

const STORAGE_KEY = "ai2nao.sortOrder";

export type SortOrder = "asc" | "desc";

/**
 * localStorage 在隐私模式 / 禁用 cookie 的浏览器里读写都会抛,所以各自吞掉异常,
 * 退化成「本次会话内有效」的内存态 —— 开关本身不能因此不可用。
 */
function readStored(): SortOrder {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "desc" ? "desc" : "asc";
  } catch {
    return "asc";
  }
}

function writeStored(order: SortOrder): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, order);
  } catch {
    // 存不了就算了,不影响本次使用。
  }
}

/**
 * 消息排序方向。**默认 asc**(最早在上),与页面一直以来的行为一致 ——
 * 老用户不会一打开发现内容顺序变了。
 *
 * 与「只看对话」各存各的键:两个开关正交,互不影响。
 */
export function useSortOrder(): [SortOrder, () => void] {
  const [order, setOrder] = useState<SortOrder>(() => readStored());
  const toggle = useCallback(() => {
    setOrder((cur) => {
      const next: SortOrder = cur === "desc" ? "asc" : "desc";
      writeStored(next);
      return next;
    });
  }, []);
  return [order, toggle];
}

/** 「最新在前」开关。打开后最新的消息排在最上面,往下滚是回到过去。 */
export function SortOrderToggle({
  order,
  onToggle,
}: {
  order: SortOrder;
  onToggle: () => void;
}) {
  return (
    <Toggle
      label="最新在前"
      title="把消息倒过来排:最新的在最上面,往下滚是回到更早的对话"
      on={order === "desc"}
      onToggle={onToggle}
    />
  );
}

/** 供测试与调用方复用,避免键名在两处各写一遍。 */
export const SORT_ORDER_STORAGE_KEY = STORAGE_KEY;
