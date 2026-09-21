/**
 * 系统目录选择器。由 Electron 外壳通过 preload 注入(见 desktop/src/preload.ts),
 * 在普通浏览器里不存在 —— 浏览器的 `<input type="file">` 拿不到真实路径,那是安全限制,
 * 绕不过。所以调用点要用 `canPickDirectory()` 决定显不显示按钮,而不是点了才发现没有。
 *
 * 这个应用的形态是 Electron,浏览器直开 127.0.0.1 只是开发时的用法;那种情况下
 * 文本框仍然能手打路径,功能不缺,只是少一个方便按钮。
 */

type Ai2naoShell = {
  pickDirectory?: () => Promise<string | null>;
};

function shell(): Ai2naoShell | undefined {
  return (globalThis as { ai2nao?: Ai2naoShell }).ai2nao;
}

export function canPickDirectory(): boolean {
  return typeof shell()?.pickDirectory === "function";
}

/** 弹目录选择器;用户取消、或不在 Electron 里时返回 null。 */
export async function pickDirectory(): Promise<string | null> {
  const fn = shell()?.pickDirectory;
  if (!fn) return null;
  return fn();
}
