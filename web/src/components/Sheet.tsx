import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

type SheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 抽屉头部标题。 */
  title: ReactNode;
  children: ReactNode;
  /** 抽屉宽度的 Tailwind 类,默认 `w-[min(40rem,90vw)]`。 */
  widthClass?: string;
};

/**
 * 右侧滑出抽屉(Sheet)。基于 Radix Dialog —— 焦点捕捉、锁背景滚动、Esc、点遮罩关闭、
 * Portal 全由库负责;样式 100% 用 Tailwind 自控,跟仓库现有外观一致。
 *
 * 这是仓库唯一的可复用浮层底座(右侧 slide-over)。需要别的右抽屉直接复用,不要再手搓。
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  children,
  widthClass = "w-[min(40rem,90vw)]",
}: SheetProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[1px] data-[state=open]:animate-[sheetFade_150ms_ease-out]" />
        <Dialog.Content
          aria-describedby={undefined}
          className={`fixed inset-y-0 right-0 z-50 flex ${widthClass} flex-col border-l border-neutral-200 bg-white shadow-2xl outline-none data-[state=open]:animate-[sheetIn_200ms_ease-out] data-[state=closed]:animate-[sheetOut_150ms_ease-in]`}
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-200 px-5 py-3">
            <Dialog.Title className="min-w-0 truncate text-sm font-semibold text-neutral-900">
              {title}
            </Dialog.Title>
            <Dialog.Close
              aria-label="关闭"
              className="shrink-0 rounded-lg p-1.5 text-neutral-500 transition hover:bg-slate-100 hover:text-neutral-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
