import { useCallback, useEffect, useState } from "react";
import { Toggle } from "./Toggle";

const STORAGE_KEY = "ai2nao.readingMode";

/**
 * localStorage 在隐私模式 / 禁用 cookie 的浏览器里读写都会抛。开关本身不能因此不可用,
 * 所以读写各自吞掉异常,退化成「本次会话内有效」的内存态。
 */
function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStored(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // 存不了就算了,不影响本次使用。
  }
}

/**
 * 阅读模式开关状态。**默认关** —— 不改变页面的第一眼行为,老用户不会突然发现内容少了。
 * 惰性初始化:localStorage 只在挂载时读一次。
 */
export function useReadingMode(): [boolean, () => void] {
  const [on, setOn] = useState<boolean>(() => readStored());
  const toggle = useCallback(() => {
    setOn((v) => {
      writeStored(!v);
      return !v;
    });
  }, []);
  return [on, toggle];
}

/**
 * 「只看对话」开关。打开后隐藏工具调用、工具结果、系统事件与纯注入消息,
 * 只留真人说的话、AI 写的正文,以及 AI 向你提的选择题。
 */
export function ReadingModeToggle({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <Toggle
      label="只看对话"
      title="隐藏工具调用与系统事件,只看真人和 AI 说的话"
      on={on}
      onToggle={onToggle}
    />
  );
}

/** 供测试与调用方复用,避免键名在两处各写一遍。 */
export const READING_MODE_STORAGE_KEY = STORAGE_KEY;

/** 挂载后同步一次外部改动(例如另一个标签页切了开关)。调用方按需使用。 */
export function useReadingModeStorageSync(setOn: (v: boolean) => void): void {
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setOn(e.newValue === "1");
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [setOn]);
}
