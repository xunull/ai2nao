import { useEffect, useRef, useState } from "react";
import { useAgent, useCopilotKit } from "@copilotkit/react-core/v2";

/**
 * 编辑重发的横幅 —— **它自己就是编辑器**。
 *
 * 本来打算把原文填回 CopilotKit 底部那个输入框(复用它的贴图/快捷键/IME),
 * 但 `onEditMessage` 只发事件,CopilotKit 没有给外部设置输入框内容的入口。
 * 于是横幅自带一个文本域:原文在里面,改完按 Enter 或点发送。
 *
 * 发送走 `agent.addMessage` + `runAgent` —— 与普通发送同一条运行时路径,
 * 新消息挂在服务端刚移好的叶子下面,自然成为原提问的兄弟。
 *
 * **`threadId` 必须显式传**(与 `RegenerateRunner` 同一个理由):这个组件在
 * `<CopilotChat>` 外面,拿不到它内部那个 configuration provider 的 threadId 回退,
 * 不传就会拿到共享的 registry agent,发出去的那一轮落进一个凭空新建的会话。
 *
 * 必须放在 `<CopilotKit>` 内部才拿得到 agent。
 */
export function EditResendBar({
  sessionId,
  draft,
  onCancel,
  onSent,
}: {
  sessionId: string;
  draft: string;
  onCancel: () => void;
  onSent: () => void;
}) {
  const { agent } = useAgent({ agentId: "default", threadId: sessionId });
  const { copilotkit } = useCopilotKit();
  const [text, setText] = useState(draft);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // 每次进入编辑态都换一次原文,并把光标放到末尾 —— 多数编辑是在后面补一句。
  useEffect(() => {
    setText(draft);
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [draft]);

  async function send() {
    const content = text.trim();
    if (!content || !agent || busy) return;
    setBusy(true);
    try {
      agent.addMessage({ id: crypto.randomUUID(), role: "user", content });
      await copilotkit.runAgent({ agent });
      onSent();
    } catch {
      // 发不出去就留在编辑态,别把用户改了一半的字扔掉。
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shrink-0 border-b border-blue-200 bg-blue-50 px-4 py-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-blue-900">编辑上一条提问，发送后成为一个新分支</span>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded border border-blue-300 bg-white px-2 py-0.5 text-[11px] font-medium text-blue-800 hover:bg-blue-50"
        >
          取消
        </button>
      </div>
      <textarea
        ref={ref}
        data-testid="edit-resend-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter 发送、Shift+Enter 换行 —— 与下面那个输入框同一套手感。
          // IME 组字期间的 Enter 不能当发送(中文输入必踩)。
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
        rows={2}
        className="w-full resize-y rounded border border-blue-200 bg-white px-2 py-1.5 text-sm text-neutral-900 outline-none focus:border-blue-400"
      />
      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || text.trim() === ""}
          className="h-7 rounded-lg border border-blue-300 bg-white px-3 text-xs font-medium text-blue-800 hover:bg-blue-50 disabled:opacity-50"
        >
          {busy ? "发送中…" : "发送"}
        </button>
        <span className="text-[11px] text-blue-800/70">Enter 发送 · Shift+Enter 换行</span>
      </div>
    </div>
  );
}
